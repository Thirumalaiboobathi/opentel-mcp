/**
 * @module serialize-span
 *
 * Converts a real OTel `ReadableSpan` (as delivered to a `SpanProcessor`'s
 * `onEnd()`) into the small, stable, JSON-serialisable
 * {@link import('opentel-mcp-contract').SerializedSpan} shape this package
 * ships over SSE/HTTP. Deliberately NOT a re-export of `ReadableSpan`
 * itself — see `SerializedSpan`'s own docblock in opentel-mcp-contract for
 * why.
 *
 * Field provenance (verified against opentel-mcp core's actual span
 * emission, `src/instrument.js`, not assumed): `gen_ai.tool.name` ->
 * toolName; `error.type` -> errorType (exactly `'tool_error'` identifies a
 * SILENT failure -- see opentel-mcp-contract's `ERROR_TYPE_TOOL_ERROR`
 * docblock -- any other value is a thrown/protocol failure); `error.type`
 * absent entirely -> success; `mcp.failure.category` / `mcp.failure.channel`
 * -> failureCategory / failureChannel (only set when fingerprinting was
 * enabled and the call failed); `mcp.tool.argument_count` -> argumentCount.
 * Everything else opentel-mcp set lands in the `attributes` passthrough bag.
 *
 * `spanFieldsFromAttributes()` is factored out and shared with
 * `otlp-json-receiver.js` (the standalone CLI's ingestion path) so the
 * "which attribute means what" mapping exists in exactly one place,
 * regardless of which of the two ingestion paths a span arrived through.
 */

import { SpanStatusCode } from '@opentelemetry/api';

/** @typedef {import('@opentelemetry/sdk-trace').ReadableSpan} ReadableSpan */
/** @typedef {import('opentel-mcp-contract').SerializedSpan} SerializedSpan */

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

  return {
    id: spanContext.spanId,
    traceId: spanContext.traceId,
    name: span.name,
    startTimeMs: hrTimeToMs(span.startTime),
    durationMs: hrTimeToMs(span.duration),
    status: STATUS_CODE_NAMES[span.status?.code] ?? 'UNSET',
    ...spanFieldsFromAttributes(span.attributes ?? {}),
  };
}
