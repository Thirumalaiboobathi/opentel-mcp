// How verify-tarball.js runs npm without a shell parsing its arguments.
//
// On Windows npm is a .cmd shim, and Node will only run one through
// cmd.exe (shell: true, since the CVE-2024-27980 fix). cmd.exe then parses
// the arguments: a peer range like `>=0.8.0 <1.0.0` becomes an input
// redirect from a file named `1.0.0` ("The system cannot find the file
// specified"). Under `npm run`, npm_execpath points at npm's own JS entry
// point (npm-cli.js), so running that with this node needs no shell on any
// OS and every argument arrives exactly as written.

import { basename } from 'node:path';

/** Characters cmd.exe gives a meaning to in an unquoted argument. */
const CMD_METACHARACTERS = /[\s<>|&^"%!()]/;

/**
 * The executable, arguments and `shell` option for `npm <args>`.
 *
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, execPath?: string }} [context]
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
export function npmCommand(args, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const npmCli = env.npm_execpath;
  // Only npm's own CLI: under yarn or pnpm npm_execpath is their CLI instead.
  if (npmCli && /^npm-cli\.c?js$/.test(basename(npmCli))) {
    return { file: execPath, args: [npmCli, ...args], shell: false };
  }
  if (platform === 'win32') {
    // Not under `npm run`: the .cmd shim through cmd.exe. Refuse arguments
    // it would mangle, rather than run a different command than intended.
    const unsafe = args.filter((arg) => CMD_METACHARACTERS.test(arg));
    if (unsafe.length > 0) {
      throw new Error(
        `can't pass ${unsafe.map((a) => JSON.stringify(a)).join(', ')} to npm through cmd.exe safely; ` +
          'run this script with `npm run verify:tarball` instead.',
      );
    }
    return { file: 'npm', args, shell: true };
  }
  return { file: 'npm', args, shell: false };
}
