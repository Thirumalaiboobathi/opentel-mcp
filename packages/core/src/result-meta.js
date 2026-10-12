/**
 * @module result-meta
 * The one place core reaches into a tool result's `_meta` (the MCP spec's
 * extension point on every result).
 *
 * Shared by the cost extractor (`_meta.usage`, `_meta.model` —
 * src/cost/extractor.js) and staleness detection (the freshness key —
 * src/staleness.js, ADR 027). Reads exactly the key it's given and never
 * enumerates `_meta`, so a feature only ever sees the field it asked for.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `result._meta[key]`, or `undefined` when `result` or its `_meta` isn't a
 * plain object. Property access isn't guarded here (a throwing getter
 * propagates), so callers keep their own try/catch, as both callers
 * already do.
 *
 * @param {unknown} result
 * @param {string} key
 * @returns {unknown}
 */
export function readResultMetaField(result, key) {
  if (!isPlainObject(result)) return undefined;
  const meta = result._meta;
  return isPlainObject(meta) ? meta[key] : undefined;
}
