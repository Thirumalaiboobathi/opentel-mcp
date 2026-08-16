import type { Context } from '@opentelemetry/api';

/**
 * Extracts W3C Trace Context from `meta` (a `tools/call` request's
 * `params._meta`) and returns a `Context` with the extracted `SpanContext`
 * attached as a remote parent — or `baseContext` unchanged if `meta` carries
 * no valid `traceparent`. Never throws. See ADR 017
 * (`docs/adr/017-trace-context-propagation.md`).
 */
export function extractTraceContext(meta: unknown, baseContext?: Context): Context;
