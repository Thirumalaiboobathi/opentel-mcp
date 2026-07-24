/**
 * @module fingerprint/hash
 *
 * Fingerprint hashing: SHA-256, truncated to the first 16 hex characters
 * (64 bits).
 *
 * Why this choice:
 * - We need identity, not security. 64 bits gives ~1-in-4-billion collision
 *   odds at 100k unique fingerprints (birthday bound) — enough for grouping
 *   errors, not for anything security-sensitive.
 * - SHA-256 is native in Node's `crypto` module, C-implemented, and takes
 *   roughly a couple of microseconds for inputs this small — well inside
 *   the p99 < 200µs budget for the whole fingerprinting pipeline.
 * - Truncation is safe for identity use per NIST SP 800-107.
 * - We rejected xxhash and murmurhash — both would add a runtime
 *   dependency, which this feature (and this package as a whole) avoids.
 * - We rejected SHA-1 despite being marginally faster: no measurable perf
 *   difference at this input size, and SHA-256 avoids the "why SHA-1 in
 *   2026" question in code review.
 */

import { createHash } from 'node:crypto';

const TRUNCATED_HEX_LENGTH = 16;

/**
 * Hashes the canonical, versioned fingerprint input string into a stable
 * 16-hex-character identity.
 *
 * Callers are responsible for building the input string in the canonical
 * `v1|...` shape (see compose.js) — this function performs no formatting,
 * just hash + truncate, so it stays trivially pure and testable on its own.
 *
 * @param {string} input
 * @returns {string} 16 lowercase hex characters, e.g. `"a3f4c8e2b1d09f77"`.
 */
export function hashInputs(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, TRUNCATED_HEX_LENGTH);
}
