import type { Classifier, FailureCategory, FingerprintContext } from '../types.d.ts';

/**
 * The ordered classifier registry: each classifier gets first refusal on an
 * error, in order, and the first non-null category wins. `internal` is a
 * catch-all that always matches, so it stays last.
 */
export const DEFAULT_CLASSIFIERS: readonly Classifier[];

/**
 * Runs `classifiers` against `err` in order, returning the first non-null
 * category. Falls back to `"unknown"` if every classifier returns null.
 */
export function runClassifiers(
  err: unknown,
  ctx: FingerprintContext,
  classifiers?: readonly Classifier[],
): FailureCategory;
