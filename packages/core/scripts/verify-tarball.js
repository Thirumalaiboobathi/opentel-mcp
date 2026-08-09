#!/usr/bin/env node
// Release gate: proves the *packed tarball* is actually consumable by a
// strict-mode TypeScript project, not just that the repo's own tsconfig is
// happy. `npm run typecheck` resolves `src/**/*.d.ts` directly against the
// repo tree — it can't catch a public export whose `.js` module has no
// matching `.d.ts`, because nothing forces module resolution through the
// tarball's `files` allowlist and package.json `exports`. That gap shipped
// v0.6.0 with a TS7016 error on `import { computeFingerprint } from
// 'opentel-mcp'` for any strict consumer; this script exists so that class
// of bug fails CI/publish instead of a consumer's build.
//
// Steps: npm pack -> install the tarball into a throwaway project outside
// this repo -> import every value and type export from src/index.d.ts
// (parsed from the file, not hardcoded, so new exports are covered
// automatically) -> `tsc --noEmit --strict` -> import the package at
// runtime (dynamic `import()`, since this package is ESM-only — `require()`
// would just fail with ERR_REQUIRE_ESM regardless of whether the package is
// healthy) to confirm every named value export actually resolves. Cleans up
// its temp dirs on both success and failure; exits non-zero with a clear
// message on any failure.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

/**
 * Parses `src/index.d.ts` for every top-level `export`, split into value
 * exports (importable at runtime) and type-only exports. Intentionally a
 * plain-text parser rather than a TS AST walk — this project has no
 * TypeScript build step / no `typescript` dependency required at runtime,
 * and the file's export shapes are consistently one of a handful of
 * patterns (see the regexes below).
 *
 * @param {string} src
 * @returns {{ values: string[], types: string[] }}
 */
function parseIndexExports(src) {
  const values = new Set();
  const types = new Set();

  // `export { a, b } from '...'` and `export type { a, b } from '...'`,
  // single- or multi-line.
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"];/g)) {
    const bucket = m[1] ? types : values;
    for (const rawName of m[2].split(',')) {
      const name = rawName.trim();
      if (name) bucket.add(name);
    }
  }

  // Locally declared exports (not re-exported from a sibling file).
  for (const m of src.matchAll(/export\s+interface\s+(\w+)/g)) types.add(m[1]);
  for (const m of src.matchAll(/export\s+type\s+(\w+)(?=[\s<=])/g)) types.add(m[1]);
  for (const m of src.matchAll(/export\s+function\s+(\w+)/g)) values.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+(\w+)/g)) values.add(m[1]);
  for (const m of src.matchAll(/export\s+class\s+(\w+)/g)) values.add(m[1]);

  return { values: [...values], types: [...types] };
}

function fail(message) {
  console.error(`\nverify-tarball: FAILED\n${message}\n`);
  process.exitCode = 1;
  throw new StopWithFailure();
}

class StopWithFailure extends Error {}

function run(cmd, args, options) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

async function main() {
  const indexDtsPath = join(rootDir, 'src/index.d.ts');
  const { values, types } = parseIndexExports(readFileSync(indexDtsPath, 'utf8'));

  if (values.length === 0 && types.length === 0) {
    fail(`Parsed zero exports from ${indexDtsPath} — the parser is broken or the file moved.`);
  }

  console.log(
    `verify-tarball: found ${values.length} value export(s) and ${types.length} type export(s) in src/index.d.ts`,
  );
  console.log(`  values: ${values.join(', ')}`);
  console.log(`  types:  ${types.join(', ')}`);

  const packDir = mkdtempSync(join(tmpdir(), 'opentel-mcp-pack-'));
  const consumerDir = mkdtempSync(join(tmpdir(), 'opentel-mcp-consumer-'));

  try {
    console.log('\nverify-tarball: npm pack...');
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: rootDir });
    const [{ filename }] = JSON.parse(packOutput);
    const tarballPath = join(packDir, filename);

    console.log('verify-tarball: installing the packed tarball into a clean project...');
    run('npm', ['init', '-y'], { cwd: consumerDir });
    run('npm', ['install', tarballPath], { cwd: consumerDir });
    run('npm', ['install', '-D', 'typescript'], { cwd: consumerDir });

    const checkTsLines = [];
    if (values.length > 0) checkTsLines.push(`import { ${values.join(', ')} } from '${pkg.name}';`);
    if (types.length > 0) checkTsLines.push(`import type { ${types.join(', ')} } from '${pkg.name}';`);
    checkTsLines.push('');
    for (const name of values) checkTsLines.push(`void ${name};`);
    checkTsLines.push('');
    // Referencing each type in a type position forces TS to resolve it —
    // this is what actually reproduces TS7016 for a re-exported type whose
    // backing module has no declaration file.
    types.forEach((name, i) => checkTsLines.push(`type __Assert${i} = ${name};`));

    writeFileSync(join(consumerDir, 'check.ts'), checkTsLines.join('\n') + '\n', 'utf8');

    console.log('verify-tarball: tsc --noEmit --strict (nodenext) against the packed tarball...');
    try {
      run(
        'npx',
        ['tsc', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'check.ts'],
        { cwd: consumerDir },
      );
    } catch (error) {
      fail(
        'TypeScript failed to consume the packed tarball in strict mode. A public export in ' +
          `src/index.d.ts is re-exported from a .js file with no matching .d.ts (the TS7016 bug class), ` +
          `or another type error was introduced. tsc output:\n\n${error.stdout || error.stderr || error.message}`,
      );
    }

    console.log('verify-tarball: importing the package at runtime to confirm it actually loads...');
    const runtimeCheckLines = [
      values.length > 0
        ? `import { ${values.join(', ')} } from '${pkg.name}';`
        : `import '${pkg.name}';`,
      `const exported = { ${values.join(', ')} };`,
      'const missing = Object.entries(exported).filter(([, v]) => v === undefined).map(([k]) => k);',
      'if (missing.length > 0) {',
      '  console.error("Export(s) resolved to undefined at runtime: " + missing.join(", "));',
      '  process.exit(1);',
      '}',
      `console.log('runtime import OK — ${values.length} value export(s) present and defined');`,
    ];
    writeFileSync(join(consumerDir, 'check-runtime.mjs'), runtimeCheckLines.join('\n') + '\n', 'utf8');

    try {
      const out = run('node', ['check-runtime.mjs'], { cwd: consumerDir });
      console.log(out.trim());
    } catch (error) {
      fail(
        `The package failed to load at runtime from the packed tarball:\n\n${error.stdout || error.stderr || error.message}`,
      );
    }

    console.log('\nverify-tarball: PASSED — packed tarball type-checks under --strict and loads at runtime.\n');
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(consumerDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (!(error instanceof StopWithFailure)) {
    console.error('\nverify-tarball: FAILED (unexpected error)\n');
    console.error(error);
    process.exitCode = 1;
  }
});
