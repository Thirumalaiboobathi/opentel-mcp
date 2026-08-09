/**
 * @module spa-html
 *
 * Loads the built SPA bundle (`dist/index.html`, produced by `vite build`
 * — see `vite.config.ts`) to pass as `server.js`'s `spaHtml` option.
 * Falls back to `undefined` (letting `createServer()`'s own placeholder
 * take over) when `dist/` hasn't been built yet — this package's own
 * tests never build the frontend, so `withUI()`/tests must keep working
 * without it, not throw.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @returns {string | undefined}
 */
export function loadBuiltSpaHtml() {
  try {
    return readFileSync(join(packageRoot, 'dist/index.html'), 'utf8');
  } catch {
    return undefined;
  }
}
