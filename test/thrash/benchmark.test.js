import { describe, it, expect, vi } from 'vitest';
import { ThrashDetector } from '../../src/thrash/detector.js';
import { resolveThrashConfig } from '../../src/thrash/config.js';

/**
 * Manual micro-benchmark, not vitest's `bench()` API — same choice and
 * same reasoning as test/fingerprint/benchmark.test.js: `bench()` reports
 * comparisons under the separate `vitest bench` runner (which, as of this
 * writing, has zero matching files in this repo — `npm run bench` exits
 * with "No benchmark files found"), not hard per-call budgets enforced on
 * every `npm test` run. This file follows that established pattern
 * instead: a normal `it()` with its own timed loop, so the budget is
 * checked on every `npm test`, the same as the fingerprint one.
 *
 * @param {() => void} fn
 * @param {number} iterations
 * @returns {{ p50: number, p95: number, p99: number }} microseconds
 */
function measure(fn, iterations) {
  const durationsUs = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    durationsUs[i] = (performance.now() - start) * 1000;
  }
  durationsUs.sort((a, b) => a - b);
  const at = (p) => durationsUs[Math.min(iterations - 1, Math.floor(iterations * p))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function mkInput(overrides = {}) {
  return {
    sessionId: 'session-0',
    toolName: 'search',
    fingerprint: 'fp-abc',
    spanId: 'span-1',
    traceId: 'trace-1',
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.01,
    ...overrides,
  };
}

describe('ThrashDetector.record() overhead', () => {
  it('enabled adds only microseconds over the disabled baseline', () => {
    const disabled = new ThrashDetector(resolveThrashConfig({ enabled: false }));
    const enabled = new ThrashDetector(resolveThrashConfig());

    // Distinct sessionId per call, not one hot key — realistic Map
    // behavior (including eventual LRU churn past maxTrackedKeys: 1000),
    // not an artificially cache-friendly single-key loop.
    let i = 0;
    const baseline = measure(() => {
      disabled.record(mkInput({ sessionId: `s${i}`, fingerprint: `fp${i % 50}` }));
      i++;
    }, 10_000);

    i = 0;
    const withDetection = measure(() => {
      enabled.record(mkInput({ sessionId: `s${i}`, fingerprint: `fp${i % 50}` }));
      i++;
    }, 10_000);

    // eslint-disable-next-line no-console
    console.log(
      `record() disabled: p50=${baseline.p50.toFixed(2)}µs p95=${baseline.p95.toFixed(2)}µs p99=${baseline.p99.toFixed(2)}µs\n` +
        `record() enabled:  p50=${withDetection.p50.toFixed(2)}µs p95=${withDetection.p95.toFixed(2)}µs p99=${withDetection.p99.toFixed(2)}µs`,
    );

    // First-pass budget, not a number handed down from elsewhere: derived
    // from actually running this benchmark, standalone AND as part of the
    // full `npm test` run (where vitest parallelizes test files across
    // workers, and CPU contention from ~20 other files running at once
    // measurably skews a wall-clock micro-benchmark — observed p99 ~52-98µs
    // standalone vs. up to ~283µs under full-suite contention). Budgeted
    // with real margin over the full-suite figure, not just the quieter
    // standalone one. Tighten once real numbers from more environments are in.
    expect(withDetection.p99).toBeLessThan(500);
  });
});

describe('Agent Thrash Detection benchmark: throughput, memory, session isolation', () => {
  it('sustains throughput and bounded memory across many concurrent sessions, each reliably isolated', () => {
    const SESSION_COUNT = 10_000;
    const CALLS_PER_SESSION = 50;
    const TOTAL_CALLS = SESSION_COUNT * CALLS_PER_SESSION;

    const detector = new ThrashDetector(resolveThrashConfig());

    // Session isolation methodology: every simulated session below is
    // given its own distinct, explicitly-passed sessionId
    // (`session-${n}`) — never the generated per-connection fallback
    // (there is no fallback here at all: this benchmark calls
    // ThrashDetector.record() directly, bypassing instrumentMcpServer()
    // and its resolveThrashSessionId() fallback logic entirely). Spying
    // on record() below captures the literal sessionId ThrashDetector
    // received on every call, so the isolation check measures what the
    // subject-under-test actually saw, not just what this harness
    // intended to send.
    const recordSpy = vi.spyOn(ThrashDetector.prototype, 'record');

    if (global.gc) global.gc(); // best-effort; most `npm test` runs won't have --expose-gc
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();

    for (let s = 0; s < SESSION_COUNT; s++) {
      const sessionId = `session-${s}`;
      for (let c = 0; c < CALLS_PER_SESSION; c++) {
        detector.record({
          sessionId,
          toolName: 'search',
          fingerprint: 'fp-abc', // same fingerprint within a session — a real thrash loop
          spanId: `span-${s}-${c}`,
          traceId: `trace-${s}-${c}`,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.01,
        });
      }
    }

    const elapsedMs = performance.now() - start;
    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);
    const callsPerSecond = TOTAL_CALLS / (elapsedMs / 1000);

    // --- Session isolation integrity check ---
    const observedSessionIds = new Set(recordSpy.mock.calls.map(([input]) => input.sessionId));
    recordSpy.mockRestore();

    // eslint-disable-next-line no-console
    console.log(
      '--- Agent Thrash Detection benchmark ---\n' +
        'Methodology: session isolation — each of the simulated sessions below is assigned its own distinct, ' +
        'explicitly-passed sessionId (session-0..session-9999), passed directly to ThrashDetector.record(). ' +
        'This benchmark never relies on the generated per-connection fallback session id (src/instrument.js\'s ' +
        'resolveThrashSessionId()) — that fallback path is exercised separately in ' +
        'test/integration/thrash-detection.test.js, not here.\n' +
        `Simulated sessions: ${SESSION_COUNT}, calls/session: ${CALLS_PER_SESSION}, total calls: ${TOTAL_CALLS}\n` +
        `Distinct session keys observed by ThrashDetector.record(): ${observedSessionIds.size}\n` +
        `Throughput: ${callsPerSecond.toFixed(0)} calls/sec (${elapsedMs.toFixed(0)}ms total)\n` +
        `Heap growth: ${heapGrowthMB.toFixed(2)}MB (${global.gc ? 'GC forced before/after' : 'no --expose-gc — noisier, upper-bound estimate'})`,
    );

    // Fail loudly, not just quietly report, if the harness didn't
    // actually exercise as many distinct sessions as it claims to have
    // simulated — a silent collapse here would invalidate every other
    // number this benchmark reports.
    expect(observedSessionIds.size, 'distinct session keys observed must equal sessions simulated').toBe(
      SESSION_COUNT,
    );

    expect(callsPerSecond).toBeGreaterThan(10_000);

    // maxTrackedKeys defaults to 1000; 10,000 sessions x 50 calls must NOT
    // grow memory anywhere near proportionally to the 500,000 calls made.
    // Ceiling derived from real, repeated local measurement: consistently
    // ~207-211MB across several runs without forced GC (V8 doesn't collect
    // eagerly inside one tight synchronous loop) — 300MB leaves headroom
    // for that same GC-timing variance while still catching a genuine
    // regression: if maxTrackedKeys stopped being enforced and all 500,000
    // calls' entries were retained instead of ~1000, growth would be
    // dramatically larger than this, not just modestly over it.
    expect(heapGrowthMB).toBeLessThan(300);
  });
});
