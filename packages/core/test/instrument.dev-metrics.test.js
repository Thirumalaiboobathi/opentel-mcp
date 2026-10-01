import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, context, metrics, diag } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer, __resetMeterProviderWarnedForTests } from '../src/instrument.js';

/**
 * Covers ADR 023 (v0.15.0): dev-mode metrics under setupNodeSdk: true.
 * These tests are about the WIRING (a MeterProvider gets registered,
 * printed to stderr, never overrides a pre-existing one) — not about
 * re-deriving each underlying feature's own triggering logic, which
 * already has exhaustive coverage elsewhere (test/metrics.test.js,
 * test/integration/thrash-detection.test.js, test/instrument.schema-drift.test.js,
 * test/cost/*.test.js).
 */

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('No handler registered for method "tools/call"');
  return handler({ method: 'tools/call', params }, extra);
}

function invokeToolsList(server, params = {}, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/list');
  if (!handler) throw new Error('No handler registered for method "tools/list"');
  return handler({ method: 'tools/list', params }, extra);
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

afterEach(async () => {
  trace.disable();
  context.disable();
  metrics.disable();
  __resetMeterProviderWarnedForTests();
  vi.restoreAllMocks();
});

describe('dev-mode metrics under setupNodeSdk: true (ADR 023)', () => {
  it('prints a compact stderr line for a silent failure, and writes nothing to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrLines = [];
    vi.spyOn(console, 'error').mockImplementation((line) => stderrLines.push(String(line)));

    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    }));

    await invokeToolCall(server, { name: 'fails', arguments: {} });
    // Forces a final metrics collect+export immediately, rather than
    // waiting for the real 5s dev export interval (ADR 023) — confirmed
    // against PeriodicExportingMetricReader's own source: shutdown()
    // calls onForceFlush() before clearing its interval timer.
    await instrumented.shutdown();

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(
      stderrLines.some((line) => line.includes('[opentel-mcp metrics] mcp.tool.silent_failures') && line.includes('= 1')),
    ).toBe(true);
  });

  it('drives all 12 known instruments through real feature triggers and sees each one printed to stderr', async () => {
    const stderrLines = [];
    vi.spyOn(console, 'error').mockImplementation((line) => stderrLines.push(String(line)));

    const server = createServer();
    const instrumented = instrumentMcpServer(server, {
      serviceName: 'svc',
      setupNodeSdk: true,
      // invokeToolCall()/invokeToolsList() below never call server.connect(),
      // so the transport is undeterminable — opt into thrash detection's
      // single-session fallback explicitly, same as the existing thrash
      // integration test does for the identical reason.
      thrashDetection: { assumeSingleSession: true },
    });

    const SUCCESS_RESULT = { content: [{ type: 'text', text: 'ok' }] };
    // Static text (no UUID/timestamp) so computeFingerprint() produces the
    // same mcp.failure.fingerprint on every call, required for thrash
    // detection to accumulate against one (session, tool, fingerprint) key.
    const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "x"' }] };
    // Recognized by defaultExtractor (src/cost/extractor.js) and priced
    // against DEFAULT_PRICING's 'claude-sonnet-5' entry (src/cost/pricing.js).
    const COSTED_RESULT = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-5',
    };

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'costed') return COSTED_RESULT;
      if (request.params.name === 'flaky') return FAILING_RESULT;
      if (request.params.name === 'throws') throw new Error('boom');
      return SUCCESS_RESULT;
    });

    let tools = [{ name: 'a', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }];
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    // mcp.tool.calls, mcp.tool.duration (success)
    await invokeToolCall(server, { name: 'ok', arguments: {} });
    // mcp.tool.errors, mcp.tool.duration (error)
    await invokeToolCall(server, { name: 'throws', arguments: {} }).catch(() => {});
    // mcp.tool.tokens.total, mcp.tool.cost.total (plus calls/duration again)
    await invokeToolCall(server, { name: 'costed', arguments: {} });
    // mcp.tool.silent_failures x3, which also crosses the default thrash
    // threshold on the 3rd call: mcp.tool.loop.detected/.length/.duration/
    // .wasted_tokens/.wasted_cost_usd (the latter two record unconditionally,
    // even at 0, confirmed by reading src/thrash/emitter.js).
    await invokeToolCall(server, { name: 'flaky', arguments: {} }, { requestId: 2 });
    await invokeToolCall(server, { name: 'flaky', arguments: {} }, { requestId: 3 });
    await invokeToolCall(server, { name: 'flaky', arguments: {} }, { requestId: 4 });
    // mcp.tool.schema_drift.detected: cold-start tools/list, then a changed schema.
    await invokeToolsList(server, {}, { requestId: 5 });
    tools = [{ name: 'a', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }];
    await invokeToolsList(server, {}, { requestId: 6 });

    await instrumented.shutdown();

    const stderr = stderrLines.join('\n');
    const expectedInstruments = [
      'mcp.tool.calls',
      'mcp.tool.errors',
      'mcp.tool.silent_failures',
      'mcp.tool.duration',
      'mcp.tool.tokens.total',
      'mcp.tool.cost.total',
      'mcp.tool.loop.detected',
      'mcp.tool.loop.length',
      'mcp.tool.loop.wasted_tokens',
      'mcp.tool.loop.wasted_cost_usd',
      'mcp.tool.loop.duration',
      'mcp.tool.schema_drift.detected',
    ];
    for (const name of expectedInstruments) {
      expect(stderr, `expected a stderr line for ${name}`).toContain(`[opentel-mcp metrics] ${name}`);
    }
  });

  it('does not override a pre-existing global MeterProvider, and warns exactly once', async () => {
    const existingReader = new TestMetricReader();
    const existingProvider = new MeterProvider({ readers: [existingReader] });
    metrics.setGlobalMeterProvider(existingProvider);
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    const serverA = createServer('a');
    instrumentMcpServer(serverA, { serviceName: 'svc-a', setupNodeSdk: true });
    const serverB = createServer('b');
    instrumentMcpServer(serverB, { serviceName: 'svc-b', setupNodeSdk: true });

    expect(metrics.getMeterProvider()).toBe(existingProvider);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/MeterProvider is already registered/i);

    await existingProvider.shutdown();
  });

  it('shuts down the abandoned dev MeterProvider immediately when registration loses, so its periodic reader never fires (no leaked timer)', async () => {
    const existingReader = new TestMetricReader();
    const existingProvider = new MeterProvider({ readers: [existingReader] });
    metrics.setGlobalMeterProvider(existingProvider);
    vi.spyOn(diag, 'warn').mockImplementation(() => {});

    // MeterProvider's own constructor already starts its
    // PeriodicExportingMetricReader's interval the moment it's built —
    // before instrumentMcpServer() ever attempts registration (confirmed
    // by reading @opentelemetry/sdk-metrics' source: the timer starts
    // from onInitialized(), called by the constructor). Spying on the
    // shared MeterProvider.prototype.shutdown lets this test observe
    // whether the ABANDONED instance (not existingProvider, which this
    // test shuts down itself, separately, at the end) gets shut down by
    // instrument.js's own cleanup — proving the leak fix, not merely
    // the absence of visible stderr output (which would pass even with
    // the leak, since nothing ever records data on an abandoned,
    // never-registered provider either way).
    const shutdownSpy = vi.spyOn(MeterProvider.prototype, 'shutdown');

    vi.useFakeTimers();
    try {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });

      // The abandoned candidate's own shutdown() must have been called
      // already, synchronously within instrumentMcpServer() itself — not
      // merely scheduled for later — and on an instance other than
      // existingProvider (which this test never asked to be shut down).
      const abandonedShutdownCalls = shutdownSpy.mock.instances.filter((instance) => instance !== existingProvider);
      expect(abandonedShutdownCalls).toHaveLength(1);

      // Advance well past several real export intervals — if the
      // abandoned provider's timer had survived, this is where its
      // export() would have fired one or more times. 5000ms is
      // DEV_METRICS_EXPORT_INTERVAL_MS (src/instrument.js) — not
      // exported publicly, hardcoded here with its source noted rather
      // than widening instrument.js's export surface for one test constant.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await vi.advanceTimersByTimeAsync(5000 * 4);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    await existingProvider.shutdown();
  });

  it('setupNodeSdk: false registers no MeterProvider at all', () => {
    const before = metrics.getMeterProvider();
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    expect(metrics.getMeterProvider()).toBe(before);
  });

  it('enableMetrics: false skips dev-mode metrics entirely, even under setupNodeSdk: true', () => {
    const before = metrics.getMeterProvider();
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true, enableMetrics: false });
    expect(metrics.getMeterProvider()).toBe(before);
  });

  it('server.shutdown() still resolves cleanly when enableMetrics is false (no meterProvider to await)', async () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true, enableMetrics: false });
    await expect(instrumented.shutdown()).resolves.toBeUndefined();
  });
});
