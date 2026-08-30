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

/** @type {Readonly<Record<'FINGERPRINT' | 'SIGNATURE' | 'CATEGORY' | 'ORIGIN' | 'ERROR_CLASS' | 'CHANNEL' | 'VALIDATION_PATHS', string>>} */
export const ATTRIBUTE_KEYS = Object.freeze({
  FINGERPRINT: 'mcp.failure.fingerprint',
  SIGNATURE: 'mcp.failure.signature',
  CATEGORY: 'mcp.failure.category',
  ORIGIN: 'mcp.failure.origin',
  /**
   * `result.inputs.errorClass` — `err.name` (or a non-Error throwable's
   * `.name`), e.g. `"TypeError"`, `"ZodError"`. Capped at 128 characters
   * by `computeFingerprint()` (`fingerprint/compose.js`'s
   * `MAX_ERROR_CLASS_LENGTH`) — length-bounded only, not pattern-scrubbed
   * the way `normalizedMessage` is: this is the application/library's own
   * error class name, whatever it set `.name` to, not free text this
   * library controls the shape of (docs/known-gaps.md entry 10).
   */
  ERROR_CLASS: 'mcp.failure.error_class',
  /**
   * ADR 007's channel dimension (`classifyFailureChannel()`,
   * `fingerprint/classify/channel.js`): 'execution' | 'protocol.not_found'
   * | 'protocol.input' | 'protocol.output' | 'protocol.other' | 'unknown'.
   * Deliberately a DIFFERENT attribute from ORIGIN above — ORIGIN already
   * carries FingerprintInputs' `origin` ('tool_error' | 'thrown' |
   * 'transport'), hashed into the fingerprint since v0.4.0. CHANNEL is
   * additive, set independently of computeFingerprint(), and never part
   * of the hash — see ADR 007's "Where the new dimension lives".
   */
  CHANNEL: 'mcp.failure.channel',
  /**
   * ADR 009's diagnostic attribute (`extractValidationPaths()`,
   * `fingerprint/classify/validation-paths.js`): one dot-joined path per
   * failing Zod issue found in the message (e.g. `["email"]` or
   * `["user.profile.age", "status"]`), best-effort and omitted entirely
   * when nothing parseable was found — never an empty array. Like
   * CHANNEL, additive and never part of the fingerprint hash: the path
   * text is already implicit in the hashed normalized message (see ADR
   * 009), so hashing it again would be redundant, not more correct.
   *
   * A path segment that isn't a schema-declared identifier (a
   * `z.record()`/map schema's runtime key, e.g. an email used as an
   * object key) is redacted to `<KEY>` rather than surfaced — see
   * `PATH_SEGMENT_RE`'s comment in validation-paths.js (docs/known-gaps.md
   * entry 10) for why a placeholder, not a dropped segment or a dropped
   * path.
   */
  VALIDATION_PATHS: 'mcp.failure.validation_paths',
});

/**
 * Attribute keys safe to attach to metric labels. Everything else in
 * {@link ATTRIBUTE_KEYS} is unbounded or medium-cardinality and must stay
 * span-only.
 *
 * CHANNEL is deliberately NOT included here yet: ADR 007 doesn't decide
 * metric-label safety for it one way or the other (it's silent on this
 * file entirely), and per the Phase 2 instructions this omission should
 * default to span-only rather than inventing a decision the ADR didn't
 * make. It's a small closed set (6 values) and would likely qualify on
 * cardinality grounds alone — revisit explicitly, in the ADR, before
 * adding it here.
 *
 * VALIDATION_PATHS is explicitly, permanently excluded — this one IS
 * decided, not merely deferred (ADR 009): field/path names are bounded
 * per tool but unbounded across every tool anyone ever registers, and
 * unbounded again across every deployment a shared metrics backend might
 * aggregate — the exact same reasoning that already keeps FINGERPRINT/
 * SIGNATURE/ERROR_CLASS off this list.
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
