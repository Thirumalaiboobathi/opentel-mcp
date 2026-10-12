/**
 * @module csp
 *
 * A strict Content-Security-Policy for the dashboard page (v0.3.0). The
 * page is one self-contained HTML file with its script and stylesheet
 * inlined (vite-plugin-singlefile), so instead of 'unsafe-inline' the
 * policy allows exactly those inline blocks by SHA-256 hash, computed from
 * the HTML actually being served. Anything injected later (a stray
 * <script>, an inline event handler) has no matching hash and won't run.
 */

import { createHash } from 'node:crypto';

/**
 * The text of each top-level inline `<script>` and `<style>` block, in
 * order. Scans tag by tag and skips over each block's body, so markup-like
 * text inside a script (React's own "<script>" string literals) is never
 * mistaken for a tag. External scripts (`src=`) are skipped.
 *
 * @param {string} html
 * @returns {{ scripts: string[], styles: string[] }}
 */
export function extractInlineBlocks(html) {
  const scripts = [];
  const styles = [];
  const open = /<(script|style)\b([^>]*)>/gi;
  let match;
  while ((match = open.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const bodyStart = open.lastIndex;
    const close = html.toLowerCase().indexOf(`</${tag}`, bodyStart);
    if (close === -1) break;
    const body = html.slice(bodyStart, close);
    if (tag === 'style') styles.push(body);
    else if (!/\bsrc\s*=/i.test(match[2])) scripts.push(body);
    open.lastIndex = close;
  }
  return { scripts, styles };
}

/** @param {string} text */
const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The CSP header value for `html`.
 *
 * - `script-src` / `style-src`: only the page's own inline blocks, by hash.
 * - `connect-src 'self'`: the dashboard's fetch() and EventSource calls.
 * - `img-src 'self' data:`: the inlined favicon/icons, if any.
 * - everything else `'none'`, including framing by other pages.
 *
 * @param {string} html
 * @returns {string}
 */
export function buildContentSecurityPolicy(html) {
  const { scripts, styles } = extractInlineBlocks(html);
  const scriptSrc = scripts.length > 0 ? scripts.map(sha256).join(' ') : "'none'";
  const styleSrc = styles.length > 0 ? styles.map(sha256).join(' ') : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
