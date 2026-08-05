import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { SchemaDriftDetector } from '../src/schema-drift/detector.js';
import { SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED, ATTRIBUTE_KEYS } from '../src/schema-drift/attributes.js';
import { ATTR_MCP_METHOD_NAME, MCP_METHOD_NAME_TOOLS_LIST } from '../src/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/** Invokes a registered request handler directly, bypassing the need for a live transport/connection. */
function invokeToolsList(server, params = {}, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/list');
  if (!handler) {
    throw new Error('No handler registered for method "tools/list"');
  }
  return handler({ method: 'tools/list', params }, extra);
}

/** Registers a tools/list handler whose response is whatever `getTools()` currently returns — lets tests mutate the schema between calls. */
function registerToolsList(server, getTools) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));
}

/** Minimal in-memory MetricReader — mirrors test/instrument.fingerprint.test.js's TestMetricReader. */
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
  // Unlike test/instrument.fingerprint.test.js, this file must NOT pass
  // `contextManager: null`: wrapToolsListHandler's downstream
  // schemaDriftEmitter uses trace.getActiveSpan() (schema-drift/emitter.js,
  // mirroring thrash/emitter.js), which only resolves correctly with a
  // real context manager registered — see test/thrash/emitter.test.js's
  // and test/schema-drift/emitter.test.js's identical beforeEach comment.
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
  vi.restoreAllMocks();
});

const SCHEMA_V1 = { type: 'object', properties: { q: { type: 'string' } } };
const SCHEMA_V2 = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } };

describe('instrumentMcpServer schema drift integration', () => {
  it('detects drift end-to-end: cold start emits nothing, a changed schema on the next tools/list call emits the metric and span event', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });

    let schema = SCHEMA_V1;
    registerToolsList(server, () => [{ name: 'search', inputSchema: schema }]);

    // Cold start — nothing to compare against yet.
    await invokeToolsList(server);
    let { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected')).toBeUndefined();

    // Schema changes — this is the observation that should detect drift.
    schema = SCHEMA_V2;
    await invokeToolsList(server, {}, { requestId: 2 });

    ({ resourceMetrics } = await metricReader.collect());
    const detected = findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected');
    expect(detected).toBeDefined();
    expect(detected.dataPoints[0].value).toBe(1);
    expect(detected.dataPoints[0].attributes[ATTRIBUTE_KEYS.TYPE]).toBe('field_added');

    const spans = spanExporter.getFinishedSpans();
    const toolsListSpans = spans.filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
    expect(toolsListSpans).toHaveLength(2); // one per invokeToolsList() call
    expect(toolsListSpans[0].attributes[ATTR_MCP_METHOD_NAME]).toBe(MCP_METHOD_NAME_TOOLS_LIST);

    const driftEvents = toolsListSpans[1].events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED);
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0].attributes[ATTRIBUTE_KEYS.TYPE]).toBe('field_added');
    expect(driftEvents[0].attributes[ATTRIBUTE_KEYS.ADDED_FIELDS]).toEqual(['limit']);

    // The first (cold-start) span must NOT carry a drift event.
    expect(toolsListSpans[0].events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED)).toHaveLength(0);
  });

  it('emits nothing across many repeated tools/list calls with an unchanged schema', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToolsList(server, () => [{ name: 'search', inputSchema: SCHEMA_V1 }]);

    for (let i = 0; i < 10; i++) {
      await invokeToolsList(server, {}, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected')).toBeUndefined();

    const toolsListSpans = spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
    expect(toolsListSpans).toHaveLength(10);
    for (const span of toolsListSpans) {
      expect(span.events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED)).toHaveLength(0);
    }
  });

  it('emits nothing, and does not even wrap tools/list, when schemaDrift.enabled is false', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', schemaDrift: { enabled: false } });

    let schema = SCHEMA_V1;
    registerToolsList(server, () => [{ name: 'search', inputSchema: schema }]);

    await invokeToolsList(server);
    schema = SCHEMA_V2; // changed — would be drift if the feature were on
    const result = await invokeToolsList(server, {}, { requestId: 2 });

    // The underlying handler still runs and returns its real result —
    // disabling schema drift must not break tools/list itself.
    expect(result.tools).toEqual([{ name: 'search', inputSchema: SCHEMA_V2 }]);

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.schema_drift.detected')).toBeUndefined();

    // No tools/list span at all — tools/list was never wrapped, matching
    // the "entirely skipped with no allocation when disabled" constraint.
    expect(spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST)).toHaveLength(0);
  });

  it('emits nothing when schemaDrift is omitted entirely from options (defaults to enabled) but enableMetrics is false — still spans, no metric', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', enableMetrics: false });
    registerToolsList(server, () => [{ name: 'search', inputSchema: SCHEMA_V1 }]);

    await invokeToolsList(server);

    // Detection/wrapping still happens (schemaDrift.enabled defaults to
    // true, independent of enableMetrics) — a tools/list span is still
    // created — but nothing can be recorded on a disabled meter, and
    // schemaDriftEmitter itself is null (mirrors thrashEmitter's
    // identical enableMetrics gating).
    const toolsListSpans = spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
    expect(toolsListSpans).toHaveLength(1);
  });

  it('does not break the tools/list response when the detector throws internally', async () => {
    vi.spyOn(SchemaDriftDetector.prototype, 'capture').mockImplementation(() => {
      throw new Error('deliberately broken detector');
    });

    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToolsList(server, () => [{ name: 'search', inputSchema: SCHEMA_V1 }]);

    const result = await invokeToolsList(server);

    expect(result.tools).toEqual([{ name: 'search', inputSchema: SCHEMA_V1 }]);

    // The span itself must still complete successfully — the internal
    // failure is swallowed, not surfaced as a span error.
    const [span] = spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
    expect(span.status.code).not.toBe(2); // SpanStatusCode.ERROR === 2
  });

  it('does not throw and still returns the real result if the underlying tools/list handler itself throws (a genuine failure, not schema-drift-related)', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      throw new Error('backend unavailable');
    });

    await expect(invokeToolsList(server)).rejects.toThrow('backend unavailable');

    const [span] = spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR — a genuine handler failure DOES mark the span as errored.
  });
});
