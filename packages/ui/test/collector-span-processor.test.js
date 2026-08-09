import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';

/** @type {NodeTracerProvider} */
let provider;
/** @type {CollectorSpanProcessor} */
let collector;

beforeEach(() => {
  collector = new CollectorSpanProcessor({ capacity: 10 });
  provider = new NodeTracerProvider({ spanProcessors: [collector] });
  provider.register();
});

afterEach(async () => {
  trace.disable();
  await provider.shutdown();
});

describe('CollectorSpanProcessor', () => {
  it('buffers tools/call spans it observes via the real SpanProcessor extension point', () => {
    const tracer = trace.getTracer('test');
    tracer.startSpan('tools/call echo', { kind: SpanKind.SERVER }).end();

    expect(collector.buffer.size).toBe(1);
    expect(collector.buffer.toArray()[0].name).toBe('tools/call echo');
  });

  it('filters out tools/list spans (schema drift) -- not part of this dashboard\'s contract', () => {
    const tracer = trace.getTracer('test');
    tracer.startSpan('tools/list').end();
    tracer.startSpan('tools/call echo').end();

    expect(collector.buffer.size).toBe(1);
    expect(collector.buffer.toArray()[0].name).toBe('tools/call echo');
  });

  it('notifies subscribers synchronously with a monotonically increasing sequence number', () => {
    const seen = [];
    collector.subscribe((span, seq) => seen.push({ name: span.name, seq }));

    const tracer = trace.getTracer('test');
    tracer.startSpan('tools/call a').end();
    tracer.startSpan('tools/call b').end();

    expect(seen).toEqual([
      { name: 'tools/call a', seq: 1 },
      { name: 'tools/call b', seq: 2 },
    ]);
  });

  it('unsubscribe stops further notifications without affecting the buffer', () => {
    const listener = vi.fn();
    const unsubscribe = collector.subscribe(listener);

    const tracer = trace.getTracer('test');
    tracer.startSpan('tools/call a').end();
    unsubscribe();
    tracer.startSpan('tools/call b').end();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(collector.buffer.size).toBe(2);
  });

  it('a throwing listener does not stop ingestion or other listeners', () => {
    const goodListener = vi.fn();
    collector.subscribe(() => {
      throw new Error('broken SSE client write');
    });
    collector.subscribe(goodListener);

    const tracer = trace.getTracer('test');
    expect(() => tracer.startSpan('tools/call a').end()).not.toThrow();

    expect(goodListener).toHaveBeenCalledTimes(1);
    expect(collector.buffer.size).toBe(1);
  });

  it('ingestSerializedSpan() (the standalone CLI/OTLP-receiver path) pushes and notifies exactly like onEnd() does', () => {
    const seen = [];
    collector.subscribe((span, seq) => seen.push(seq));

    const seq = collector.ingestSerializedSpan({
      id: 'abc',
      traceId: 'def',
      name: 'tools/call echo',
      startTimeMs: 0,
      durationMs: 1,
      status: 'OK',
      attributes: {},
    });

    expect(seq).toBe(1);
    expect(seen).toEqual([1]);
    expect(collector.buffer.size).toBe(1);
  });

  it('shutdown() clears listeners', async () => {
    const listener = vi.fn();
    collector.subscribe(listener);
    await collector.shutdown();

    const tracer = trace.getTracer('test');
    tracer.startSpan('tools/call a').end();

    expect(listener).not.toHaveBeenCalled();
  });
});
