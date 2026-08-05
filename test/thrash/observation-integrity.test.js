import { describe, it, expect, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';

/**
 * SKIPPED — specification, not a working test. Documents the second,
 * more realistic failure mode identified by ADR 008's "Update
 * (2026-08-05): The two-axis reframe" section
 * (docs/adr/008-observation-liveness.md) — not implemented, not
 * scheduled for this release.
 *
 * THE GAP THIS TEST TARGETS, AND WHY IT'S DIFFERENT FROM THE FIRST
 * SKIPPED TEST: `observation-liveness.test.js` covers "no
 * TracerProvider/MeterProvider registered at all" — mode (a) in ADR
 * 008's original investigation. This file covers a case that
 * investigation explicitly found NOT detectable by any public API: mode
 * (b), a real, genuinely-registered TracerProvider whose export path is
 * broken (the exporter itself fails every export). This is arguably the
 * MORE realistic failure in production — a misconfigured OTLP endpoint,
 * an expired credential, a firewall rule — since "nobody registered a
 * provider at all" tends to be caught early in development, while "the
 * provider is there but silently failing to export" is exactly the kind
 * of gap that survives into production undetected.
 *
 * THE TWO-AXIS CONTRACT THIS TEST SPECS: per the ADR 008 update,
 *
 *   ToolOutcome:          SUCCESS | FAILURE | UNKNOWN
 *   ObservationIntegrity: DEGRADED | UNKNOWN   (HEALTHY is unreachable — see the ADR)
 *
 * A tool call that returns isError: true, in this scenario, must produce
 * a `toolOutcome` that is NOT the "nothing failed" value — regardless of
 * whether the export path is healthy. `ToolOutcome` is backed by a new,
 * always-on, OTel-independent counter (ADR 008 update, Finding 3) that
 * must observe the failure directly from wrapToolCallHandler's own
 * isToolResultError() check, not by reading anything that traveled
 * through the (here, deliberately broken) export path — this test is
 * the concrete case that distinguishes those two designs. A naive
 * implementation that tried to infer "did a failure happen" from
 * anything OTel-shaped (a span, an exported metric) would see nothing at
 * all here, since every export from this test's TracerProvider fails by
 * construction, and would wrongly report the same "nothing happened"
 * value as a genuinely clean run — exactly the silent-success collapse
 * this whole feature exists to close.
 *
 * WHY THIS CANNOT PASS TODAY: `getObservationState()` does not exist.
 * `instrumentMcpServer()`'s returned object has no such method — grep
 * confirms nothing in src/ references it. Every assertion below calls a
 * method that isn't there, so this test is inert (describe.skip) rather
 * than red, the same discipline observation-liveness.test.js already
 * uses.
 *
 * STATUS: known gap, tracked for v0.8.0 per docs/adr/008-observation-liveness.md's
 * "Update (2026-08-05)" section. Not a regression — no released version
 * has ever exposed this capability.
 *
 * NAMING: `getObservationState()`, `state.toolOutcome`, and
 * `state.observationIntegrity` are PROVISIONAL — they reflect the ADR
 * update's current best names, not a shipped, agreed API. The literal
 * sentinel string `'NO_FAILURE'` asserted against below is ALSO
 * provisional and deliberately distinct from the ADR's own proposed
 * `'SUCCESS'` value — this test only needs "whatever value means no
 * failure occurred," and spelling it differently here is a deliberate
 * reminder that the exact string is not yet settled, mirroring how
 * observation-liveness.test.js's own 'unavailable'/'unknown' values were
 * flagged as best guesses, not a designed contract.
 *
 * Credit: gap originally surfaced in external review of the Agent
 * Thrash Detection (v0.6.0) / Observation liveness (ADR 008) work, and
 * reframed from "detect a broken pipeline" to "stop implying health by
 * omission" — both by Massimiliano Brighindi.
 */
describe.skip('observation integrity (getObservationState) — spec for a registered-but-broken export path', () => {
  /** Fresh, unconnected low-level Server — no transport connected, so no session-oriented complications. */
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

  /**
   * An exporter that fails every single export deterministically — the
   * simplest possible stand-in for "a real, registered exporter that
   * cannot reach its backend" (bad endpoint, expired credential,
   * firewall). Deliberately not a network-based fake: the point is
   * exporter failure, not network failure specifically, and a
   * deterministic in-process failure keeps this spec from ever being
   * flaky if it's later un-skipped.
   */
  function createAlwaysFailingExporter() {
    return {
      export(_spans, resultCallback) {
        resultCallback({ code: ExportResultCode.FAILED, error: new Error('export deliberately broken for this test') });
      },
      shutdown() {
        return Promise.resolve();
      },
    };
  }

  let provider;

  afterEach(async () => {
    // Global OTel state must not leak into other test files — this
    // matters even for a skipped test, since a future implementer
    // un-skipping this file inherits this cleanup for free.
    trace.disable();
    if (provider) {
      await provider.shutdown();
      provider = undefined;
    }
  });

  const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };

  it('reports toolOutcome as a failure when a tool fails, even though the registered provider cannot export anything', async () => {
    // A REAL TracerProvider IS registered here — this is the crux of
    // what distinguishes this test from observation-liveness.test.js's
    // "nothing registered at all" scenario. The exporter behind it fails
    // every export, simulating a misconfigured/unreachable backend, not
    // an absent one.
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createAlwaysFailingExporter())],
    });
    provider.register();

    const server = createServer();
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    await invokeToolCall(server, { name: 'some-tool', arguments: {} });

    const state = instrumented.getObservationState();

    // The failure must be visible in toolOutcome regardless of whether
    // the span describing it ever successfully left the process — see
    // this file's docblock for why that's the entire point of this test.
    expect(state.toolOutcome).not.toBe('NO_FAILURE');
  });

  it('does NOT report a failure on a clean run under the same broken-export provider (the contrast this test isolates)', async () => {
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createAlwaysFailingExporter())],
    });
    provider.register();

    const server = createServer();
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    await invokeToolCall(server, { name: 'some-tool', arguments: {} });

    const state = instrumented.getObservationState();

    // A clean run under a broken export path must read the same as a
    // clean run under a healthy one — toolOutcome is derived from
    // wrapToolCallHandler's own in-process check, not from anything that
    // touched the (here, permanently failing) exporter.
    expect(state.toolOutcome).toBe('NO_FAILURE');
  });
});
