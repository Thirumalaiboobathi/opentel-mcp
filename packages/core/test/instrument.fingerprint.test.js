import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/** Invokes a registered request handler directly, bypassing the need for a live transport/connection. */
function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('No handler registered for method "tools/call"');
  }
  return handler({ method: 'tools/call', params }, extra);
}

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

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  traceProvider.register({ contextManager: null, propagator: null });

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

function registerFlakyAndBroken(server) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'flaky') {
      throw new Error(`user ${randomUUID()} not found`);
    }
    if (request.params.name === 'broken') {
      return { isError: true, content: [{ type: 'text', text: `id ${randomUUID()} rejected` }] };
    }
    return { content: [] };
  });
}

describe('instrumentMcpServer fingerprinting integration', () => {
  it('produces the same mcp.failure.fingerprint across 10 calls to a thrown-error tool', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    for (let i = 0; i < 10; i++) {
      await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});
    }

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(10);
    const fingerprints = spans.map((s) => s.attributes[ATTRIBUTE_KEYS.FINGERPRINT]);
    expect(new Set(fingerprints).size).toBe(1);
    expect(fingerprints[0]).toBeTruthy();
  });

  it('produces the same mcp.failure.fingerprint across 10 calls to a tool-level-error tool', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    for (let i = 0; i < 10; i++) {
      await invokeToolCall(server, { name: 'broken', arguments: {} });
    }

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(10);
    const fingerprints = spans.map((s) => s.attributes[ATTRIBUTE_KEYS.FINGERPRINT]);
    expect(new Set(fingerprints).size).toBe(1);
    expect(fingerprints[0]).toBeTruthy();
  });

  it('gives "flaky" and "broken" different fingerprints', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});
    await invokeToolCall(server, { name: 'broken', arguments: {} });

    const [flakySpan, brokenSpan] = spanExporter.getFinishedSpans();
    expect(flakySpan.attributes[ATTRIBUTE_KEYS.FINGERPRINT]).not.toBe(
      brokenSpan.attributes[ATTRIBUTE_KEYS.FINGERPRINT],
    );
  });

  it('sets mcp.failure.origin to "thrown" for flaky and "tool_error" for broken', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});
    await invokeToolCall(server, { name: 'broken', arguments: {} });

    const [flakySpan, brokenSpan] = spanExporter.getFinishedSpans();
    expect(flakySpan.attributes[ATTRIBUTE_KEYS.ORIGIN]).toBe('thrown');
    expect(brokenSpan.attributes[ATTRIBUTE_KEYS.ORIGIN]).toBe('tool_error');
  });

  it('classifies the flaky tool\'s plain Error as category "internal" (no classifier signal)', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});

    const [span] = spanExporter.getFinishedSpans();
    expect(span.attributes[ATTRIBUTE_KEYS.CATEGORY]).toBe('internal');
  });

  it('carries mcp.failure.category on the mcp.tool.errors counter', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});

    const { resourceMetrics } = await metricReader.collect();
    const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
    expect(errors.dataPoints[0].attributes[ATTRIBUTE_KEYS.CATEGORY]).toBe('internal');
  });

  it('carries mcp.failure.category on the mcp.tool.silent_failures counter', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerFlakyAndBroken(server);

    await invokeToolCall(server, { name: 'broken', arguments: {} });

    const { resourceMetrics } = await metricReader.collect();
    const silentFailures = findMetric(resourceMetrics, 'mcp.tool.silent_failures');
    expect(silentFailures.dataPoints[0].attributes[ATTRIBUTE_KEYS.CATEGORY]).toBe('internal');
  });

  describe('fingerprinting: false', () => {
    it('emits no mcp.failure.* span attributes and no mcp.failure.category metric attribute', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', fingerprinting: false });
      registerFlakyAndBroken(server);

      await invokeToolCall(server, { name: 'flaky', arguments: {} }).catch(() => {});
      await invokeToolCall(server, { name: 'broken', arguments: {} });

      const spans = spanExporter.getFinishedSpans();
      for (const span of spans) {
        for (const key of Object.values(ATTRIBUTE_KEYS)) {
          expect(span.attributes[key]).toBeUndefined();
        }
      }

      const { resourceMetrics } = await metricReader.collect();
      const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
      const silentFailures = findMetric(resourceMetrics, 'mcp.tool.silent_failures');
      expect(errors.dataPoints[0].attributes[ATTRIBUTE_KEYS.CATEGORY]).toBeUndefined();
      expect(silentFailures.dataPoints[0].attributes[ATTRIBUTE_KEYS.CATEGORY]).toBeUndefined();
    });
  });
});
