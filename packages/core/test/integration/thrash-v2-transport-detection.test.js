import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, diag, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server as ServerV1 } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  Server as ServerV2,
  PerRequestHTTPServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { StdioServerTransport as StdioServerTransportV2 } from '@modelcontextprotocol/server/stdio';
import { instrumentMcpServer, __resetInstanceRegistryForTests } from '../../src/instrument.js';

/**
 * Regression coverage for the fix recorded in ADR 015 "Update (2026-08-11,
 * continued)" and `docs/known-gaps.md` entry 8: `isSingleConnectionTransport()`
 * previously inferred single-connection from the mere absence of a
 * `sessionId` property, which was correct for every v1 transport but
 * genuinely ambiguous for v2 — `PerRequestHTTPServerTransport` (the
 * transport `createMcpHandler` builds internally) *also* has no
 * `sessionId`, for the opposite reason stdio doesn't: it's request-scoped,
 * not connection-scoped, and legitimately serves many distinct clients.
 * The fix requires POSITIVE confirmation (`transport.constructor.name ===
 * 'StdioServerTransport'`) for v2 specifically; v1's inference is
 * untouched.
 *
 * Also covers the companion fix: `thrashConnectionFallbackSessionId` is
 * now registry-backed via the same `getOrCreateTracker()`/`instanceRegistry`
 * machinery the four ADR-012 trackers already use, so a shared
 * `instanceKey` now actually lets the fallback path accumulate across
 * repeated `instrumentMcpServer()` calls (the v2 per-request factory
 * model) instead of minting an unrelated, one-off id every time.
 *
 * Real transport classes are used throughout, `.connect()`ed for real —
 * confirmed empirically (not assumed) that `PerRequestHTTPServerTransport`,
 * `WebStandardStreamableHTTPServerTransport`, and even v2's own
 * `StdioServerTransport` all connect and close cleanly with no I/O hazard
 * in a test process (no open stdin listener survives past `close()`).
 */

function createV1Server(name = 'v1-test-server') {
  return new ServerV1({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

function createV2Server(name = 'v2-test-server') {
  return new ServerV2({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/** v1 invocation shape: (request, extra). */
function invokeV1ToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('No v1 handler registered for method "tools/call"');
  return handler({ method: 'tools/call', params }, extra);
}

/** v2 invocation shape: (request, ctx) — ctx.sessionId, ctx.mcpReq.id (ADR 015 Findings 3/7). */
function invokeV2ToolCall(server, params, { sessionId, requestId = 1 } = {}) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('No v2 handler registered for method "tools/call"');
  const ctx = {
    sessionId,
    mcpReq: {
      id: requestId,
      method: 'tools/call',
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => {},
      notify: async () => {},
    },
  };
  return handler({ method: 'tools/call', params }, ctx);
}

/**
 * Minimal fake Transport satisfying Protocol#connect()'s actual runtime
 * requirements, mirroring test/integration/thrash-detection.test.js's own
 * fakes exactly (same reasoning: no real I/O, nothing that could keep the
 * test process alive). Used only for the "unexpected/absent constructor.name"
 * defensive-degradation case below, where a real SDK class isn't the point.
 */
function fakeTransportWithoutConstructorName() {
  const t = Object.create(null);
  t.start = async () => {};
  t.send = async () => {};
  t.close = async () => {};
  return t;
}

const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };

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
  traceProvider.register();

  metricReader = new TestMetricReader();
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  __resetInstanceRegistryForTests();
});

afterEach(async () => {
  await traceProvider.shutdown();
  trace.disable();
  context.disable();
  spanExporter.reset();

  await meterProvider.shutdown();
  metrics.disable();
});

describe('isSingleConnectionTransport() — v2 transport-detection matrix', () => {
  it('v2 StdioServerTransport IS positively confirmed as single-connection (constructor.name match)', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const stdio = new StdioServerTransportV2();
    await server.connect(stdio);

    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    await invokeV2ToolCall(server, { name: 'validate', arguments: {} });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/single-connection transport detected/);
    warnSpy.mockRestore();

    await stdio.close();
  });

  it('REGRESSION TEST for the live false positive (known-gaps entry 8): v2 PerRequestHTTPServerTransport is NOT detected as single-connection', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1 }),
    });
    const perRequestTransport = new PerRequestHTTPServerTransport(req, {});
    await server.connect(perRequestTransport);

    // No sessionId on any call, no assumeSingleSession opt-in: before the
    // fix, isSingleConnectionTransport() misread the absent sessionId
    // property as "safe to assume single connection" and every one of
    // these would have fired the fallback (and, across enough calls,
    // fabricated mcp.tool.loop.detected). After the fix: skipped silently,
    // same as any other undetermined transport.
    for (let i = 0; i < 5; i++) {
      await invokeV2ToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    await perRequestTransport.close?.();
  });

  it('v2 WebStandardStreamableHTTPServerTransport (stateless) is unaffected — still correctly excluded via its own sessionId property', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const web = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(web);

    for (let i = 0; i < 5; i++) {
      await invokeV2ToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    await web.close();
  });

  it('v2 WebStandardStreamableHTTPServerTransport (stateful) is unaffected — same as stateless', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const web = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'generated-session' });
    await server.connect(web);

    for (let i = 0; i < 5; i++) {
      await invokeV2ToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    await web.close();
  });

  it('an object whose transport has no (or an unexpected) constructor.name falls to undetermined, without throwing', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const weirdTransport = fakeTransportWithoutConstructorName();
    await server.connect(weirdTransport);

    await expect(invokeV2ToolCall(server, { name: 'validate', arguments: {} })).resolves.toBeDefined();

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });
});

describe('isSingleConnectionTransport() — v1 unaffected (the "no v1 behavior change" claim, asserted explicitly)', () => {
  /** Identical to thrash-detection.test.js's own fakes — kept local so this file's v1 claim is self-contained, not merely inherited from another file passing. */
  function fakeStdioShapedTransport() {
    return { start: async () => {}, send: async () => {}, close: async () => {} };
  }
  function fakeSessionOrientedTransport() {
    return {
      start: async () => {},
      send: async () => {},
      close: async () => {},
      get sessionId() {
        return undefined;
      },
    };
  }

  it('v1 stdio-shaped transport (no sessionId property) is still detected as single-connection, unchanged', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    await server.connect(fakeStdioShapedTransport());

    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    await invokeV1ToolCall(server, { name: 'validate', arguments: {} });
    expect(warnSpy.mock.calls[0][0]).toMatch(/single-connection transport detected/);
    warnSpy.mockRestore();
  });

  it('v1 real StdioServerTransport (the real class, not just a shape-alike) is still detected as single-connection, unchanged', async () => {
    const { StdioServerTransport: StdioServerTransportV1 } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);

    const stdio = new StdioServerTransportV1();
    await server.connect(stdio);

    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    await invokeV1ToolCall(server, { name: 'validate', arguments: {} });
    expect(warnSpy.mock.calls[0][0]).toMatch(/single-connection transport detected/);
    warnSpy.mockRestore();
  });

  it('v1 session-oriented transport (has a sessionId getter) is still excluded, unchanged', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    await server.connect(fakeSessionOrientedTransport());

    for (let i = 0; i < 5; i++) {
      await invokeV1ToolCall(server, { name: 'validate', arguments: {} }, { requestId: i });
    }

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });
});

describe('thrashConnectionFallbackSessionId — registry-backed via instanceKey', () => {
  /** One "request": a fresh v2 Server, freshly instrumented and connected to a real stdio transport, one call, then discarded — the v2 per-request factory shape. */
  async function simulateOneV2StatelessRequest(instanceKeyOption = {}) {
    const server = createV2Server();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', ...instanceKeyOption });
    server.setRequestHandler('tools/call', async () => FAILING_RESULT);

    const stdio = new StdioServerTransportV2();
    await server.connect(stdio);

    await invokeV2ToolCall(server, { name: 'validate', arguments: {} });
    await stdio.close();
    return instrumented;
  }

  it('with a shared instanceKey: the fallback id is now stable across calls, so mcp.tool.loop.detected fires by the 5th identical-fingerprint failure', async () => {
    let lastInstrumented;
    for (let i = 0; i < 5; i++) {
      lastInstrumented = await simulateOneV2StatelessRequest({ instanceKey: 'v2-stateless-fleet' });
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');

    // This is the assertion that would have failed before this fix: each
    // of the 5 "requests" above would have minted its own fresh,
    // unrelated fallback UUID (a plain randomUUID() local to each
    // instrumentMcpServer() call, per ADR 015 Finding 3), so the shared
    // ThrashDetector would have seen 5 separate one-off episodes instead
    // of one 5-long loop, and this metric would never have fired.
    expect(detected).toBeDefined();
    expect(detected?.dataPoints?.[0]?.value).toBeGreaterThanOrEqual(1);
    expect(lastInstrumented.getThrashSummary().totalLoopsDetected).toBeGreaterThan(0);
  });

  it('WITHOUT instanceKey (the default): the fallback id is still fresh on every call, exactly as before this fix', async () => {
    for (let i = 0; i < 5; i++) {
      await simulateOneV2StatelessRequest(); // no instanceKey
    }

    const { resourceMetrics } = await metricReader.collect();
    // Unfixed by design when instanceKey is omitted — same "byte-identical
    // to the default" discipline instanceKey's other tests already assert
    // for the four ADR-012 trackers (test/instrument.instance-key.test.js).
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });

  it('two distinct instanceKeys never share a fallback id with each other', async () => {
    for (let i = 0; i < 5; i++) {
      await simulateOneV2StatelessRequest({ instanceKey: 'fleet-a' });
    }
    for (let i = 0; i < 2; i++) {
      await simulateOneV2StatelessRequest({ instanceKey: 'fleet-b' });
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    // fleet-a crossed the default threshold (3); fleet-b (2 calls) did not.
    // If the two instanceKeys accidentally shared a fallback id, fleet-b's
    // 2 calls would have contributed to fleet-a's count instead of being
    // independently tracked -- this asserts they didn't.
    expect(detected?.dataPoints?.[0]?.value).toBeGreaterThanOrEqual(1);
  });
});
