/**
 * @module fingerprint/classify/auth
 *
 * Classifies authn/authz failures: 401/403 status codes, known
 * auth-related error names, and generic "unauthorized" / "forbidden" /
 * "authenticat(e|ion)" wording.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_STATUSES = new Set([401, 403]);
const KNOWN_NAMES = new Set(['UnauthorizedError', 'ForbiddenError', 'AuthError']);
const MESSAGE_RE = /\bunauthorized\b|\bforbidden\b|\bauthenticat/i;

/** @type {Classifier} */
export default {
  name: 'auth',
  match(err, _ctx) {
    if (KNOWN_STATUSES.has(err?.status) || KNOWN_STATUSES.has(err?.statusCode)) return 'auth';

    const name = err?.name;
    if (typeof name === 'string' && KNOWN_NAMES.has(name)) return 'auth';

    const message = err?.message ?? '';
    if (typeof message === 'string' && MESSAGE_RE.test(message)) return 'auth';

    return null;
  },
};
