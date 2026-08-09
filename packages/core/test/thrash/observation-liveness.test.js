import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';

/**
 * SKIPPED — specification, not a working test. Documents a gap raised in
 * external review; not implemented, not scheduled for this release.
 *
 * THE GAP: instrumentMcpServer() with no TracerProvider and no
 * MeterProvider registered globally silently no-ops — @opentelemetry/api
 * hands back its default no-op implementations, spans/metrics are
 * dropped, and nothing throws or warns. A tool call that returns
 * `isError: true` in that state is therefore indistinguishable, from the
 * outside, from a tool that never failed: both produce zero recorded
 * telemetry. "Nothing happened" (clean run) and "nothing was successfully
 * observed" (a real failure the pipeline silently swallowed) collapse
 * into the same zero.
 *
 * A liveness signal cannot travel over the channel whose liveness is in
 * question — you can't ask a span whether spans are working. So this has
 * to be observable through the in-process path (getThrashSummary(), which
 * is deliberately OTel-independent — see its docblock in
 * src/thrash/detector.js), not through spans or metrics.
 *
 * WHY THIS CANNOT PASS TODAY: `ThrashSummary` (src/thrash/types.d.ts) has
 * no field describing observation-channel health. `getThrashSummary()`
 * currently returns exactly `{ activeLoops, totalLoopsDetected,
 * totalWastedCostUsd, totalWastedTokensIn, totalWastedTokensOut,
 * topOffenders }` — confirmed by reading src/thrash/detector.js's
 * getSummary() and src/thrash/types.d.ts before writing this file.
 * Nothing in that shape is provider-related; there is no code path that
 * checks whether a real TracerProvider/MeterProvider is registered. Every
 * assertion below reads `summary.observation`, a field that does not
 * exist, so this test is inert (describe.skip) rather than red — it names
 * the gap without asserting a fix nobody has agreed to yet.
 *
 * STATUS: known gap, tracked for v0.7.0. Not a regression — no released
 * version has ever exposed observation-channel health; this is a missing
 * capability, not a broken one.
 *
 * NAMING: `summary.observation` and its values ('healthy' | 'unavailable'
 * | 'unknown') are PROVISIONAL. Nothing about the field name, its value
 * set, or where it lives (on ThrashSummary vs. elsewhere) has been
 * designed or agreed. Only the 'unavailable' assertion in the first case
 * below reflects what external review specifically asked to be
 * distinguishable; the second case's 'unknown' value is this file's best
 * guess at a contrasting state, not a settled contract.
 *
 * Credit: gap surfaced in external review of the Agent Thrash Detection
 * (v0.6.0) feature.
 */
describe.skip('observation liveness (getThrashSummary) — spec for an unimplemented gap', () => {
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

  const FAILING_RESULT = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };

  it('reports observation as unavailable when a tool fails and no TracerProvider/MeterProvider is registered', async () => {
    // Deliberately no NodeTracerProvider.register() / metrics.setGlobalMeterProvider()
    // anywhere in this test — @opentelemetry/api's default no-op
    // implementations are exactly the "nothing registered" state the gap
    // is about.
    const server = createServer();
    server.setRequestHandler(CallToolRequestSchema, async () => FAILING_RESULT);
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    await invokeToolCall(server, { name: 'some-tool', arguments: {} });

    const summary = instrumented.getThrashSummary();

    // A real failure occurred, but with no provider registered there is
    // no way to confirm it was ever recorded anywhere — this must read
    // differently from "no failure occurred at all" (see the contrast
    // case below), which today it cannot: both produce the same all-zero
    // ThrashSummary.
    expect(summary.observation).toBe('unavailable');
  });

  it('does NOT report unavailable on a clean run where no tool ever failed (the contrast this gap erases)', async () => {
    const server = createServer();
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    await invokeToolCall(server, { name: 'some-tool', arguments: {} });

    const summary = instrumented.getThrashSummary();

    // Nothing failed, so there is nothing to have gone unobserved — this
    // is "unknown" (never exercised), not "unavailable" (exercised and
    // silently dropped). The exact value here is this file's best guess
    // at the contrast, not a designed contract — see the file docblock.
    expect(summary.observation).toBe('unknown');
    expect(summary.observation).not.toBe('unavailable');
  });
});
