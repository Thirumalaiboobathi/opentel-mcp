/**
 * @module fingerprint/classify/internal
 *
 * Catch-all classifier: every failure has to land in some category, so
 * this always matches. It must run last in {@link DEFAULT_CLASSIFIERS} —
 * anything reaching it didn't match a more specific classifier.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

/** @type {Classifier} */
export default {
  name: 'internal',
  match(_err, _ctx) {
    return 'internal';
  },
};
