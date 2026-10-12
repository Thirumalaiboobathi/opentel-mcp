/**
 * @module fingerprint/normalize/secrets
 *
 * Credential scrubbing for error text (v0.17.0). Runs FIRST in
 * normalizeMessage() (so fingerprints group by error shape rather than by
 * leaked token) and is also applied, on its own, to `errorRecording.mode:
 * 'full'` exception messages and stacks (instrument.js's
 * recordThrownException()), which otherwise keep their ids, paths and URLs.
 *
 * Every pattern targets a recognizable credential SHAPE: a known prefix
 * (AKIA, sk-, ghp_, xoxb-, eyJ…eyJ…), an auth scheme followed by a long
 * token, credentials embedded in a URL, or a value assigned to a key whose
 * name says it's a secret. Plain words, UUIDs, hashes and ordinary ids are
 * deliberately left alone. This is not a general-purpose PII filter.
 */

/** What every scrubbed value is replaced with. */
export const SECRET_PLACEHOLDER = '<SECRET>';

// Key names whose value is a secret. Matched case-insensitively, as a
// whole word (so `tokenizer=` or `secretary:` don't match).
const SECRET_KEY_NAMES =
  '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|x-api-key|api[_-]?key|apikey|' +
  'client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|' +
  'credentials?|signature|sig)';

/** @type {readonly { pattern: RegExp, replacement: string }[]} */
export const SECRET_STEPS = Object.freeze([
  // Credentials inside a URL: scheme://<user>:<password>@host -> scheme://<SECRET>@host.
  {
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/?#@"'<>:]+:[^\s/?#@"'<>]+@/g,
    replacement: `$1${SECRET_PLACEHOLDER}@`,
  },

  // JSON Web Token: three base64url segments, the first two JSON objects ("eyJ").
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: SECRET_PLACEHOLDER,
  },

  // HTTP auth schemes followed by a credential of at least 16 characters
  // ("Bearer token missing" has no such credential and is left alone).
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}=*/gi,
    replacement: `$1 ${SECRET_PLACEHOLDER}`,
  },

  // AWS access key ids.
  {
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replacement: SECRET_PLACEHOLDER,
  },

  // Provider-prefixed API keys: OpenAI/Anthropic (sk-, sk-proj-, sk-ant-),
  // Stripe (sk_live_/rk_test_…), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  // github_pat_), Slack (xoxa-/xoxb-/xoxp-/xoxr-/xoxs-), Google (AIza…).
  {
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/g,
    replacement: SECRET_PLACEHOLDER,
  },

  // A secret-named key in a query string or assignment: ?token=…, &api_key=…,
  // password=…, "client_secret": "…". `=` always counts; `:` only when the
  // value is quoted or contains a digit, so "token: expired" stays readable.
  {
    pattern: new RegExp(`\\b(${SECRET_KEY_NAMES})(=)(["']?)[^\\s&"',;)]+`, 'gi'),
    replacement: `$1$2$3${SECRET_PLACEHOLDER}`,
  },
  {
    pattern: new RegExp(`\\b(${SECRET_KEY_NAMES})(["']?\\s*:\\s*)(["'])[^"'\\n]+\\3`, 'gi'),
    replacement: `$1$2$3${SECRET_PLACEHOLDER}$3`,
  },
  {
    pattern: new RegExp(`\\b(${SECRET_KEY_NAMES})(\\s*:\\s*)(?=[^\\s,;]*\\d)[^\\s,;]{4,}`, 'gi'),
    replacement: `$1$2${SECRET_PLACEHOLDER}`,
  },
]);

/**
 * Replaces recognizable credentials in `text` with {@link SECRET_PLACEHOLDER}.
 * Leaves everything else exactly as it was. Never throws on a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  let result = text;
  for (const { pattern, replacement } of SECRET_STEPS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
