import type { ComputeFingerprintOptions, FingerprintContext, FingerprintResult } from './types.d.ts';

/**
 * Computes a stable identity fingerprint for a failure. Never throws — falls
 * back to a well-known "unfingerprintable" result on any unexpected shape.
 */
export function computeFingerprint(
  err: unknown,
  ctx: FingerprintContext,
  opts?: ComputeFingerprintOptions,
): FingerprintResult;
