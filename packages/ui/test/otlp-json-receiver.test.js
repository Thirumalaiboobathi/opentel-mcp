import { describe, it, expect } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { parseOtlpJsonTraceRequest } from '../src/otlp-json-receiver.js';

/**
 * Builds a REAL OTLP/HTTP JSON payload the exact way opentel-mcp core's
 * own OTLPTraceExporter dependency does (JsonTraceSerializer, the same
 * package/function `@opentelemetry/exporter-trace-otlp-http` uses
 * internally) -- so this test proves the receiver against the real wire
 * format, not a hand-guessed shape.
 */
async function realOtlpJsonPayloadFor(spanName, attributeSetup) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();

  const tracer = trace.getTracer('test');
  const span = tracer.startSpan(spanName);
  attributeSetup?.(span);
  span.end();

  const [readableSpan] = exporter.getFinishedSpans();
  const bytes = JsonTraceSerializer.serializeRequest([readableSpan]);
  const json = JSON.parse(new TextDecoder().decode(bytes));

  trace.disable();
  await provider.shutdown();
  return { json, readableSpan };
}

describe('parseOtlpJsonTraceRequest', () => {
  it('decodes a real OTLP/HTTP JSON payload (via the same JsonTraceSerializer opentel-mcp core\'s exporter uses) into a SerializedSpan', async () => {
    const { json, readableSpan } = await realOtlpJsonPayloadFor('tools/call echo', (span) => {
      span.setAttribute('gen_ai.tool.name', 'echo');
      span.setAttribute('mcp.tool.argument_count', 1);
      span.setStatus({ code: SpanStatusCode.OK });
    });

    const [decoded] = parseOtlpJsonTraceRequest(json);

    expect(decoded.id).toBe(readableSpan.spanContext().spanId);
    expect(decoded.traceId).toBe(readableSpan.spanContext().traceId);
    expect(decoded.name).toBe('tools/call echo');
    expect(decoded.toolName).toBe('echo');
    expect(decoded.argumentCount).toBe(1);
    expect(decoded.status).toBe('OK');
    expect(typeof decoded.startTimeMs).toBe('number');
    expect(decoded.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('decodes a silent failure (error.type: tool_error) correctly from the wire format', async () => {
    const { json } = await realOtlpJsonPayloadFor('tools/call broken', (span) => {
      span.setAttribute('error.type', 'tool_error');
      span.setAttribute('mcp.failure.category', 'validation');
      span.setStatus({ code: SpanStatusCode.ERROR });
    });

    const [decoded] = parseOtlpJsonTraceRequest(json);
    expect(decoded.status).toBe('ERROR');
    expect(decoded.errorType).toBe('tool_error');
    expect(decoded.failureCategory).toBe('validation');
  });

  it('filters out non-tools/call spans (e.g. tools/list), same as the in-process path', async () => {
    const { json } = await realOtlpJsonPayloadFor('tools/list');
    expect(parseOtlpJsonTraceRequest(json)).toEqual([]);
  });

  it('handles a resourceSpans/scopeSpans structure with multiple spans', async () => {
    const { json: json1 } = await realOtlpJsonPayloadFor('tools/call a');
    const { json: json2 } = await realOtlpJsonPayloadFor('tools/call b');
    const combined = { resourceSpans: [...json1.resourceSpans, ...json2.resourceSpans] };

    const decoded = parseOtlpJsonTraceRequest(combined);
    expect(decoded.map((s) => s.name).sort()).toEqual(['tools/call a', 'tools/call b']);
  });

  it('gracefully returns an empty array for a malformed/empty body', () => {
    expect(parseOtlpJsonTraceRequest({})).toEqual([]);
    expect(parseOtlpJsonTraceRequest({ resourceSpans: [] })).toEqual([]);
    expect(parseOtlpJsonTraceRequest(null)).toEqual([]);
  });

  it('passes through non-named attributes into the attributes bag, decoding intValue/stringValue correctly', async () => {
    const { json } = await realOtlpJsonPayloadFor('tools/call echo', (span) => {
      span.setAttribute('mcp.tool.tokens.total', 42);
      span.setAttribute('mcp.method.name', 'tools/call');
    });

    const [decoded] = parseOtlpJsonTraceRequest(json);
    expect(decoded.attributes['mcp.tool.tokens.total']).toBe(42);
    expect(decoded.attributes['mcp.method.name']).toBe('tools/call');
  });
});
