/**
 * @module fingerprint/classify/network
 *
 * Classifies network failures: Node.js network error codes, node-fetch's
 * FetchError, and generic "fetch failed" / "network ... error" wording.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
]);
const MESSAGE_RE = /\bfetch failed\b|\bnetwork\b.*\berror\b/i;

/** @type {Classifier} */
export default {
  name: 'network',
  match(err, _ctx) {
    const code = err?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return 'network';

    if (err?.name === 'FetchError') return 'network';

    const message = err?.message ?? '';
    if (typeof message === 'string' && MESSAGE_RE.test(message)) return 'network';

    return null;
  },
};
