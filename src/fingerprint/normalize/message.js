/**
 * @module fingerprint/normalize/message
 *
 * Reduces a raw error message to a low-cardinality, hashable string by
 * truncating it and then stripping high-cardinality values (ids,
 * addresses, timestamps, paths, ...) via {@link NORMALIZE_STEPS}.
 */

import { NORMALIZE_STEPS } from './patterns.js';

const MAX_INPUT_LENGTH = 2048;

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
  let result = raw.slice(0, MAX_INPUT_LENGTH);
  for (const { pattern, replacement } of NORMALIZE_STEPS) {
    result = result.replace(pattern, replacement);
  }
  return result.trim();
}
