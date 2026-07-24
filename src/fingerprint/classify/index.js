/**
 * @module fingerprint/classify
 *
 * The ordered classifier registry: each {@link Classifier} gets first
 * refusal on an error, in order, and the first non-null category wins.
 * Order encodes precedence between overlapping signals — e.g. a timeout
 * error whose message happens to mention "network" should still
 * classify as `timeout`, since `timeout` runs before `network`.
 *
 * `internal` is a catch-all that always matches, so it must stay last:
 * anything reaching it didn't match a more specific classifier.
 */

import validation from './validation.js';
import timeout from './timeout.js';
import network from './network.js';
import auth from './auth.js';
import dependency from './dependency.js';
import serialization from './serialization.js';
import internal from './internal.js';

/** @typedef {import('../types.d.ts').Classifier} Classifier */
/** @typedef {import('../types.d.ts').FailureCategory} FailureCategory */
/** @typedef {import('../types.d.ts').FingerprintContext} FingerprintContext */

/** @type {readonly Classifier[]} */
export const DEFAULT_CLASSIFIERS = Object.freeze([
  validation,
  timeout,
  network,
  auth,
  dependency,
  serialization,
  internal,
]);

/**
 * Runs `classifiers` against `err` in order, returning the first non-null
 * category. Falls back to `"unknown"` if every classifier returns null —
 * this shouldn't happen with `internal` present, but callers may pass a
 * custom list that omits it, so this stays defensive rather than throwing.
 *
 * @param {unknown} err
 * @param {FingerprintContext} ctx
 * @param {readonly Classifier[]} [classifiers]
 * @returns {FailureCategory}
 */
export function runClassifiers(err, ctx, classifiers = DEFAULT_CLASSIFIERS) {
  for (const classifier of classifiers) {
    let category = null;
    try {
      category = classifier.match(err, ctx);
    } catch {
      category = null;
    }
    if (category !== null) return category;
  }
  return 'unknown';
}
