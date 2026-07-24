/**
 * @module fingerprint/classify/timeout
 *
 * Classifies timeout failures: standard timeout/abort error names, Node.js
 * timeout error codes, and generic "timed out" / "timeout" wording.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_NAMES = new Set(['TimeoutError', 'AbortError']);
const KNOWN_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const MESSAGE_RE = /\btimed out\b|\btimeout\b/i;

/** @type {Classifier} */
export default {
  name: 'timeout',
  match(err, _ctx) {
    const name = err?.name;
    if (typeof name === 'string' && KNOWN_NAMES.has(name)) return 'timeout';

    const code = err?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return 'timeout';

    const message = err?.message ?? '';
    if (typeof message === 'string' && MESSAGE_RE.test(message)) return 'timeout';

    return null;
  },
};
