import type { Attributes } from '@opentelemetry/api';
import type { FingerprintResult } from './types.d.ts';

/** The `mcp.failure.*` OpenTelemetry span attribute keys. */
export const ATTRIBUTE_KEYS: Readonly<
  Record<'FINGERPRINT' | 'SIGNATURE' | 'CATEGORY' | 'ORIGIN' | 'ERROR_CLASS' | 'CHANNEL' | 'VALIDATION_PATHS', string>
>;

/**
 * Attribute keys safe to attach to metric labels — `category` and `origin`
 * only; everything else in {@link ATTRIBUTE_KEYS} is unbounded or
 * medium-cardinality and must stay span-only.
 */
export const METRIC_SAFE_ATTRIBUTES: readonly string[];

/**
 * Builds the span attributes for a fingerprinted failure. Never throws —
 * returns `{}` if `result` is malformed in any way.
 */
export function toSpanAttributes(result: FingerprintResult): Attributes;
