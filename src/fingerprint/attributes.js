/**
 * @module fingerprint/attributes
 *
 * Maps a {@link FingerprintResult} onto OpenTelemetry span attributes, and
 * draws the line between what's safe to also attach to metric labels.
 *
 * Spans can carry high-cardinality attributes fine — each span is its own
 * record. Metric labels can't: every distinct label combination becomes a
 * separate time series, so `fingerprint` and `signature` (unbounded) and
 * `error_class` (medium, still risky) are span-only. `category` and
 * `origin` are small closed enums (8 categories x 3 origins = 24 max
 * combinations), so they're the only two safe to use as metric labels.
 */

/** @typedef {import('@opentelemetry/api').Attributes} Attributes */
/** @typedef {import('./types.d.ts').FingerprintResult} FingerprintResult */

/** @type {Readonly<Record<'FINGERPRINT' | 'SIGNATURE' | 'CATEGORY' | 'ORIGIN' | 'ERROR_CLASS', string>>} */
export const ATTRIBUTE_KEYS = Object.freeze({
  FINGERPRINT: 'mcp.failure.fingerprint',
  SIGNATURE: 'mcp.failure.signature',
  CATEGORY: 'mcp.failure.category',
  ORIGIN: 'mcp.failure.origin',
  ERROR_CLASS: 'mcp.failure.error_class',
});

/**
 * Attribute keys safe to attach to metric labels. Everything else in
 * {@link ATTRIBUTE_KEYS} is unbounded or medium-cardinality and must stay
 * span-only.
 *
 * @type {readonly string[]}
 */
export const METRIC_SAFE_ATTRIBUTES = Object.freeze([ATTRIBUTE_KEYS.CATEGORY, ATTRIBUTE_KEYS.ORIGIN]);

/**
 * Builds the span attributes for a fingerprinted failure.
 *
 * @param {FingerprintResult} result
 * @returns {Attributes} Empty object if `result` is malformed in any way —
 *   this must never throw, since it runs inline in the instrumentation
 *   hot path.
 */
export function toSpanAttributes(result) {
  try {
    return {
      [ATTRIBUTE_KEYS.FINGERPRINT]: result.fingerprint,
      [ATTRIBUTE_KEYS.SIGNATURE]: result.signature,
      [ATTRIBUTE_KEYS.CATEGORY]: result.category,
      [ATTRIBUTE_KEYS.ORIGIN]: result.origin,
      [ATTRIBUTE_KEYS.ERROR_CLASS]: result.inputs.errorClass,
    };
  } catch {
    return {};
  }
}
