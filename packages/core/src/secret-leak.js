/**
 * @module secret-leak
 *
 * Opt-in detection of credential-shaped strings in tool OUTPUTS (ADR 030, v0.18.0). Reuses the detectors that
 * scrub error text (fingerprint/normalize/secrets.js), in-process, on the `text` items of a result. It reports
 * only that a secret-shaped string was returned: a boolean, a bounded list of secret TYPES, and a count. The
 * matched text, its position and its context are never kept, recorded or logged.
 *
 * A signal, not a guarantee: pattern-based detection misses formats and fires on look-alikes.
 */

import { diag } from '@opentelemetry/api';
import { detectSecretTypes, MAX_DETECTED_MATCHES } from './fingerprint/normalize/secrets.js';
import {
  ATTR_MCP_TOOL_SECRET_LEAK_DETECTED,
  ATTR_MCP_TOOL_SECRET_LEAK_TYPES,
  ATTR_MCP_TOOL_SECRET_LEAK_COUNT,
  ATTR_MCP_TOOL_SECRET_LEAK_SCAN_TRUNCATED,
} from './attributes.js';

export const DEFAULT_MAX_SCAN_BYTES = 65_536;
/**
 * Text is scanned in windows of this many characters (plus {@link CHUNK_OVERLAP}), so a pathological input can
 * only make each window quadratic, not the whole result: the URL-credential, JWT and provider-key patterns are
 * superlinear on adversarial text (measured: ~0.7-2 s on 64 KiB scanned in one piece).
 */
const CHUNK_SIZE = 4096;
/** Each window extends this far into the next one, so a secret straddling a boundary is still seen. */
const CHUNK_OVERLAP = 256;
/** Content items looked at per result, however many the tool returned. */
const MAX_CONTENT_ITEMS = 10_000;

/**
 * @typedef {object} SecretLeakConfig
 * @property {boolean} enabled
 * @property {number} maxScanBytes - Budget in JavaScript string length (UTF-16 code units), see ADR 030.
 */

/**
 * Resolves the `secretLeakDetection` option. Never throws; invalid values warn once and fall back.
 *
 * @param {unknown} partial
 * @returns {SecretLeakConfig}
 */
export function resolveSecretLeakConfig(partial) {
  const config = { enabled: false, maxScanBytes: DEFAULT_MAX_SCAN_BYTES };
  try {
    if (partial === undefined) return config;
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      diag.warn('opentel-mcp: secretLeakDetection must be an object like { enabled: true }; ignoring it. See ADR 030.');
      return config;
    }
    const { enabled, maxScanBytes } = /** @type {Record<string, unknown>} */ (partial);
    if (enabled !== undefined) {
      if (typeof enabled === 'boolean') config.enabled = enabled;
      else diag.warn('opentel-mcp: secretLeakDetection.enabled must be a boolean; secret leak detection stays off. See ADR 030.');
    }
    if (maxScanBytes !== undefined) {
      if (typeof maxScanBytes === 'number' && Number.isInteger(maxScanBytes) && maxScanBytes > 0) {
        config.maxScanBytes = maxScanBytes;
      } else {
        diag.warn(
          `opentel-mcp: secretLeakDetection.maxScanBytes must be a positive integer; using ${DEFAULT_MAX_SCAN_BYTES}. See ADR 030.`,
        );
      }
    }
  } catch {
    try {
      diag.warn('opentel-mcp: could not read the secretLeakDetection option; secret leak detection stays off. See ADR 030.');
    } catch {
      // never throw
    }
    return { enabled: false, maxScanBytes: DEFAULT_MAX_SCAN_BYTES };
  }
  return config;
}

/**
 * Scans the text items of a tool result, up to `maxScan` characters in total. Never throws.
 *
 * @param {unknown} result
 * @param {number} maxScan
 * @returns {{ types: Set<string>, count: number, truncated: boolean } | null} `null` when the result has no
 *   scannable text or could not be read.
 */
export function scanResultForSecrets(result, maxScan) {
  try {
    const content = /** @type {any} */ (result)?.content;
    if (!Array.isArray(content)) return null;
    const types = new Set();
    let count = 0;
    let truncated = false;
    let remaining = maxScan;
    const limit = Math.min(content.length, MAX_CONTENT_ITEMS);
    for (let i = 0; i < limit; i++) {
      const item = content[i];
      if (item === null || typeof item !== 'object' || item.type !== 'text') continue;
      const text = item.text;
      if (typeof text !== 'string' || text.length === 0) continue;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const take = text.length > remaining ? text.slice(0, remaining) : text;
      if (take.length < text.length) truncated = true;
      remaining -= take.length;
      for (let start = 0; start < take.length; start += CHUNK_SIZE) {
        const found = detectSecretTypes(take.slice(start, Math.min(take.length, start + CHUNK_SIZE + CHUNK_OVERLAP)));
        for (const t of found.types) types.add(t);
        count += found.count;
        if (count >= MAX_DETECTED_MATCHES) {
          count = MAX_DETECTED_MATCHES;
          return { types, count, truncated };
        }
      }
    }
    if (content.length > limit) truncated = true;
    return { types, count, truncated };
  } catch {
    return null;
  }
}

/**
 * Scans a result and, when something secret-shaped is found, sets the ADR 030 span attributes and counts the
 * leak. Never changes span status. Never throws.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {{ recordSecretLeak: (toolName: string | undefined) => void } | null | undefined} metricsRecorder
 * @param {string | undefined} toolName
 * @param {unknown} result
 * @param {SecretLeakConfig} config
 */
export function applySecretLeak(span, metricsRecorder, toolName, result, config) {
  try {
    if (!config?.enabled) return;
    const scan = scanResultForSecrets(result, config.maxScanBytes);
    if (scan === null) return;
    if (scan.types.size > 0) {
      span.setAttribute(ATTR_MCP_TOOL_SECRET_LEAK_DETECTED, true);
      span.setAttribute(ATTR_MCP_TOOL_SECRET_LEAK_TYPES, [...scan.types].sort());
      span.setAttribute(ATTR_MCP_TOOL_SECRET_LEAK_COUNT, scan.count);
      metricsRecorder?.recordSecretLeak(toolName);
    }
    if (scan.truncated) span.setAttribute(ATTR_MCP_TOOL_SECRET_LEAK_SCAN_TRUNCATED, true);
  } catch (err) {
    try {
      diag.debug('opentel-mcp: secret leak detection failed for this call; skipped.', err instanceof Error ? err.name : 'error');
    } catch {
      // never throw into the tool-call path
    }
  }
}
