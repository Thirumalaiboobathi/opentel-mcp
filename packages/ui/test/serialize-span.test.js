import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { serializeSpan } from '../src/serialize-span.js';

/** @type {InMemorySpanExporter} */
let exporter;
/** @type {NodeTracerProvider} */
let provider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterEach(async () => {
  trace.disable();
  await provider.shutdown();
});

function endedSpans() {
  return exporter.getFinishedSpans();
}

describe('serializeSpan', () => {
  it('maps id/traceId/name from spanContext(), and status OK for a clean success', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('tools/call echo', { kind: SpanKind.SERVER });
    span.setAttribute('gen_ai.tool.name', 'echo');
    span.setAttribute('mcp.tool.argument_count', 2);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const [readableSpan] = endedSpans();
    const serialized = serializeSpan(readableSpan);

    expect(serialized.id).toBe(readableSpan.spanContext().spanId);
    expect(serialized.traceId).toBe(readableSpan.spanContext().traceId);
    expect(serialized.name).toBe('tools/call echo');
    expect(serialized.status).toBe('OK');
    expect(serialized.toolName).toBe('echo');
    expect(serialized.argumentCount).toBe(2);
    expect(serialized.errorType).toBeUndefined();
    expect(typeof serialized.startTimeMs).toBe('number');
    expect(serialized.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("identifies a SILENT failure via errorType === 'tool_error' -- the exact per-span discriminator this dashboard's silent-failure feed depends on", () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('tools/call broken', { kind: SpanKind.SERVER });
    span.setAttribute('gen_ai.tool.name', 'broken');
    span.setAttribute('error.type', 'tool_error');
    span.setAttribute('mcp.failure.category', 'validation');
    span.setAttribute('mcp.failure.channel', 'execution');
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();

    const [readableSpan] = endedSpans();
    const serialized = serializeSpan(readableSpan);

    expect(serialized.status).toBe('ERROR');
    expect(serialized.errorType).toBe('tool_error');
    expect(serialized.failureCategory).toBe('validation');
    expect(serialized.failureChannel).toBe('execution');
  });

  it('a thrown/protocol failure sets errorType to the exception name, NOT tool_error -- must not be confused with a silent failure', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('tools/call broken', { kind: SpanKind.SERVER });
    span.setAttribute('error.type', 'TypeError');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
    span.end();

    const [readableSpan] = endedSpans();
    const serialized = serializeSpan(readableSpan);

    expect(serialized.status).toBe('ERROR');
    expect(serialized.errorType).toBe('TypeError');
    expect(serialized.errorType).not.toBe('tool_error');
  });

  it('named fields are excluded from the attributes passthrough bag; everything else is included', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('tools/call echo', { kind: SpanKind.SERVER });
    span.setAttribute('gen_ai.tool.name', 'echo');
    span.setAttribute('mcp.tool.cost.usd', 0.002);
    span.setAttribute('mcp.method.name', 'tools/call');
    span.end();

    const [readableSpan] = endedSpans();
    const serialized = serializeSpan(readableSpan);

    expect(serialized.attributes).not.toHaveProperty('gen_ai.tool.name');
    expect(serialized.attributes['mcp.tool.cost.usd']).toBe(0.002);
    expect(serialized.attributes['mcp.method.name']).toBe('tools/call');
  });

  it('an UNSET status (no exception, no isError check ever ran) reports UNSET, not a guessed OK', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('tools/call echo');
    span.end();

    const [readableSpan] = endedSpans();
    expect(serializeSpan(readableSpan).status).toBe('UNSET');
  });
});
