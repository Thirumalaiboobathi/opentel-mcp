import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';

/**
 * REPRODUCTION TEST for a reported bug (against v0.7.0, still present):
 * Agent Thrash Detection (and, per the same investigation, budget
 * tracking, schema drift detection, and the v0.8.0 ToolOutcome counter)
 * cannot fire on a "stateless" Streamable HTTP deployment shape — one
 * fresh `Server`/`McpServer` + transport constructed per incoming HTTP
 * POST, with `instrumentMcpServer()` called fresh on each one.
 *
 * ROOT CAUSE, confirmed by reading src/instrument.js directly:
 * `thrashDetector` (and `budgetTracker`, `schemaDriftDetector`,
 * `toolOutcomeCounter`) are all local `const`s inside
 * `instrumentMcpServer()`'s own function body (instrument.js:194, 200,
 * 245, 275) — a brand new instance is constructed on every single call,
 * with no state shared across calls. The `kInstrumented` idempotency
 * guard (a Symbol set on the `server` object) never helps here either:
 * it only prevents re-instrumenting the *same* object twice, and this
 * deployment shape hands `instrumentMcpServer()` a genuinely different,
 * freshly-constructed object on every request.
 *
 * This test drives 5 identical-fingerprint tool failures across 5
 * SEPARATE `instrumentMcpServer()` calls, each on its own fresh `Server`
 * — exactly the reported shape. With `threshold: 3` (the default), a
 * correctly-accumulating thrash detector would have fired
 * `mcp.tool.loop.detected` by (at latest) the 3rd of these 5 calls. It
 * does not, on any of them, because each call's `ThrashDetector` only
 * ever sees a single failure before being discarded.
 *
 * NAMING THE ASSERTION HONESTLY: the bug report described the symptom as
 * "assert no loop is detected." Taken completely literally, that
 * assertion (`expect(detected).toBeUndefined()`) currently PASSES — it
 * describes today's (broken) behavior, not a failing test. To produce an
 * actual RED test — the kind that turns green the moment a real fix
 * lands, per "write a failing test reproducing it" — this test instead
 * asserts the CORRECT, desired outcome (a loop WAS detected by the 5th
 * call), which is what genuinely fails today. Both readings describe the
 * same bug; this file asserts the one that's useful as a regression test
 * later. See the second `it()` below for the literal "nothing ever
 * fires" framing as a plain, unambiguous statement of the current state.
 *
 * This file is `describe.skip`, per this project's own established
 * discipline for a confirmed, reported gap with no fix landed yet (see
 * test/thrash/observation-liveness.test.js) — kept in the suite as a
 * living reproduction, not deleted, and not left active (which would
 * permanently redden `npm test` for every contributor until the fix
 * ships). Confirmed to actually fail before being skipped — see the
 * accompanying investigation report for the literal test-run output.
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
});

afterEach(async () => {
  await traceProvider.shutdown();
  trace.disable();
  context.disable();
  spanExporter.reset();

  await meterProvider.shutdown();
  metrics.disable();
});

describe.skip('Agent Thrash Detection — reported gap: fresh Server + instrumentMcpServer() per stateless HTTP request', () => {
  /** Simulates one incoming HTTP POST: a brand-new Server, freshly instrumented, handling exactly one tools/call, then discarded — matching the reported deployment shape. */
  async function simulateOneStatelessRequest() {
    const server = createServer();
    // assumeSingleSession: true — this test never calls server.connect(),
    // so the transport is undeterminable; opting in explicitly here keeps
    // the test about the reported lifecycle bug, not session resolution
    // (see test/integration/thrash-detection.test.js for the same pattern).
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    await invokeToolCall(server, { name: 'validate', arguments: {} });
    return instrumented;
  }

  it('SHOULD fire mcp.tool.loop.detected by the 5th identical-fingerprint failure, spanning 5 separate instrumentMcpServer() calls — currently does not', async () => {
    let lastInstrumented;
    for (let i = 0; i < 5; i++) {
      lastInstrumented = await simulateOneStatelessRequest();
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');

    // This is the assertion that SHOULD hold if state correctly
    // accumulated across the 5 "requests" above (default threshold: 3) —
    // and the one that currently fails, proving the bug.
    expect(detected).toBeDefined();
    expect(detected?.dataPoints?.[0]?.value).toBeGreaterThanOrEqual(1);

    // Also demonstrably broken at the per-instance accessor level: the
    // LAST instrumented server's own getThrashSummary() reflects only
    // its own single-call ThrashDetector, never the 4 prior "requests."
    expect(lastInstrumented.getThrashSummary().totalLoopsDetected).toBeGreaterThan(0);
  });

  it('documents the literal current symptom plainly: the metric never fires at all, across any of the 5 calls', async () => {
    for (let i = 0; i < 5; i++) {
      await simulateOneStatelessRequest();
    }

    const { resourceMetrics } = await metricReader.collect();
    // This is the bug report's own "assert no loop is detected," taken
    // completely literally — it currently PASSES, since it describes
    // today's actual (broken) behavior rather than the desired one. Kept
    // as its own assertion so the report is unambiguous regardless of
    // which reading of the original instruction is intended.
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });
});
