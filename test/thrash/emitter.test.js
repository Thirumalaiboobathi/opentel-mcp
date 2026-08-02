import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { createThrashEmitter } from '../../src/thrash/emitter.js';
import { ATTR_GEN_AI_TOOL_NAME } from '../../src/attributes.js';
import { ATTRIBUTE_KEYS } from '../../src/fingerprint/attributes.js';
import {
  SPAN_EVENT_NAME_LOOP_DETECTED,
  ATTR_MCP_LOOP_LENGTH,
  ATTR_MCP_LOOP_WASTED_TOKENS_IN,
  ATTR_MCP_LOOP_WASTED_TOKENS_OUT,
  ATTR_MCP_LOOP_WASTED_COST_USD,
  ATTR_MCP_LOOP_DURATION_MS,
  ATTR_MCP_LOOP_FIRST_SPAN_ID,
  ATTR_MCP_LOOP_FIRST_TRACE_ID,
  ATTR_MCP_LOOP_SESSION_ID,
} from '../../src/thrash/attributes.js';

/** Minimal in-memory MetricReader — mirrors test/metrics.test.js's TestMetricReader. */
class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

function findMetric(resourceMetrics, name) {
  for (const scope of resourceMetrics.scopeMetrics) {
    const metric = scope.metrics.find((m) => m.descriptor.name === name);
    if (metric) return metric;
  }
  return undefined;
}

/** Builds a valid ThrashDetectedEvent, overridable per call. */
function mkEvent(overrides = {}) {
  return {
    sessionId: 'session-abc',
    toolName: 'search',
    fingerprint: 'fp-abc123',
    loopLength: 3,
    wastedTokensIn: 30,
    wastedTokensOut: 15,
    wastedCostUsd: 0.03,
    durationMs: 200,
    firstSpanId: 'span-first',
    firstTraceId: 'trace-first',
    ...overrides,
  };
}

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  // Unlike this repo's other test files, this one omits contextManager
  // (they pass `null`, meaning "don't register one" — fine for them since
  // they always use the span passed as startActiveSpan()'s callback
  // argument). This file's subject, emitter.js, deliberately uses
  // trace.getActiveSpan() instead (see its docblock: "the current active
  // span," never a passed-in one) — that only resolves correctly with a
  // real context manager registered, which is also what happens in actual
  // production use (NodeTracerProvider.register() with no override).
  traceProvider.register({ propagator: null });

  metricReader = new TestMetricReader();
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await traceProvider.shutdown();
  trace.disable();
  context.disable();
  spanExporter.reset();

  await meterProvider.shutdown();
  metrics.disable();
});

describe('createThrashEmitter', () => {
  it('emits all five metric instruments on one event', async () => {
    const emitter = createThrashEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent());
      span.end();
    });

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    const length = findMetric(resourceMetrics, 'mcp.tool.loop.length');
    const wastedTokens = findMetric(resourceMetrics, 'mcp.tool.loop.wasted_tokens');
    const wastedCostUsd = findMetric(resourceMetrics, 'mcp.tool.loop.wasted_cost_usd');
    const duration = findMetric(resourceMetrics, 'mcp.tool.loop.duration');

    expect(detected.dataPoints[0].value).toBe(1);
    expect(length.dataPoints[0].value.sum).toBe(3);
    expect(wastedTokens.dataPoints[0].value.sum).toBe(45); // 30 + 15
    expect(wastedCostUsd.dataPoints[0].value.sum).toBeCloseTo(0.03, 6);
    expect(duration.dataPoints[0].value.sum).toBe(200);
  });

  it('carries only gen_ai.tool.name on metric labels — never mcp.failure.fingerprint or mcp.loop.session_id', async () => {
    const emitter = createThrashEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent());
      span.end();
    });

    const { resourceMetrics } = await metricReader.collect();
    for (const name of [
      'mcp.tool.loop.detected',
      'mcp.tool.loop.length',
      'mcp.tool.loop.wasted_tokens',
      'mcp.tool.loop.wasted_cost_usd',
      'mcp.tool.loop.duration',
    ]) {
      const metric = findMetric(resourceMetrics, name);
      const attrs = metric.dataPoints[0].attributes;
      expect(Object.keys(attrs)).toEqual([ATTR_GEN_AI_TOOL_NAME]);
      expect(attrs[ATTR_GEN_AI_TOOL_NAME]).toBe('search');
      expect(attrs[ATTRIBUTE_KEYS.FINGERPRINT]).toBeUndefined();
      expect(attrs[ATTR_MCP_LOOP_SESSION_ID]).toBeUndefined();
    }
  });

  it('adds a span event with the correct attribute values on the active span', () => {
    const emitter = createThrashEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(
        mkEvent({ sessionId: 'session-xyz', fingerprint: 'fp-xyz', loopLength: 6, wastedTokensIn: 100, wastedTokensOut: 50 }),
      );
      span.end();
    });

    const [span] = spanExporter.getFinishedSpans();
    const events = span.events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED);
    expect(events).toHaveLength(1);

    const attrs = events[0].attributes;
    expect(attrs[ATTR_MCP_LOOP_LENGTH]).toBe(6);
    expect(attrs[ATTR_MCP_LOOP_WASTED_TOKENS_IN]).toBe(100);
    expect(attrs[ATTR_MCP_LOOP_WASTED_TOKENS_OUT]).toBe(50);
    expect(attrs[ATTR_MCP_LOOP_WASTED_COST_USD]).toBeCloseTo(0.03, 6);
    expect(attrs[ATTR_MCP_LOOP_DURATION_MS]).toBe(200);
    expect(attrs[ATTR_MCP_LOOP_FIRST_SPAN_ID]).toBe('span-first');
    expect(attrs[ATTR_MCP_LOOP_FIRST_TRACE_ID]).toBe('trace-first');
    expect(attrs[ATTR_MCP_LOOP_SESSION_ID]).toBe('session-xyz');
    expect(attrs[ATTRIBUTE_KEYS.FINGERPRINT]).toBe('fp-xyz');
  });

  it('skips the span event silently, but still emits metrics, when there is no active span', async () => {
    const emitter = createThrashEmitter('0.0.0-test');

    expect(() => emitter.emit(mkEvent())).not.toThrow();

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(1);
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);
  });

  it('skips the span event silently when the active span is not recording (already ended)', async () => {
    const emitter = createThrashEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');
    let capturedSpan;

    tracer.startActiveSpan('span', (span) => {
      capturedSpan = span;
      span.end(); // ended — no longer recording
    });

    expect(capturedSpan.isRecording()).toBe(false);
    expect(() => emitter.emit(mkEvent())).not.toThrow();
  });

  it('never throws with a deliberately broken meter — metrics fail silently', () => {
    class BrokenInstrument {
      add() {
        throw new Error('counter is broken');
      }
      record() {
        throw new Error('histogram is broken');
      }
    }
    class BrokenMeter {
      createCounter() {
        return new BrokenInstrument();
      }
      createHistogram() {
        return new BrokenInstrument();
      }
    }
    class BrokenMeterProvider {
      getMeter() {
        return new BrokenMeter();
      }
    }

    metrics.setGlobalMeterProvider(new BrokenMeterProvider());
    const emitter = createThrashEmitter('0.0.0-test');

    expect(() => emitter.emit(mkEvent())).not.toThrow();
  });

  it('never throws for a malformed event', () => {
    const emitter = createThrashEmitter('0.0.0-test');
    expect(() => emitter.emit(null)).not.toThrow();
    expect(() => emitter.emit(undefined)).not.toThrow();
    expect(() => emitter.emit({})).not.toThrow();
  });
});
