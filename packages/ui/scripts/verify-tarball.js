#!/usr/bin/env node
// Release gate (ADR 022, docs/adr/022-publish-ui.md in the main repo):
// proves the *packed tarball* actually works from a clean install, not
// just that the repo's own workspace symlinks make it look like it does.
// Every manual test run against this package before today ran it via
// `node bin/opentel-mcp-ui.js` straight out of the repo, or via the
// workspace-symlinked `node_modules/opentel-mcp` -- neither exercises
// what `npm install opentel-mcp-ui` actually resolves for a real user.
//
// Steps: npm pack -> install the tarball, plus its two real peer
// dependencies (opentel-mcp, @opentelemetry/api), into a throwaway
// project OUTSIDE this repo/workspace (so npm resolves them from the
// registry, the same way a real consumer's install would, not via
// workspace symlinks) -> run the installed `bin/opentel-mcp-ui.js` --
// the exact file `npx opentel-mcp-ui` resolves to -- with `--demo` ->
// poll `/api/meta` over real HTTP until it answers -> assert the
// response shape and that `demo: true` came through. Cleans up its temp
// dirs and child process on both success and failure.
//
// Deliberately does NOT invoke `npx` itself here: in ad hoc testing,
// `npx --package=<tarball> opentel-mcp-ui` was flaky under background
// process supervision in at least one sandboxed CI-like environment,
// unrelated to this package (confirmed by extracting the same tarball
// and running its bin directly, which worked every time). Running the
// installed bin script directly exercises exactly the file npx would
// have resolved and executed -- the thing this gate actually needs to
// prove -- without depending on npx's own process-supervision behavior,
// which isn't this package's to test.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

// A fixed, high, unglamorous port rather than the real default (4319) --
// avoids colliding with a developer's own already-running dashboard
// without the added complexity of parsing an OS-assigned port (`--port=0`)
// back out of the child process.
const VERIFY_PORT = 18_319;

class StopWithFailure extends Error {}

function fail(message) {
  console.error(`\nverify-tarball: FAILED\n${message}\n`);
  process.exitCode = 1;
  throw new StopWithFailure();
}

// On Windows, npm/npx are .cmd shims, which Node refuses to execute
// without a shell (EINVAL since the CVE-2024-27980 fix). Elsewhere, no
// shell -- unchanged behavior.
const useShell = process.platform === 'win32';

function run(cmd, args, options) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: useShell, ...options });
}

/**
 * Polls `url` until it responds or `timeoutMs` elapses. A fixed sleep
 * before the first request would be guessing how long Node startup +
 * listen() takes; polling is the honest version of the same wait.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function pollUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error(`${url} never came up within ${timeoutMs}ms`);
}

async function main() {
  const packDir = mkdtempSync(join(tmpdir(), 'opentel-mcp-ui-pack-'));
  const consumerDir = mkdtempSync(join(tmpdir(), 'opentel-mcp-ui-consumer-'));
  let child;

  try {
    console.log('verify-tarball: npm pack...');
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: rootDir });
    const [{ filename }] = JSON.parse(packOutput);
    const tarballPath = join(packDir, filename);

    console.log('verify-tarball: installing the packed tarball + real peer deps into a clean project...');
    run('npm', ['init', '-y'], { cwd: consumerDir });
    const peerSpecs = Object.entries(pkg.peerDependencies ?? {}).map(([name, range]) => `${name}@${range}`);
    try {
      run('npm', ['install', tarballPath, ...peerSpecs], { cwd: consumerDir });
    } catch (error) {
      fail(`npm install of the packed tarball + peer deps failed:\n\n${error.stdout || error.stderr || error.message}`);
    }

    // Through node_modules/.bin -- a symlink to bin/opentel-mcp-ui.js, same
    // as `npx opentel-mcp-ui` resolves and executes. Running the target
    // file directly (`node .../bin/opentel-mcp-ui.js`) would miss exactly
    // the bug this gate exists to catch: the CLI's own main-module guard
    // comparing against the invoked (symlink) path instead of the
    // symlink's realpath, which makes it exit silently when invoked this
    // way -- see bin/opentel-mcp-ui.js's guard for the fix.
    const [binName] = Object.keys(pkg.bin ?? {});
    // On Windows npm writes a .cmd shim here instead of a symlink -- the
    // same entry point npx resolves on that platform.
    const binPath = join(consumerDir, 'node_modules', '.bin', useShell ? `${binName}.cmd` : binName);
    console.log(`verify-tarball: starting the installed bin via node_modules/.bin --demo --port=${VERIFY_PORT}...`);

    child = spawn(binPath, ['--demo', `--port=${VERIFY_PORT}`], {
      cwd: consumerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    const earlyExit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    console.log('verify-tarball: polling /api/meta...');
    const metaUrl = `http://127.0.0.1:${VERIFY_PORT}/api/meta`;
    let res;
    try {
      res = await Promise.race([
        pollUntilUp(metaUrl, 15_000),
        earlyExit.then((code) => {
          throw new Error(`child process exited early with code ${code} before /api/meta came up:\n${output}`);
        }),
      ]);
    } catch (error) {
      fail(error.message);
    }

    if (res.status !== 200) {
      fail(`GET /api/meta returned ${res.status}, expected 200. Process output:\n${output}`);
    }

    const body = await res.json();
    if (body.demo !== true) {
      fail(`/api/meta reported demo: ${body.demo}, expected true for a --demo run. Full body:\n${JSON.stringify(body)}`);
    }
    if (!body.detectors || !body.detectors.thrashDetection) {
      fail(`/api/meta response is missing the expected detectors shape. Full body:\n${JSON.stringify(body)}`);
    }

    const rootRes = await fetch(`http://127.0.0.1:${VERIFY_PORT}/`);
    const rootBody = await rootRes.text();
    if (rootRes.status !== 200 || rootBody.length < 1000) {
      fail(
        `GET / returned status ${rootRes.status} and ${rootBody.length} bytes -- expected a 200 serving the ` +
          `built SPA (hundreds of KB). Is dist/index.html built? Run "npm run build" first.`,
      );
    }

    console.log('\nverify-tarball: PASSED -- packed tarball installs cleanly and serves a working demo dashboard.\n');
  } catch (error) {
    if (!(error instanceof StopWithFailure)) {
      console.error('\nverify-tarball: FAILED (unexpected error)\n');
      console.error(error);
      process.exitCode = 1;
    }
  } finally {
    if (child && !child.killed) child.kill();
    rmSync(packDir, { recursive: true, force: true });
    rmSync(consumerDir, { recursive: true, force: true });
  }
}

main();
