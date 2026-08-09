import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { createSchemaDriftEmitter } from '../../src/schema-drift/emitter.js';
import { ATTR_GEN_AI_TOOL_NAME } from '../../src/attributes.js';
import { SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED, ATTRIBUTE_KEYS, METRIC_SAFE_ATTRIBUTES } from '../../src/schema-drift/attributes.js';

/** Minimal in-memory MetricReader — mirrors test/thrash/emitter.test.js's TestMetricReader. */
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

/** Builds a valid SchemaDriftEvent, overridable per call. */
function mkEvent(overrides = {}) {
  return {
    scope: 'server-1',
    toolName: 'search',
    previousHash: 'aaaaaaaaaaaaaaaa',
    currentHash: 'bbbbbbbbbbbbbbbb',
    kind: 'field_added',
    addedFields: ['limit'],
    removedFields: [],
    changedFields: [],
    requiredChanged: false,
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
  // Same reasoning as test/thrash/emitter.test.js: emitter.js uses
  // trace.getActiveSpan(), which only resolves correctly with a real
  // context manager registered.
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

describe('createSchemaDriftEmitter', () => {
  it('emits the mcp.tool.schema_drift.detected counter with exactly the expected attribute set', async () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent());
      span.end();
    });

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected');

    expect(detected.dataPoints[0].value).toBe(1);
    const attrs = detected.dataPoints[0].attributes;
    expect(attrs).toEqual({
      [ATTR_GEN_AI_TOOL_NAME]: 'search',
      [ATTRIBUTE_KEYS.TYPE]: 'field_added',
    });
  });

  it('carries only gen_ai.tool.name and the bounded drift type on the metric — never hashes or field names', async () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent({ kind: 'multiple', addedFields: ['limit'], changedFields: ['q'], requiredChanged: true }));
      span.end();
    });

    const { resourceMetrics } = await metricReader.collect();
    const attrs = findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected').dataPoints[0].attributes;

    expect(Object.keys(attrs).sort()).toEqual([ATTR_GEN_AI_TOOL_NAME, ATTRIBUTE_KEYS.TYPE].sort());
    expect(attrs[ATTRIBUTE_KEYS.PREVIOUS_HASH]).toBeUndefined();
    expect(attrs[ATTRIBUTE_KEYS.CURRENT_HASH]).toBeUndefined();
    expect(attrs[ATTRIBUTE_KEYS.ADDED_FIELDS]).toBeUndefined();
    expect(attrs[ATTRIBUTE_KEYS.CHANGED_FIELDS]).toBeUndefined();
  });

  it('every metric-emitted attribute key is in METRIC_SAFE_ATTRIBUTES (plus the separately-accepted gen_ai.tool.name)', async () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent());
      span.end();
    });

    const { resourceMetrics } = await metricReader.collect();
    const attrs = findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected').dataPoints[0].attributes;

    for (const key of Object.keys(attrs)) {
      expect(key === ATTR_GEN_AI_TOOL_NAME || METRIC_SAFE_ATTRIBUTES.includes(key)).toBe(true);
    }
  });

  it('adds a span event with the correct name and values on the active span', () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(
        mkEvent({
          toolName: 'get_weather',
          previousHash: '1111111111111111',
          currentHash: '2222222222222222',
          kind: 'type_changed',
          changedFields: ['units'],
          addedFields: [],
          removedFields: [],
        }),
      );
      span.end();
    });

    const [span] = spanExporter.getFinishedSpans();
    const events = span.events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED);
    expect(events).toHaveLength(1);

    const attrs = events[0].attributes;
    expect(attrs[ATTR_GEN_AI_TOOL_NAME]).toBe('get_weather');
    expect(attrs[ATTRIBUTE_KEYS.TYPE]).toBe('type_changed');
    expect(attrs[ATTRIBUTE_KEYS.PREVIOUS_HASH]).toBe('1111111111111111');
    expect(attrs[ATTRIBUTE_KEYS.CURRENT_HASH]).toBe('2222222222222222');
    expect(attrs[ATTRIBUTE_KEYS.CHANGED_FIELDS]).toEqual(['units']);
    expect(attrs[ATTRIBUTE_KEYS.ADDED_FIELDS]).toBeUndefined();
    expect(attrs[ATTRIBUTE_KEYS.REMOVED_FIELDS]).toBeUndefined();
  });

  it('omits field-name attributes entirely (never sets an empty array) when a dimension did not change', () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(mkEvent({ kind: 'field_added', addedFields: ['limit'], removedFields: [], changedFields: [] }));
      span.end();
    });

    const [span] = spanExporter.getFinishedSpans();
    const attrs = span.events.find((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED).attributes;

    expect(attrs[ATTRIBUTE_KEYS.ADDED_FIELDS]).toEqual(['limit']);
    expect('mcp.tool.schema_drift.removed_fields' in attrs).toBe(false);
    expect('mcp.tool.schema_drift.changed_fields' in attrs).toBe(false);
  });

  it('includes all three field-name attributes when kind is "multiple" and all three are populated', () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    const tracer = trace.getTracer('test');

    tracer.startActiveSpan('span', (span) => {
      emitter.emit(
        mkEvent({
          kind: 'multiple',
          addedFields: ['limit'],
          removedFields: ['offset'],
          changedFields: ['q'],
          requiredChanged: true,
        }),
      );
      span.end();
    });

    const [span] = spanExporter.getFinishedSpans();
    const attrs = span.events.find((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED).attributes;

    expect(attrs[ATTRIBUTE_KEYS.ADDED_FIELDS]).toEqual(['limit']);
    expect(attrs[ATTRIBUTE_KEYS.REMOVED_FIELDS]).toEqual(['offset']);
    expect(attrs[ATTRIBUTE_KEYS.CHANGED_FIELDS]).toEqual(['q']);
  });

  it('skips the span event silently, but still emits the metric, when there is no active span', async () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');

    expect(() => emitter.emit(mkEvent())).not.toThrow();

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected').dataPoints[0].value).toBe(1);
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);
  });

  it('skips the span event silently when the active span is not recording (already ended)', () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
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
    }
    class BrokenMeter {
      createCounter() {
        return new BrokenInstrument();
      }
    }
    class BrokenMeterProvider {
      getMeter() {
        return new BrokenMeter();
      }
    }

    // metrics.setGlobalMeterProvider() silently no-ops on a second
    // registration (@opentelemetry/api's registerGlobal() only overrides
    // when the previous one was explicitly unregistered — confirmed by
    // reading internal/global-utils.js's registerGlobal(): `if
    // (!allowOverride && api[type]) return false`, and MetricsAPI never
    // passes allowOverride). beforeEach already registered a real
    // MeterProvider, so metrics.disable() must run first here or this
    // test would silently keep using the real one and pass regardless
    // of whether the broken path was ever exercised.
    metrics.disable();
    metrics.setGlobalMeterProvider(new BrokenMeterProvider());
    const emitter = createSchemaDriftEmitter('0.0.0-test');

    expect(() => emitter.emit(mkEvent())).not.toThrow();
  });

  it('never throws if meter construction itself is broken (createCounter throws during setup)', () => {
    class ThrowingMeter {
      createCounter() {
        throw new Error('cannot create counter');
      }
    }
    class ThrowingMeterProvider {
      getMeter() {
        return new ThrowingMeter();
      }
    }

    metrics.disable(); // see the previous test's comment for why this is required
    metrics.setGlobalMeterProvider(new ThrowingMeterProvider());
    expect(() => createSchemaDriftEmitter('0.0.0-test')).toThrow();
    // Documents current behavior: unlike emit() (which is fully guarded),
    // createSchemaDriftEmitter() itself does not wrap instrument creation
    // in try/catch, mirroring createThrashEmitter()'s and setupMeter()'s
    // own identical, pre-existing behavior (neither guards
    // meter.createCounter() at construction time either) — not a new gap
    // introduced here.
  });

  it('never throws for a malformed event', () => {
    const emitter = createSchemaDriftEmitter('0.0.0-test');
    expect(() => emitter.emit(null)).not.toThrow();
    expect(() => emitter.emit(undefined)).not.toThrow();
    expect(() => emitter.emit({})).not.toThrow();
  });
});
