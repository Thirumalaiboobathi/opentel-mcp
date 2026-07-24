/**
 * @module fingerprint/normalize/patterns
 *
 * The ordered list of regex → placeholder substitutions applied by
 * {@link import('./message.js').normalizeMessage} to strip high-cardinality
 * values (ids, timestamps, addresses, paths, ...) out of error messages
 * before they're hashed into a fingerprint.
 *
 * Order is load-bearing, not cosmetic: later patterns run against the
 * output of earlier ones, and several categories overlap syntactically
 * (an IPv4 octet is also a valid 1-3 digit NUM; a bare decimal digit run
 * is also a substring of a HEX run). Broad-but-structured patterns (UUID,
 * EMAIL, URL, addresses, timestamps, paths) must claim their matches
 * before the generic catch-alls (HEX, PORT, NUM) get a chance at the same
 * characters. See message.js for the full pipeline.
 */

/** @typedef {import('../types.d.ts').NormalizeStep} NormalizeStep */

/** @type {readonly NormalizeStep[]} */
export const NORMALIZE_STEPS = Object.freeze([
  // UUID (any version): 8-4-4-4-12 hex.
  {
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    replacement: '<UUID>',
  },

  // Email address.
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '<EMAIL>',
  },

  // URL: any scheme://..., stopping at whitespace or an enclosing quote/bracket.
  {
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g,
    replacement: '<URL>',
  },

  // IPv6, full and "::"-compressed forms. Deliberately excludes the rare
  // IPv4-mapped (::ffff:1.2.3.4) form — not worth the added complexity for
  // an error-message normalizer.
  {
    pattern:
      /\b(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))\b/g,
    replacement: '<IP>',
  },

  // IPv4 dotted-quad.
  {
    pattern:
      /\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b/g,
    replacement: '<IP>',
  },

  // ISO-8601 timestamp: date, time, optional fractional seconds, optional
  // "Z" or +hh:mm offset.
  {
    pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: '<TS>',
  },

  // Unix timestamp: 10 digits (seconds) or 13 digits (milliseconds).
  {
    pattern: /\b\d{10}\b|\b\d{13}\b/g,
    replacement: '<TS>',
  },

  // Filesystem path: POSIX (/a/b/c) or Windows (C:\a\b or C:/a/b), at
  // least one separator so a bare "/" or drive letter alone doesn't match.
  {
    pattern: /\/(?:[\w.-]+\/)+[\w.-]*|\b[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*[^\s\\/]*/g,
    replacement: '<PATH>',
  },

  // Long hex run (hashes, object ids, ...). Runs after every other
  // hex-shaped category above has already claimed its matches.
  {
    pattern: /\b[0-9a-fA-F]{8,}\b/g,
    replacement: '<HEX>',
  },

  // Port number following a colon, restricted to the registered/dynamic
  // range (1024-65535) so we don't swallow arbitrary "key:value" pairs.
  {
    pattern: /:(?:102[4-9]|10[3-9]\d|1[1-9]\d{2}|[2-9]\d{3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\b/g,
    replacement: ':<PORT>',
  },

  // Any remaining bare number of 3+ digits.
  {
    pattern: /\b\d{3,}\b/g,
    replacement: '<NUM>',
  },

  // Quoted opaque id: alphanumeric, 8-64 chars, containing at least one
  // letter and one digit (mixed) so it doesn't swallow plain quoted words.
  {
    pattern: /(["'])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,64}\1/g,
    replacement: '$1<ID>$1',
  },

  // Collapse any run of whitespace (spaces, tabs, newlines) to a single space.
  {
    pattern: /\s+/g,
    replacement: ' ',
  },
]);
