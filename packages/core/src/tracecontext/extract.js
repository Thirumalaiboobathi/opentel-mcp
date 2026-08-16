/**
 * @module tracecontext/extract
 * Server-side W3C Trace Context extraction from an MCP `tools/call`
 * request's `params._meta` — lets a client that already sets
 * `_meta.traceparent` (any OTel SDK's `propagation.inject()` output,
 * copied in directly) have its tool-call span join the client's own
 * trace, instead of starting a disconnected one. See ADR 017
 * (`docs/adr/017-trace-context-propagation.md`) for the full design,
 * including why this reuses only `@opentelemetry/api` (already a peer
 * dependency) rather than adding `@opentelemetry/core`.
 *
 * Never throws — `_meta` is untrusted client input (see ADR 017's
 * "Untrusted input handling"); absent, malformed, or unparseable
 * `traceparent`/`tracestate` all degrade to returning `baseContext`
 * completely unchanged, which — passed as `startActiveSpan()`'s context
 * argument — is byte-identical to today's pre-this-feature behavior, not
 * merely equivalent to it (confirmed against both `NoopTracer` and the
 * real SDK `Tracer`'s own `ctx ?? context.active()` fallback).
 */

import { context, trace, isSpanContextValid, createTraceState, diag } from '@opentelemetry/api';

// Matches @opentelemetry/core's W3CTraceContextPropagator.parseTraceParent()
// field-for-field (confirmed by reading that implementation directly, not
// from memory) — see ADR 017's "No new dependency" section for why this is
// hand-written instead of imported. Per the W3C spec
// (https://www.w3.org/TR/trace-context/#traceparent-header-field-values):
// version/trace-id/parent-id/flags as 2/32/16/2 lowercase hex chars;
// trace-id and parent-id each rejected if all-zero; version 'ff' is
// reserved/invalid.
const VERSION_PART = '(?!ff)[\\da-f]{2}';
const TRACE_ID_PART = '(?![0]{32})[\\da-f]{32}';
const PARENT_ID_PART = '(?![0]{16})[\\da-f]{16}';
const FLAGS_PART = '[\\da-f]{2}';
const TRACE_PARENT_REGEX = new RegExp(
  `^\\s?(${VERSION_PART})-(${TRACE_ID_PART})-(${PARENT_ID_PART})-(${FLAGS_PART})(-.*)?\\s?$`,
);

/**
 * Parses a `traceparent` header value into its three fields, or `null` if
 * it doesn't match the spec format.
 *
 * @param {string} traceParent
 * @returns {{ traceId: string, spanId: string, traceFlags: number } | null}
 */
function parseTraceParent(traceParent) {
  const match = TRACE_PARENT_REGEX.exec(traceParent);
  if (!match) return null;

  // Per the spec's versioning/forward-compatibility clause: version 00
  // MUST be exactly the 4-field format (reject trailing dash-separated
  // garbage); a higher version number tolerates and ignores trailing
  // fields, since a future version might legitimately add more.
  if (match[1] === '00' && match[5]) return null;

  return {
    traceId: match[2],
    spanId: match[3],
    traceFlags: parseInt(match[4], 16),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts W3C Trace Context from `meta` (a `tools/call` request's
 * `params._meta`) and returns a `Context` with the extracted `SpanContext`
 * attached as a remote parent — or `baseContext` unchanged if `meta` carries
 * no valid `traceparent`.
 *
 * The extracted `SpanContext` always REPLACES whatever was in
 * `baseContext`, never merges with it — see ADR 017's "Conflicting
 * `_meta.traceparent` and an already-active local context" for why this is
 * the correct behavior, not merely the simplest one. Setting `isRemote:
 * true` and the real parsed `traceFlags` is what lets the SDK's own default
 * `ParentBasedSampler` honor the upstream sampling decision automatically
 * — see ADR 017's "Sampling" section; no sampling logic lives here.
 *
 * @param {unknown} meta - `request.params._meta` — untrusted client input.
 * @param {import('@opentelemetry/api').Context} [baseContext] - Defaults to
 *   `context.active()`. Exposed as a parameter for testability.
 * @returns {import('@opentelemetry/api').Context}
 */
export function extractTraceContext(meta, baseContext = context.active()) {
  try {
    if (!isPlainObject(meta)) return baseContext;
    if (typeof meta.traceparent !== 'string') return baseContext;

    const parsed = parseTraceParent(meta.traceparent);
    if (!parsed) return baseContext;

    /** @type {import('@opentelemetry/api').SpanContext} */
    const spanContext = {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: parsed.traceFlags,
      isRemote: true,
    };
    if (typeof meta.tracestate === 'string') {
      // createTraceState() is fully spec-validated (length/entry-count caps,
      // per-entry key/value validation) and never throws — malformed entries
      // are silently dropped, not fatal to the traceparent it accompanies.
      spanContext.traceState = createTraceState(meta.tracestate);
    }

    if (!isSpanContextValid(spanContext)) return baseContext;

    return trace.setSpanContext(baseContext, spanContext);
  } catch (err) {
    // Never throw — see module docblock. diag.debug, not diag.warn: the
    // overwhelmingly common case is "no _meta.traceparent at all," which is
    // not a misconfiguration and must not produce warning spam.
    diag.debug('opentel-mcp: trace context extraction from _meta failed, using the active context unchanged', err);
    return baseContext;
  }
}

// Re-exported for direct unit testing of the W3C parsing rules (all-zero
// IDs, reserved version, version-00 trailing-field rejection, etc.) without
// needing to construct a fake Context/meta object per case. Not part of the
// public opentel-mcp API surface — not re-exported from src/index.js.
export { parseTraceParent as __parseTraceParentForTests };
