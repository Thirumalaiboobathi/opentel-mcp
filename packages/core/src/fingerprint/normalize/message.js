/**
 * @module fingerprint/normalize/message
 *
 * Reduces a raw error message to a low-cardinality, hashable string by
 * truncating it and then stripping high-cardinality values (ids,
 * addresses, timestamps, paths, ...) via {@link NORMALIZE_STEPS}.
 */

import { NORMALIZE_STEPS } from './patterns.js';
import { scrubSecrets } from './secrets.js';

// Exported as of v0.14.0 (ADR 020, docs/adr/020-redactor-hook.md, Decision
// 5): errorRecording.redactor's own defensive output cap reuses this exact
// value rather than inventing a second magic number — see
// src/error-recording/redactor.js's MAX_REDACTOR_OUTPUT_LENGTH.
export const MAX_INPUT_LENGTH = 2048;

/**
 * Normalizes a raw error message for fingerprinting.
 *
 * Truncation happens before normalization (not after) so the pipeline
 * always runs against a bounded-size input, keeping the per-error cost
 * predictable regardless of how large the original message was.
 *
 * @param {string} raw
 * @returns {string} The normalized, trimmed message. Idempotent: calling
 *   this again on its own output returns the same string.
 */
export function normalizeMessage(raw) {
  // Credentials first (v0.17.0): a leaked token must neither reach the
  // span nor split one error into a fingerprint per token value.
  let result = scrubSecrets(raw.slice(0, MAX_INPUT_LENGTH));
  for (const { pattern, replacement } of NORMALIZE_STEPS) {
    result = result.replace(pattern, replacement);
  }
  return result.trim();
}
