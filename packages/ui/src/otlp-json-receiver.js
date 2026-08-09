/**
 * @module otlp-json-receiver
 *
 * Decodes an OTLP/HTTP JSON `ExportTraceServiceRequest` body (the exact
 * wire format opentel-mcp core's own `@opentelemetry/exporter-trace-otlp-http`
 * dependency sends by default — confirmed by reading that package's
 * installed source directly, not assumed: it constructs its exporter with
 * `JsonTraceSerializer` and `Content-Type: application/json`, hex-encoded
 * trace/span ids, decimal-string nanosecond timestamps) straight into
 * `SerializedSpan`s.
 *
 * This is the standalone CLI's (`bin/opentel-mcp-ui.js`) ingestion path:
 * point an already-`setupNodeSdk: true`-instrumented opentel-mcp server's
 * `exporterUrl` at this receiver's `/v1/traces` endpoint, and spans arrive
 * here with ZERO code changes to opentel-mcp core — `exporterUrl` already
 * exists and already sends exactly this format today. Not a re-emission
 * path: this is opentel-mcp core's OWN, already-shipping, real OTLP
 * export mechanism; this file is just the receiving end of it.
 *
 * Deliberately hand-written rather than built on
 * `@opentelemetry/otlp-transformer` (a transitive dependency via
 * `@opentelemetry/exporter-trace-otlp-http`): that package's public API is
 * exporter-shaped (encode a request, decode a *response*) — it has no
 * "decode an incoming request" function, because a real exporter never
 * needs one. The OTLP JSON wire shape itself is small, stable, and
 * spec-documented (opentelemetry-proto's trace_service.proto JSON
 * mapping), so parsing it directly is simpler than depending on and
 * fighting a library that solves a different half of the problem.
 */

import { STATUS_CODE_NAMES, spanFieldsFromAttributes } from './serialize-span.js';

/**
 * @param {{ key: string, value: Record<string, unknown> }} kv
 * @returns {[string, string | number | boolean | undefined]}
 */
function decodeKeyValue(kv) {
  const value = kv.value ?? {};
  if ('stringValue' in value) return [kv.key, value.stringValue];
  if ('intValue' in value) return [kv.key, Number(value.intValue)];
  if ('doubleValue' in value) return [kv.key, value.doubleValue];
  if ('boolValue' in value) return [kv.key, value.boolValue];
  if ('arrayValue' in value) {
    const arr = /** @type {{ values?: Record<string, unknown>[] }} */ (value.arrayValue);
    return [kv.key, (arr.values ?? []).map((v) => decodeKeyValue({ key: '', value: v })[1])];
  }
  return [kv.key, undefined];
}

/**
 * @param {Array<{ key: string, value: Record<string, unknown> }>} [attributeList]
 * @returns {Record<string, unknown>}
 */
function decodeAttributes(attributeList) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const kv of attributeList ?? []) {
    const [key, value] = decodeKeyValue(kv);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `startTimeUnixNano`/`endTimeUnixNano` arrive as decimal STRINGS (OTLP
 * JSON's convention for 64-bit integers, which don't fit safely in a JS
 * `number` — see `@opentelemetry/otlp-transformer`'s `encodeAsString()`,
 * confirmed by reading its installed source).
 *
 * @param {string | number} unixNano
 * @returns {number} epoch milliseconds.
 */
function unixNanoToMs(unixNano) {
  return Number(BigInt(unixNano) / 1_000_000n);
}

/**
 * @param {unknown} body - parsed JSON body of a POST to `/v1/traces`.
 * @returns {import('./types.d.ts').SerializedSpan[]} only
 *   `tools/call`-shaped spans -- same filter `CollectorSpanProcessor.onEnd()`
 *   applies to the in-process path, kept consistent between both.
 */
export function parseOtlpJsonTraceRequest(body) {
  /** @type {import('./types.d.ts').SerializedSpan[]} */
  const spans = [];

  for (const resourceSpan of body?.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan?.scopeSpans ?? []) {
      for (const span of scopeSpan?.spans ?? []) {
        if (typeof span?.name !== 'string' || !span.name.startsWith('tools/call')) continue;

        const attributes = decodeAttributes(span.attributes);
        const startTimeMs = unixNanoToMs(span.startTimeUnixNano ?? '0');
        const endTimeMs = unixNanoToMs(span.endTimeUnixNano ?? span.startTimeUnixNano ?? '0');

        spans.push({
          id: span.spanId,
          traceId: span.traceId,
          name: span.name,
          startTimeMs,
          durationMs: endTimeMs - startTimeMs,
          status: STATUS_CODE_NAMES[span.status?.code ?? 0] ?? 'UNSET',
          ...spanFieldsFromAttributes(attributes),
        });
      }
    }
  }

  return spans;
}
