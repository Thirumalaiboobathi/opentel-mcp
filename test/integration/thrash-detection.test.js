import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, metrics, diag } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { ATTR_GEN_AI_TOOL_NAME } from '../../src/attributes.js';
import { SPAN_EVENT_NAME_LOOP_DETECTED, ATTR_MCP_LOOP_LENGTH } from '../../src/thrash/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own (see test/instrument.fingerprint.test.js). */
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

// Static text (no UUID/timestamp) so computeFingerprint() produces the
// same mcp.failure.fingerprint on every call — required for the same
// (session, tool, fingerprint) key to accumulate in ThrashDetector.
const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };
const SUCCESS_RESULT = { content: [{ type: 'text', text: 'ok' }] };

/** Registers one handler whose outcome is controlled by `state.failing`. */
function registerToggleableTool(server, state) {
  server.setRequestHandler(CallToolRequestSchema, async () => (state.failing ? FAILING_RESULT : SUCCESS_RESULT));
}

/**
 * Minimal fake Transport satisfying Protocol#connect()'s actual runtime
 * requirements (see @modelcontextprotocol/sdk/dist/esm/shared/protocol.js:
 * assigns onclose/onerror/onmessage, awaits start()) without any real I/O
 * — no stdin/stdout, no open sockets, nothing that could keep the test
 * process alive. Deliberately has NO `sessionId` property, matching real
 * StdioServerTransport's shape (see server/stdio.d.ts) — that absence is
 * exactly what src/instrument.js's isSingleConnectionTransport() checks
 * for.
 */
function fakeStdioShapedTransport() {
  return { start: async () => {}, send: async () => {}, close: async () => {} };
}

/** Same as above, but WITH a `sessionId` getter — shaped like StreamableHTTPServerTransport/SSEServerTransport. */
function fakeSessionOrientedTransport() {
  return { start: async () => {}, send: async () => {}, close: async () => {}, get sessionId() { return undefined; } };
}

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  // Deliberately NOT passing `contextManager: null` here, unlike this
  // repo's other instrument.js integration tests: those only ever read
  // the span handed to them as startActiveSpan()'s callback argument, but
  // src/thrash/emitter.js's span event uses trace.getActiveSpan() (see
  // its docblock), which only resolves correctly with a real context
  // manager registered — the same as actual production use
  // (NodeTracerProvider.register() with no override installs the default
  // one).
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

describe('Agent Thrash Detection integration (public instrumentMcpServer() entry point)', () => {
  it('fires mcp.tool.loop.detected (metric + span event) on the 3rd consecutive same-fingerprint failure', async () => {
    const server = createServer();
    // assumeSingleSession: true — invokeToolCall() below never calls
    // server.connect(), so the transport is undeterminable (see the
    // "sessionId fallback resolution" describe block below for the
    // default-safe behavior in that case, which is now to skip rather
    // than guess). This test is about loop *detection*, not session
    // resolution, so it opts in explicitly instead.
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    registerToggleableTool(server, { failing: true });

    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
    expect(detected.dataPoints[0].attributes).toEqual({ [ATTR_GEN_AI_TOOL_NAME]: 'validate' });

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    const loopEvents = spans[2].events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED);
    expect(loopEvents).toHaveLength(1);
    expect(loopEvents[0].attributes[ATTR_MCP_LOOP_LENGTH]).toBe(3);
    // The first two calls' spans carry no loop event — only the 3rd crossed the threshold.
    expect(spans[0].events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED)).toHaveLength(0);
    expect(spans[1].events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED)).toHaveLength(0);
  });

  it('restarts the loop counter after a passing call breaks it', async () => {
    const server = createServer();
    // assumeSingleSession: true — see the comment on the test above.
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    const state = { failing: true };
    registerToggleableTool(server, state);

    // 2 failures — one short of the default threshold of 3.
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });

    let { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    // A passing call breaks the loop (clearOnSuccess).
    state.failing = false;
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    state.failing = true;

    // If the old count had survived, this next failure would be the 3rd
    // overall and would trigger detection here. It must not.
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    ({ resourceMetrics } = await metricReader.collect());
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    await invokeToolCall(server, { name: 'validate', arguments: {} });
    ({ resourceMetrics } = await metricReader.collect());
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    // 3rd failure of the new episode — the counter restarted, so this is
    // where detection actually fires.
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    ({ resourceMetrics } = await metricReader.collect());
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });
});

describe('sessionId fallback resolution', () => {
  it('stdio-shaped server, no sessionId ever -> fallback used, loop detected', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' }); // default config — no assumeSingleSession opt-in
    registerToggleableTool(server, { failing: true });
    await server.connect(fakeStdioShapedTransport());

    await invokeToolCall(server, { name: 'validate', arguments: {} }); // extra.sessionId undefined throughout
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });

  it('two interleaved clients with distinct sessionIds -> two independent loops', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });

    const clientA = { requestId: 1, sessionId: 'client-a' };
    const clientB = { requestId: 2, sessionId: 'client-b' };

    // Interleaved: A, B, A, B, A, B — each client reaches its own 3rd failure on its last call.
    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientA);
    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientB);
    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientA);
    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientB);
    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientA); // client-a's 3rd
    let { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(1);

    await invokeToolCall(server, { name: 'validate', arguments: {} }, clientB); // client-b's 3rd
    ({ resourceMetrics } = await metricReader.collect());
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(2);
  });

  it('a call with no sessionId after a real one was seen is skipped — no merge, no crash', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });

    // A real sessionId is observed once — this permanently marks the server session-aware.
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 1, sessionId: 'client-a' });

    // Now a call with no sessionId at all (e.g. a stray/misconfigured client). Must not throw,
    // and must not be merged into any shared key — repeating this many times must never fire.
    for (let i = 0; i < 10; i++) {
      await expect(invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 2 + i })).resolves.toBeDefined();
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    // client-a's own tracking is unaffected by the sessionless calls in
    // between: this is its 2nd and 3rd failure (the 1st was before the
    // sessionless calls above), so the 3rd should cross the threshold.
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 99, sessionId: 'client-a' });
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 100, sessionId: 'client-a' });
    const { resourceMetrics: after } = await metricReader.collect();
    expect(findMetric(after, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(1);
  });

  it('assumeSingleSession: true with no sessionId -> fallback used', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    registerToggleableTool(server, { failing: true });
    // No server.connect() at all — transport stays undeterminable; assumeSingleSession must still permit the fallback.

    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected').dataPoints[0].value).toBe(1);
  });

  it('assumeSingleSession: false, transport undeterminable, no sessionId -> detection skipped silently, zero emissions', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' }); // assumeSingleSession defaults to false
    registerToggleableTool(server, { failing: true });
    // No server.connect() — transport is undeterminable, same as this repo's whole test harness normally is.

    for (let i = 0; i < 10; i++) {
      await expect(invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: i })).resolves.toBeDefined();
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
    expect(spanExporter.getFinishedSpans().flatMap((s) => s.events)).toEqual([]);
  });

  it('a session-oriented transport (has a sessionId getter) does not get the fallback either', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: true });
    await server.connect(fakeSessionOrientedTransport());

    for (let i = 0; i < 5; i++) {
      await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: i }); // no extra.sessionId
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });

  it('warns via diag.warn exactly once per instrumentMcpServer() call, across many fallback-path calls', async () => {
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' }); // default config — fallback permitted via auto-detected stdio
    registerToggleableTool(server, { failing: false });
    await server.connect(fakeStdioShapedTransport());

    // Many calls, all on the fallback path (no extra.sessionId, ever).
    for (let i = 0; i < 20; i++) {
      await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/single-connection transport detected/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/false-positive/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/once per instrumentMcpServer\(\) call/);

    warnSpy.mockRestore();
  });

  it('warns with the assumeSingleSession reason when the transport is undeterminable', async () => {
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    registerToggleableTool(server, { failing: false });
    // No server.connect() — transport stays undeterminable.

    await invokeToolCall(server, { name: 'validate', arguments: {} });
    await invokeToolCall(server, { name: 'validate', arguments: {} });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/transport undeterminable, opted in via assumeSingleSession: true/);

    warnSpy.mockRestore();
  });

  it('does not warn at all when detection never takes the fallback path', async () => {
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerToggleableTool(server, { failing: false });

    // Always a real sessionId — never triggers the fallback branch.
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 1, sessionId: 'client-a' });
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 2, sessionId: 'client-a' });

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
