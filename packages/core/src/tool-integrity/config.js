/**
 * @module tool-integrity/config
 *
 * Resolves the `toolIntegrity` option (ADR 029). Never throws; invalid input warns once and degrades.
 */

import { diag } from '@opentelemetry/api';
import { TOOL_HASH_PATTERN } from './hash.js';

/** At most this many pins are used. */
export const MAX_PINS = 1000;
/** At most this many distinct tools are tracked per server; further tools are ignored. */
export const MAX_TRACKED_TOOLS = 1000;

/**
 * @typedef {object} ToolIntegrityConfig
 * @property {boolean} enabled
 * @property {Map<string, string>} pins - tool name -> expected `sha256:` hash.
 */

/**
 * @param {unknown} partial
 * @returns {ToolIntegrityConfig}
 */
export function resolveToolIntegrityConfig(partial) {
  const config = { enabled: false, pins: new Map() };
  try {
    if (partial === undefined) return config;
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      diag.warn('opentel-mcp: toolIntegrity must be an object like { enabled: true }; ignoring it. See ADR 029.');
      return config;
    }
    const { enabled, pins } = /** @type {Record<string, unknown>} */ (partial);
    if (enabled !== undefined) {
      if (typeof enabled === 'boolean') config.enabled = enabled;
      else diag.warn('opentel-mcp: toolIntegrity.enabled must be a boolean; tool integrity stays off. See ADR 029.');
    }
    if (pins !== undefined) {
      if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
        diag.warn('opentel-mcp: toolIntegrity.pins must be an object of tool name -> "sha256:<64 hex>"; ignoring it. See ADR 029.');
      } else {
        let skipped = 0;
        const names = Object.keys(pins);
        if (names.length > MAX_PINS) skipped += names.length - MAX_PINS;
        for (const name of names.slice(0, MAX_PINS)) {
          const hash = /** @type {Record<string, unknown>} */ (pins)[name];
          if (typeof hash === 'string' && TOOL_HASH_PATTERN.test(hash)) config.pins.set(name, hash);
          else skipped++;
        }
        if (skipped > 0) {
          diag.warn(
            `opentel-mcp: toolIntegrity.pins: ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} skipped (each value must ` +
              `match sha256:<64 lowercase hex>, and at most ${MAX_PINS} pins are used). See ADR 029.`,
          );
        }
      }
    }
  } catch {
    try {
      diag.warn('opentel-mcp: could not read the toolIntegrity option; tool integrity stays off. See ADR 029.');
    } catch {
      // never throw
    }
    return { enabled: false, pins: new Map() };
  }
  return config;
}
