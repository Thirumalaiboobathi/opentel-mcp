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
    const input = (s, c) => ({
      sessionId: `session-${s}`,
      toolName: 'search',
      fingerprint: 'fp-abc', // same fingerprint within a session: a real thrash loop
      spanId: `span-${s}-${c}`,
      traceId: `trace-${s}-${c}`,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
    });

    // Timing: root cause of the old flake. This loop used to run with vi.spyOn(record) installed, which retains the
    // arguments of all 500,000 calls; the measured "throughput" was then dominated by GC of that retained garbage and
    // by whatever else the machine was doing (6.9k calls/s under load vs 85k unloaded), against an absolute 10k/s floor.
    // Now: (1) nothing is spied during the timed loop, and (2) the bound is relative to a calibration loop that builds
    // the same inputs and does bounded-Map work in the same process, so machine load slows both sides together. The
    // property (no per-call cost that grows with sessions or calls) still fails the bound if record() regresses.
    // Timing is measured in ROUNDS over disjoint slices of the sessions, each round a calibration loop immediately
    // followed by the timed loop, and the bound applies to the best (lowest) round ratio. One long GC pause or a
    // scheduler stall (seen on macOS runners: a single 32x sample against a 30x bound, ~6-9x normally) lands in one
    // round and cannot fail the test; a real regression (a cost per record() that grows with sessions or calls)
    // raises the ratio in EVERY round, so the minimum still fails. The workload is unchanged: all sessions, all calls.
    const ROUNDS = 3;
    const range = (round) => [
      Math.floor((round * SESSION_COUNT) / ROUNDS),
      Math.floor(((round + 1) * SESSION_COUNT) / ROUNDS),
    ];
    const calibrate = (from, to) => {
      const map = new Map();
      const t0 = performance.now();
      for (let s = from; s < to; s++) {
        for (let c = 0; c < CALLS_PER_SESSION; c++) {
          const i = input(s, c);
          map.set(i.sessionId, i);
          if (map.size > 1000) map.delete(map.keys().next().value);
        }
      }
      return performance.now() - t0;
    };
    const timedRun = (from, to) => {
      const t0 = performance.now();
      for (let s = from; s < to; s++) {
        for (let c = 0; c < CALLS_PER_SESSION; c++) detector.record(input(s, c));
      }
      return performance.now() - t0;
    };

    if (global.gc) global.gc(); // best-effort; most `npm test` runs won't have --expose-gc
    const heapBefore = process.memoryUsage().heapUsed;
    let calibrationMs = 0;
    let elapsedMs = 0;
    const ratios = [];
    for (let round = 0; round < ROUNDS; round++) {
      const [from, to] = range(round);
      const cal = calibrate(from, to);
      const run = timedRun(from, to);
      calibrationMs += cal;
      elapsedMs += run;
      ratios.push(run / cal);
    }
    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);
    const callsPerSecond = TOTAL_CALLS / (elapsedMs / 1000);
    const slowdownVsCalibration = Math.min(...ratios);

    // Session isolation methodology: every simulated session is given its own distinct, explicitly-passed sessionId
    // (`session-${n}`), never the generated per-connection fallback (this calls ThrashDetector.record() directly,
    // bypassing instrumentMcpServer() and resolveThrashSessionId()). The spy below captures the literal sessionId
    // the detector received, so the check measures what the subject saw. It runs after, and outside, the timed loop.
    const recordSpy = vi.spyOn(ThrashDetector.prototype, 'record');
    const isolationDetector = new ThrashDetector(resolveThrashConfig());
    for (let s = 0; s < SESSION_COUNT; s++) isolationDetector.record(input(s, 0));
    const observedSessionIds = new Set(recordSpy.mock.calls.map(([i]) => i.sessionId));
    recordSpy.mockRestore();

    // eslint-disable-next-line no-console
    console.log(
      '--- Agent Thrash Detection benchmark ---\n' +
        'Methodology: session isolation, each simulated session is assigned its own distinct, explicitly-passed ' +
        'sessionId (session-0..session-9999), passed directly to ThrashDetector.record(); the generated ' +
        "per-connection fallback (src/instrument.js's resolveThrashSessionId()) is exercised in " +
        'test/integration/thrash-detection.test.js, not here.\n' +
        `Simulated sessions: ${SESSION_COUNT}, calls/session: ${CALLS_PER_SESSION}, total calls: ${TOTAL_CALLS}\n` +
        `Distinct session keys observed by ThrashDetector.record(): ${observedSessionIds.size}\n` +
        `Throughput: ${callsPerSecond.toFixed(0)} calls/sec (${elapsedMs.toFixed(0)}ms total; calibration loop ${calibrationMs.toFixed(0)}ms, best round ${slowdownVsCalibration.toFixed(1)}x of [${ratios.map((r) => r.toFixed(1)).join(', ')}])\n` +
        `Heap growth: ${heapGrowthMB.toFixed(2)}MB (${global.gc ? 'GC forced before/after' : 'no --expose-gc, noisier, upper-bound estimate'})`,
    );

    // Fail loudly, not just quietly report, if the harness didn't
    // actually exercise as many distinct sessions as it claims to have
    // simulated — a silent collapse here would invalidate every other
    // number this benchmark reports.
    expect(observedSessionIds.size, 'distinct session keys observed must equal sessions simulated').toBe(
      SESSION_COUNT,
    );

    // Measured 5.8-8.7x unloaded and under 8 busy cores (per round). 30x on the BEST round leaves >3x margin and still
    // catches a per-call cost that grows with sessions or calls (e.g. an O(maxTrackedKeys) scan per record()).
    expect(slowdownVsCalibration).toBeLessThan(30);

    // No assertion on heapGrowthMB, deliberately. It's logged above (and
    // still worth reading when investigating a real regression), but
    // without --expose-gc it's uncollected garbage from 500,000 short-lived
    // allocations sitting in one tight synchronous loop, not retained
    // memory — V8 has no reason to collect eagerly here, so the number
    // swings with GC timing (observed ~202-213MB standalone vs. up to
    // ~337MB under full-suite worker contention) rather than tracking
    // anything this test controls. A prior fixed ceiling on this figure
    // couldn't fail regardless of where it was set, which isn't a test.
    //
    // The actual bound — that maxTrackedKeys caps retained entries
    // regardless of call volume — is proven deterministically instead, by
    // BoundedTtlMap.size directly, in test/thrash/store.test.js's "memory
    // bound" describe block (100,000 inserts at maxSize 1000, size stays
    // at 1000). That's the real assertion; this file only reports the
    // heap number for visibility.
  }, 60_000); // 1.5M record-sized iterations (calibration + timed + isolation): legitimately slow on a saturated machine
});
