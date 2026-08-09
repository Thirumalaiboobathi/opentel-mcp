import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer, __resetInstanceRegistryForTests } from '../../src/instrument.js';

/**
 * Originally a REPRODUCTION TEST for a reported bug (against v0.7.0):
 * Agent Thrash Detection (and, per the same investigation, budget
 * tracking, schema drift detection, and the v0.8.0 ToolOutcome counter)
 * cannot fire on a "stateless" Streamable HTTP deployment shape — one
 * fresh `Server`/`McpServer` + transport constructed per incoming HTTP
 * POST, with `instrumentMcpServer()` called fresh on each one, because
 * every one of those four trackers was a local `const` inside
 * `instrumentMcpServer()`'s own function body, discarded and rebuilt from
 * empty on every call. Full investigation: ADR 012
 * (docs/adr/012-tracker-lifecycle-and-shared-state.md).
 *
 * ADR 012, Phase 2 fixed this: `options.instanceKey` (`src/config.js`,
 * `src/registry/instance-registry.js`) lets repeated `instrumentMcpServer()`
 * calls that share a stable key share these four trackers' state instead
 * of each resetting to empty — see `test/instrument.instance-key.test.js`
 * for the focused, feature-level coverage of that mechanism itself. This
 * file keeps its original role as the literal reproduction of the
 * originally-reported shape, now split into two `it()`s: the fix,
 * exercised end to end (opting in via `instanceKey`), and the unfixed
 * default (opting out, i.e. omitting `instanceKey` — still today's
 * behavior for any host who doesn't set it, by design; see ADR 012's
 * "Default behavior with instanceKey omitted: byte-identical to today").
 *
 * No longer `describe.skip` — this is the regression test ADR 012's own
 * "Consequences" section said this file would need once a fix landed
 * ("at that point it needs a rewrite, not just an unskip").
 */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

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

// Static text (no UUID/timestamp) so computeFingerprint() produces the
// same mcp.failure.fingerprint on every call — required for the same
// fingerprint to accumulate toward a loop, per-instance or not.
const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };

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

describe('Agent Thrash Detection — fresh Server + instrumentMcpServer() per stateless HTTP request', () => {
  /**
   * Simulates one incoming HTTP POST: a brand-new Server, freshly
   * instrumented, handling exactly one tools/call, then discarded —
   * matching the originally-reported deployment shape. `instanceKeyOption`
   * is merged into `instrumentMcpServer()`'s options as-is (an object like
   * `{ instanceKey: 'svc-a' }`, or `{}` to omit it entirely) — the ONLY
   * difference between the "fixed" and "still broken by default" tests
   * below is whether that object carries an `instanceKey`.
   *
   * `extra.sessionId: 'client-1'` on every call — a REAL, transport-level
   * session id, the same one on every request, exactly what a genuine
   * Streamable HTTP deployment provides via `extra.sessionId` regardless of
   * whether the SERVER OBJECT handling each request is freshly constructed
   * (the transport tracks the client's session; the Server object doesn't
   * have to). This matters: an earlier version of this test passed no
   * sessionId at all and relied on `assumeSingleSession`'s fallback, which
   * generates a NEW random id on every `instrumentMcpServer()` call by
   * design (`resolveThrashSessionId()`, instrument.js — deliberately
   * un-correlatable across genuinely separate Server objects, so it can
   * never accidentally merge unrelated concurrent clients). That fallback
   * defeats `instanceKey` sharing for thrash detection specifically:
   * sharing the tracker OBJECT doesn't help if the (sessionId, toolName,
   * fingerprint) key it looks entries up by is different on every call.
   * `instanceKey` fixes thrash detection for a stateless deployment that
   * has real session ids (the normal case for Streamable HTTP); it was
   * never meant to, and does not, paper over the absence of any session
   * identity at all — see this file's second `it()` for what still (and
   * correctly) doesn't work.
   */
  async function simulateOneStatelessRequest(instanceKeyOption = {}) {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', ...instanceKeyOption });
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    await invokeToolCall(server, { name: 'validate', arguments: {} }, { requestId: 1, sessionId: 'client-1' });
    return instrumented;
  }

  it('with a shared instanceKey AND a real session id: fires mcp.tool.loop.detected by the 5th identical-fingerprint failure, spanning 5 separate instrumentMcpServer() calls', async () => {
    let lastInstrumented;
    for (let i = 0; i < 5; i++) {
      lastInstrumented = await simulateOneStatelessRequest({ instanceKey: 'stateless-http-fleet' });
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');

    // This is the assertion that failed before ADR 012 Phase 2 landed, and
    // now holds: state correctly accumulated across the 5 "requests"
    // above (default threshold: 3), because all 5 shared one instanceKey.
    expect(detected).toBeDefined();
    expect(detected?.dataPoints?.[0]?.value).toBeGreaterThanOrEqual(1);

    // Also fixed at the per-instance accessor level: the LAST instrumented
    // server's own getThrashSummary() now reflects the SHARED ThrashDetector
    // all 5 "requests" fed into, not just its own single call.
    expect(lastInstrumented.getThrashSummary().totalLoopsDetected).toBeGreaterThan(0);
  });

  it('WITHOUT instanceKey (the default): the metric still never fires, across any of the 5 calls — unchanged, by design', async () => {
    for (let i = 0; i < 5; i++) {
      await simulateOneStatelessRequest(); // no instanceKey
    }

    const { resourceMetrics } = await metricReader.collect();
    // ADR 012's own "Default behavior with instanceKey omitted:
    // byte-identical to today" — a host who doesn't opt in still gets
    // exactly this (unfixed) behavior. This is not a residual bug; it's
    // the documented, deliberate default. See
    // test/instrument.instance-key.test.js for the direct, focused
    // coverage of that byte-identical guarantee.
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });
});
