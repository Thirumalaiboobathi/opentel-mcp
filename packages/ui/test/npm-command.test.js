import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCommand } from '../scripts/npm-command.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const peerSpecs = Object.entries(pkg.peerDependencies ?? {}).map(([name, range]) => `${name}@${range}`);
const RANGE = 'opentel-mcp@>=0.8.0 <1.0.0';

describe('verify-tarball npm invocation', () => {
  let dir;
  let fakeNpmCli;

  beforeAll(() => {
    // Stands in for npm-cli.js: prints the arguments it actually received.
    dir = mkdtempSync(join(tmpdir(), 'npm-command-test-'));
    fakeNpmCli = join(dir, 'npm-cli.js');
    writeFileSync(fakeNpmCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the real peer ranges contain < and >, so this matters', () => {
    expect(peerSpecs.some((spec) => /[<>]/.test(spec))).toBe(true);
  });

  it('under npm run, runs npm-cli.js with node and no shell, on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const command = npmCommand(['install', RANGE], {
        env: { npm_execpath: '/x/npm/bin/npm-cli.js' },
        platform,
        execPath: '/x/node',
      });
      expect(command).toEqual({ file: '/x/node', args: ['/x/npm/bin/npm-cli.js', 'install', RANGE], shell: false });
    }
  });

  it('a peer range with < and > reaches npm intact (real child process)', () => {
    const args = ['install', join(dir, 'pkg 1.tgz'), ...peerSpecs, RANGE, 'a"b', '100%'];
    const command = npmCommand(args, { env: { npm_execpath: fakeNpmCli } });
    const received = JSON.parse(
      execFileSync(command.file, command.args, { encoding: 'utf8', shell: command.shell }),
    );
    expect(received).toEqual(args);
  });

  it("ignores yarn's or pnpm's npm_execpath", () => {
    const command = npmCommand(['pack'], { env: { npm_execpath: '/x/yarn.js' }, platform: 'linux' });
    expect(command).toEqual({ file: 'npm', args: ['pack'], shell: false });
  });

  it('without npm_execpath on Windows, refuses arguments cmd.exe would mangle', () => {
    expect(() => npmCommand(['install', RANGE], { env: {}, platform: 'win32' })).toThrow(/cmd\.exe/);
    expect(npmCommand(['init', '-y'], { env: {}, platform: 'win32' })).toEqual({
      file: 'npm',
      args: ['init', '-y'],
      shell: true,
    });
  });
});
