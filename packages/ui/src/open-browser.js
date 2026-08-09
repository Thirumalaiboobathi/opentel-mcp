/**
 * @module open-browser
 *
 * Opens the host OS's default browser to a URL — a thin wrapper over each
 * platform's own "open a thing" command, not an `open`/`opener` npm
 * dependency: this package's entire premise is a zero-infrastructure,
 * one-command install, and a one-purpose native-command wrapper doesn't
 * earn a dependency. Best-effort: a failure here (unsupported platform,
 * missing command) only logs, it never throws — failing to auto-open a
 * browser tab must never take down the dashboard server itself.
 */

import { spawn } from 'node:child_process';

/**
 * @param {string} url
 * @returns {void}
 */
export function openBrowser(url) {
  try {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', url]]
          : ['xdg-open', [url]];

    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch (err) {
    console.warn(`opentel-mcp-ui: could not auto-open a browser (${err?.message ?? err}). Open ${url} manually.`);
  }
}
