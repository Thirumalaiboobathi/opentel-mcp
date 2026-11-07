/**
 * @module serialize-span
 *
 * Converts a real OTel `ReadableSpan` (as delivered to a `SpanProcessor`'s
 * `onEnd()`) into the small, stable, JSON-serialisable
 * {@link import('./types.d.ts').SerializedSpan} shape this package
 * ships over SSE/HTTP. Deliberately NOT a re-export of `ReadableSpan`
 * itself — see `SerializedSpan`'s own docblock in `types.d.ts` for why.
 *
 * Field provenance (verified against opentel-mcp core's actual span
 * emission, `src/instrument.js`, not assumed): `gen_ai.tool.name` ->
 * toolName; `error.type` -> errorType (exactly `'tool_error'` identifies a
 * SILENT failure -- see opentel-mcp core's `ERROR_TYPE_TOOL_ERROR`
 * docblock (`src/attributes.js`) -- any other value is a thrown/protocol
 * failure); `error.type` absent entirely -> success; `mcp.failure.category`
 * / `mcp.failure.channel` -> failureCategory / failureChannel (only set
 * when fingerprinting was enabled and the call failed);
 * `mcp.tool.argument_count` -> argumentCount. Everything else opentel-mcp
 * set lands in the `attributes` passthrough bag.
 *
 * `spanFieldsFromAttributes()` is factored out and shared with
 * `otlp-json-receiver.js` (the standalone CLI's ingestion path) so the
 * "which attribute means what" mapping exists in exactly one place,
 * regardless of which of the two ingestion paths a span arrived through.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { sanitizeSpanEvents } from './security-events.js';
import { OPERATION_ATTRIBUTE_KEYS } from './span-method.js';

/** @typedef {import('@opentelemetry/sdk-trace').ReadableSpan} ReadableSpan */
/** @typedef {import('./types.d.ts').SerializedSpan} SerializedSpan */

const NAMED_ATTRIBUTE_KEYS = new Set([
  'gen_ai.tool.name',
  'error.type',
  'mcp.failure.category',
  'mcp.failure.channel',
  'mcp.tool.argument_count',
]);

/** @type {Record<number, SerializedSpan['status']>} */
export const STATUS_CODE_NAMES = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]: 'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
};

/**
 * @param {import('@opentelemetry/api').HrTime} hrTime - `[seconds, nanoseconds]`.
 * @returns {number} epoch/duration milliseconds.
 */
function hrTimeToMs([seconds, nanoseconds]) {
  return seconds * 1000 + nanoseconds / 1e6;
}

/**
 * Builds the `SerializedSpan` fields derived from a span's attribute bag
 * -- the part identical regardless of whether the attributes came from a
 * real `ReadableSpan.attributes` object or were just decoded from an OTLP
 * JSON wire payload.
 *
 * @param {Record<string, unknown>} attributes
 * @returns {Pick<SerializedSpan, 'attributes'> &
 *   Partial<Pick<SerializedSpan, 'toolName' | 'errorType' | 'failureCategory' | 'failureChannel' | 'argumentCount'>>}
 */
export function spanFieldsFromAttributes(attributes) {
  /** @type {ReturnType<typeof spanFieldsFromAttributes>} */
  const fields = { attributes: {} };

  if (typeof attributes['gen_ai.tool.name'] === 'string') fields.toolName = attributes['gen_ai.tool.name'];
  if (typeof attributes['error.type'] === 'string') fields.errorType = attributes['error.type'];
  if (typeof attributes['mcp.failure.category'] === 'string') fields.failureCategory = attributes['mcp.failure.category'];
  if (typeof attributes['mcp.failure.channel'] === 'string') fields.failureChannel = attributes['mcp.failure.channel'];
  if (typeof attributes['mcp.tool.argument_count'] === 'number') fields.argumentCount = attributes['mcp.tool.argument_count'];

  for (const [key, value] of Object.entries(attributes)) {
    if (NAMED_ATTRIBUTE_KEYS.has(key) || value === undefined) continue;
    fields.attributes[key] = value;
  }

  return fields;
}

/**
 * @param {ReadableSpan} span
 * @returns {SerializedSpan}
 */
export function serializeSpan(span) {
  const spanContext = span.spanContext();
  // ADR 033: only whitelisted security events survive; empty -> no `events` field (older shape, byte for byte).
  const events = sanitizeSpanEvents(
    (span.events ?? []).map((e) => ({ name: e.name, attributes: e.attributes, timeMs: hrTimeToMs(e.time) })),
  );

  return {
    id: spanContext.spanId,
    traceId: spanContext.traceId,
    name: span.name,
    startTimeMs: hrTimeToMs(span.startTime),
    durationMs: hrTimeToMs(span.duration),
    status: STATUS_CODE_NAMES[span.status?.code] ?? 'UNSET',
    ...spanFieldsFromAttributes(span.attributes ?? {}),
    ...(events.length > 0 ? { events } : {}),
  };
}

/**
 * Narrows a serialised resources/* or prompts/* span to what the
 * Resources & prompts panel uses: identity, timing, status, `error.type`
 * and the allowlisted attributes. No events, no extra attributes -- so
 * nothing beyond that can reach the buffer, the API or the SSE stream.
 *
 * @param {SerializedSpan} serialized
 * @returns {SerializedSpan}
 */
export function toOperationSpan(serialized) {
  /** @type {SerializedSpan['attributes']} */
  const attributes = {};
  for (const key of OPERATION_ATTRIBUTE_KEYS) {
    const value = serialized.attributes?.[key];
    if (typeof value === 'string') attributes[key] = value;
  }
  return {
    id: serialized.id,
    traceId: serialized.traceId,
    name: serialized.name,
    startTimeMs: serialized.startTimeMs,
    durationMs: serialized.durationMs,
    status: serialized.status,
    ...(serialized.errorType !== undefined ? { errorType: serialized.errorType } : {}),
    attributes,
  };
}
