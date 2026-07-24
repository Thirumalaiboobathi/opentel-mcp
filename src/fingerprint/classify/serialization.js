/**
 * @module fingerprint/classify/serialization
 *
 * Classifies (de)serialization failures: JSON parse errors (a
 * `SyntaxError` whose message references JSON) and the generic
 * "Unexpected token" wording V8 uses for JSON/parse errors more broadly.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const JSON_RE = /\bJSON\b/i;
const UNEXPECTED_TOKEN_RE = /\bunexpected token\b/i;

/** @type {Classifier} */
export default {
  name: 'serialization',
  match(err, _ctx) {
    const message = err?.message ?? '';
    const hasMessage = typeof message === 'string';

    if (err?.name === 'SyntaxError' && hasMessage && JSON_RE.test(message)) return 'serialization';

    if (hasMessage && UNEXPECTED_TOKEN_RE.test(message)) return 'serialization';

    return null;
  },
};
