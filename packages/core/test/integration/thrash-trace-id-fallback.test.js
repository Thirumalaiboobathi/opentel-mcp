import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { SPAN_EVENT_NAME_LOOP_DETECTED, ATTR_MCP_LOOP_SESSION_ID } from '../../src/thrash/attributes.js';

/**
 * ADR 018 (docs/adr/018-trace-id-as-thrash-fallback.md): step 2.5 of
 * resolveThrashSessionId() — a validly-extracted REMOTE parent's trace id
 * used as a thrash-detection session-id candidate, reached only when no
 * real session id has ever been observed, and only before step 3's
 * UUID/skip fallback. Mirrors the fixture setup of
 * test/integration/thrash-detection.test.js (thrash mechanics) and
 * test/integration/trace-context-propagation.test.js (traceparent
 * construction).
 */

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_PARENT_ID = '00f067aa0ba902b7';
const OTHER_TRACE_ID = '1234567890abcdef1234567890abcdef';
const OTHER_PARENT_ID = 'fedcba0987654321';

function traceparent(traceId = VALID_TRACE_ID, parentId = VALID_PARENT_ID, flags = '01') {
  return `00-${traceId}-${parentId}-${flags}`;
}

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

// Static text (no UUID/timestamp) so computeFingerprint() produces the same
// mcp.failure.fingerprint on every call — required for the same (session,
// tool, fingerprint) key to accumulate in ThrashDetector.
const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };
const SUCCESS_RESULT = { content: [{ type: 'text', text: 'ok' }] };

function registerToggleableTool(server, state) {
  server.setRequestHandler(CallToolRequestSchema, async () => (state.failing ? FAILING_RESULT : SUCCESS_RESULT));
}

/**
 * Matches thrash-detection.test.js's fakeStdioShapedTransport(): no
 * `sessionId` property, so isSingleConnectionTransport() reports true —
 * used by the hasSeenRealSessionId test below to prove step 3's UUID
 * fallback still works after a step 2.5 call on the same server.
 */
function fakeStdioShapedTransport() {
  return { start: async () => {}, send: async () => {}, close: async () => {} };
}

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  traceProvider.register();

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

describe('Agent Thrash Detection — trace id fallback tier (ADR 018)', () => {
  it('a call with a validly extracted remote parent uses that trace id, and repeated failures within one trace accumulate to threshold', async () => {
    const server = createServer();
    // No assumeSingleSession, no server.connect() — transport stays
    // undeterminable, so step 3 would skip on its own. Detection here can
    // only be coming from step 2.5.
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });

    const params = { name: 'validate', arguments: {}, _meta: { traceparent: traceparent() } };
    await invokeToolCall(server, params);
    await invokeToolCall(server, params);
    await invokeToolCall(server, params);

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);

    const spans = spanExporter.getFinishedSpans();
    const loopEvents = spans[2].events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED);
    expect(loopEvents).toHaveLength(1);
    // The session-id candidate used was the extracted parent's trace id.
    expect(loopEvents[0].attributes[ATTR_MCP_LOOP_SESSION_ID]).toBe(VALID_TRACE_ID);
  });

  it('a ROOT span (no _meta.traceparent) does NOT produce a session id — regression test for the ADR\'s trap', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' }); // no assumeSingleSession, transport undeterminable
    registerToggleableTool(server, { failing: true });

    // No _meta at all -> every call's span is a root span. If
    // resolveThrashSessionId() ever read span.spanContext().traceId
    // unconditionally instead of gating on isRemote, this would silently
    // "detect" using a fresh random trace id every call — which never
    // matches the previous call's, so it would never actually accumulate,
    // but it also would never look like "skipped" from the outside except
    // by this exact behavior: no detection ever fires, no matter how many
    // failures. That's indistinguishable from correct skip behavior here,
    // which is exactly why "detection never fires" is the correct
    // assertion — see the next test for the gate at the unit level.
    for (let i = 0; i < 10; i++) {
      await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
    expect(spanExporter.getFinishedSpans().flatMap((s) => s.events)).toEqual([]);
  });

  it('malformed _meta degrades to today\'s behavior (no detection)', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });

    const badMetas = [{ traceparent: 'garbage' }, { traceparent: `00-${'0'.repeat(32)}-${VALID_PARENT_ID}-01` }, { traceparent: 12345 }];
    for (const [i, _meta] of badMetas.entries()) {
      await invokeToolCall(server, { name: 'validate', arguments: {}, _meta }, { requestId: i });
    }
    // Repeat the same malformed traceparent enough times to cross the
    // threshold if it were (incorrectly) being treated as a stable id.
    for (let i = 0; i < 3; i++) {
      await invokeToolCall(server, { name: 'validate', arguments: {}, _meta: { traceparent: 'garbage' } }, { requestId: 100 + i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });

  it('a real extra.sessionId still wins even when a trace id is also present', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });

    // Same real sessionId every call, but a DIFFERENT trace id each time —
    // if trace id were incorrectly taking precedence, these would never
    // accumulate into one group.
    await invokeToolCall(
      server,
      { name: 'validate', arguments: {}, _meta: { traceparent: traceparent(VALID_TRACE_ID) } },
      { requestId: 1, sessionId: 'client-a' },
    );
    await invokeToolCall(
      server,
      { name: 'validate', arguments: {}, _meta: { traceparent: traceparent(OTHER_TRACE_ID, OTHER_PARENT_ID) } },
      { requestId: 2, sessionId: 'client-a' },
    );
    await invokeToolCall(
      server,
      { name: 'validate', arguments: {}, _meta: { traceparent: traceparent(VALID_TRACE_ID) } },
      { requestId: 3, sessionId: 'client-a' },
    );

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);

    const spans = spanExporter.getFinishedSpans();
    const loopEvents = spans[2].events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED);
    expect(loopEvents[0].attributes[ATTR_MCP_LOOP_SESSION_ID]).toBe('client-a');
  });

  it('hasSeenRealSessionId is not set by the trace-id path — a later step-3-eligible call still gets the UUID fallback', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });
    // Structurally single-connection transport (no sessionId property) —
    // step 3's isSingleConnectionTransport() check would permit the UUID
    // fallback for a later session-less, traceparent-less call.
    await server.connect(fakeStdioShapedTransport());

    // Step 2.5 fires here: no sessionId, a valid traceparent.
    await invokeToolCall(server, { name: 'validate', arguments: {}, _meta: { traceparent: traceparent() } }, { requestId: 1 });

    // If the call above had incorrectly set
    // thrashSessionState.hasSeenRealSessionId, every one of these calls
    // (no sessionId, no traceparent) would be skipped outright by step 2
    // instead of reaching step 3's UUID fallback — detection would never
    // fire no matter how many failures followed.
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 2 });
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 3 });
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 4 });

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });

  it('two different traces produce independent detection state', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' }); // no assumeSingleSession — only step 2.5 can produce a session id here
    registerToggleableTool(server, { failing: true });

    const traceA = { name: 'validate', arguments: {}, _meta: { traceparent: traceparent(VALID_TRACE_ID, VALID_PARENT_ID) } };
    const traceB = { name: 'validate', arguments: {}, _meta: { traceparent: traceparent(OTHER_TRACE_ID, OTHER_PARENT_ID) } };

    // Interleaved: A, B, A, B, A, B — each trace reaches its own 3rd failure on its last call.
    await invokeToolCall(server, traceA, { requestId: 1 });
    await invokeToolCall(server, traceB, { requestId: 2 });
    await invokeToolCall(server, traceA, { requestId: 3 });
    await invokeToolCall(server, traceB, { requestId: 4 });
    await invokeToolCall(server, traceA, { requestId: 5 }); // trace A's 3rd
    let { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(1);

    await invokeToolCall(server, traceB, { requestId: 6 }); // trace B's 3rd
    ({ resourceMetrics } = await metricReader.collect());
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(2);
  });
});
