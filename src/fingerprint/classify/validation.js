/**
 * @module fingerprint/classify/validation
 *
 * Classifies input-validation failures: known schema-validation library
 * error names/constructors, and generic "invalid / must be / required"
 * wording as a fallback for hand-rolled validation errors.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_NAMES = new Set(['ZodError', 'ValidationError', 'JoiError', 'YupError']);
const MESSAGE_RE = /\binvalid\b|\bmust be\b|\brequired\b/i;

/** @type {Classifier} */
export default {
  name: 'validation',
  match(err, _ctx) {
    const name = err?.name;
    if (typeof name === 'string' && KNOWN_NAMES.has(name)) return 'validation';

    const ctorName = err?.constructor?.name;
    if (typeof ctorName === 'string' && ctorName.endsWith('ValidationError')) return 'validation';

    const message = err?.message ?? '';
    if (typeof message === 'string' && MESSAGE_RE.test(message)) return 'validation';

    return null;
  },
};
