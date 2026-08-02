import { describe, it, expect } from 'vitest';
import { ThrashDetector } from '../../src/thrash/detector.js';
import { resolveThrashConfig } from '../../src/thrash/config.js';

/** A mutable, injectable clock: state.now += x advances it deterministically, no real waiting. */
function makeClock(start = 0) {
  const state = { now: start };
  return { clock: () => state.now, state };
}

/** Builds a ThrashRecordInput with sane defaults, overridable per call. */
function mkInput(overrides = {}) {
  return {
    sessionId: 's1',
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

describe('ThrashDetector', () => {
  it('returns null for the first two consecutive same-fingerprint failures (default threshold 3)', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    expect(detector.record(mkInput())).toBeNull();
    expect(detector.record(mkInput())).toBeNull();
  });

  it('emits an event on the 3rd consecutive same-fingerprint failure, with summed tokens/cost', () => {
    const { clock, state } = makeClock(1000);
    const detector = new ThrashDetector(resolveThrashConfig(), clock);
    const input = mkInput({ spanId: 'span-first', traceId: 'trace-first' });

    expect(detector.record(input)).toBeNull();
    state.now += 100;
    expect(detector.record(input)).toBeNull();
    state.now += 100;
    const event = detector.record(input);

    expect(event).toEqual({
      sessionId: 's1',
      toolName: 'search',
      fingerprint: 'fp-abc',
      loopLength: 3,
      wastedTokensIn: 30,
      wastedTokensOut: 15,
      wastedCostUsd: 0.03,
      durationMs: 200,
      firstSpanId: 'span-first',
      firstTraceId: 'trace-first',
    });
  });

  it('emits a second event on the 6th failure (threshold 3, reEmitAfter 3), not on 4th or 5th', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput();

    expect(detector.record(input)).toBeNull();
    expect(detector.record(input)).toBeNull();
    expect(detector.record(input)).not.toBeNull(); // 3rd
    expect(detector.record(input)).toBeNull(); // 4th
    expect(detector.record(input)).toBeNull(); // 5th
    const secondEvent = detector.record(input); // 6th
    expect(secondEvent).not.toBeNull();
    expect(secondEvent.loopLength).toBe(6);
  });

  it('does not emit when different fingerprints are interleaved, none reaching threshold', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const a = mkInput({ fingerprint: 'fp-a' });
    const b = mkInput({ fingerprint: 'fp-b' });

    expect(detector.record(a)).toBeNull();
    expect(detector.record(b)).toBeNull();
    expect(detector.record(a)).toBeNull();
    expect(detector.record(b)).toBeNull();
    // Each fingerprint has only reached count 2 — below the default threshold of 3.
  });

  it('tracks the same tool+fingerprint independently per session', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const s1 = mkInput({ sessionId: 'session-1' });
    const s2 = mkInput({ sessionId: 'session-2' });

    detector.record(s1);
    detector.record(s1);
    expect(detector.record(s2)).toBeNull(); // session-2's own 1st, unaffected by session-1's count of 2
    expect(detector.record(s2)).toBeNull(); // session-2's own 2nd
    const s1Event = detector.record(s1); // session-1's 3rd
    expect(s1Event?.loopLength).toBe(3);
    expect(s1Event?.sessionId).toBe('session-1');
    const s2Event = detector.record(s2); // session-2's 3rd, independently
    expect(s2Event?.loopLength).toBe(3);
    expect(s2Event?.sessionId).toBe('session-2');
  });

  it('resets the counter when failures fall outside windowMs, without emitting', () => {
    const { clock, state } = makeClock(0);
    const detector = new ThrashDetector(resolveThrashConfig({ windowMs: 1000 }), clock);
    const input = mkInput();

    expect(detector.record(input)).toBeNull(); // count 1 @ t=0
    state.now = 500;
    expect(detector.record(input)).toBeNull(); // count 2 @ t=500, still inside the window

    state.now = 2000; // 2000ms since firstSeenAt (0) — past windowMs (1000): new episode
    expect(detector.record(input)).toBeNull(); // reset to count 1, not count 3

    state.now = 2100;
    expect(detector.record(input)).toBeNull(); // count 2 of the new episode
    state.now = 2200;
    const event = detector.record(input); // count 3 of the new episode
    expect(event?.loopLength).toBe(3);
    expect(event?.durationMs).toBe(200); // measured from the reset episode's start (t=2000), not t=0
  });

  it('never tracks or emits for the v0.4 fallback fingerprint "0000000000000000"', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ fingerprint: '0000000000000000' });

    for (let i = 0; i < 10; i++) {
      expect(detector.record(input)).toBeNull();
    }
  });

  describe('clearOnSuccess', () => {
    it('a success between failures resets that tool/session\'s loop counter to a fresh episode', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const input = mkInput();

      expect(detector.record(input)).toBeNull(); // count 1
      expect(detector.record(input)).toBeNull(); // count 2

      detector.clearOnSuccess(input.sessionId, input.toolName); // the loop broke

      // If the old count had survived, this would be count 3 and emit here.
      expect(detector.record(input)).toBeNull(); // fresh count 1
      expect(detector.record(input)).toBeNull(); // fresh count 2
      const event = detector.record(input); // fresh count 3
      expect(event?.loopLength).toBe(3); // not 5 — proves the old count was discarded, not offset
    });

    it('is a no-op (never throws) when there is nothing tracked for that session/tool', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      expect(() => detector.clearOnSuccess('no-such-session', 'no-such-tool')).not.toThrow();
    });

    it('does not affect a different session tracked under the same tool+fingerprint', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const s1 = mkInput({ sessionId: 'session-1' });
      const s2 = mkInput({ sessionId: 'session-2' });

      detector.record(s1);
      detector.record(s1);
      detector.record(s2);
      detector.record(s2);

      detector.clearOnSuccess('session-1', 'search');

      expect(detector.record(s1)).toBeNull(); // session-1 reset to fresh count 1
      const s2Event = detector.record(s2); // session-2 unaffected, reaches its own count 3
      expect(s2Event?.loopLength).toBe(3);
    });
  });

  describe('reset', () => {
    it('discards all tracked state', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const input = mkInput();
      detector.record(input);
      detector.record(input);

      detector.reset();

      expect(detector.record(input)).toBeNull(); // fresh count 1, not count 3
      expect(detector.record(input)).toBeNull(); // fresh count 2
      expect(detector.record(input)?.loopLength).toBe(3); // fresh count 3
    });
  });

  describe('enabled: false', () => {
    it('returns null immediately and never tracks anything', () => {
      const detector = new ThrashDetector(resolveThrashConfig({ enabled: false }));
      const input = mkInput();
      for (let i = 0; i < 10; i++) {
        expect(detector.record(input)).toBeNull();
      }
    });
  });

  describe('never throws', () => {
    it('returns null for malformed input rather than throwing', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      expect(() => detector.record(null)).not.toThrow();
      expect(detector.record(null)).toBeNull();
      expect(() => detector.record(undefined)).not.toThrow();
      expect(() => detector.record({})).not.toThrow();
      expect(() => detector.record({ sessionId: Symbol('x'), toolName: 'search', fingerprint: 'fp' })).not.toThrow();
    });
  });

  describe('bounded memory', () => {
    it('caps tracked keys at maxTrackedKeys across many distinct sessions, evicting the oldest', () => {
      const detector = new ThrashDetector(resolveThrashConfig({ maxTrackedKeys: 1000 }));

      for (let i = 0; i < 10_000; i++) {
        expect(detector.record(mkInput({ sessionId: `session-${i}` }))).toBeNull();
      }

      // session-0 was the very first insert; with only 1000 slots and 10,000
      // later insertions, LRU eviction must have dropped it. If it's truly
      // gone, these next 3 calls start a fresh episode (null, null, event-at-3).
      // If it somehow survived (a bounded-memory bug), the event would land
      // on the *second* of these three calls instead (count 1+1+1 = 3).
      expect(detector.record(mkInput({ sessionId: 'session-0' }))).toBeNull();
      expect(detector.record(mkInput({ sessionId: 'session-0' }))).toBeNull();
      const event = detector.record(mkInput({ sessionId: 'session-0' }));
      expect(event?.loopLength).toBe(3);
    });
  });

  describe('getSummary', () => {
    it('returns a zeroed summary before any activity', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      expect(detector.getSummary()).toEqual({
        activeLoops: 0,
        totalLoopsDetected: 0,
        totalWastedCostUsd: 0,
        totalWastedTokensIn: 0,
        totalWastedTokensOut: 0,
        topOffenders: [],
      });
    });

    it('reflects counts and a topOffenders entry after one detected loop', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const input = mkInput(); // tokensIn:10, tokensOut:5, costUsd:0.01 per call
      detector.record(input);
      detector.record(input);
      detector.record(input); // 3rd — crosses the default threshold of 3

      const summary = detector.getSummary();
      expect(summary.activeLoops).toBe(1);
      expect(summary.totalLoopsDetected).toBe(1);
      expect(summary.totalWastedCostUsd).toBeCloseTo(0.03, 6);
      expect(summary.totalWastedTokensIn).toBe(30);
      expect(summary.totalWastedTokensOut).toBe(15);
      expect(summary.topOffenders).toHaveLength(1);
      const [offender] = summary.topOffenders;
      expect(offender.toolName).toBe('search');
      expect(offender.fingerprint).toBe('fp-abc');
      expect(offender.loops).toBe(3);
      expect(offender.wastedCostUsd).toBeCloseTo(0.03, 6);
      expect(offender.wastedTokensIn).toBe(30);
      expect(offender.wastedTokensOut).toBe(15);
    });

    it('reflects counts after several loops detected on different tools', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const toolA = mkInput({ sessionId: 's1', toolName: 'toolA', fingerprint: 'fpA' });
      const toolB = mkInput({ sessionId: 's2', toolName: 'toolB', fingerprint: 'fpB' });

      for (let i = 0; i < 3; i++) detector.record(toolA);
      for (let i = 0; i < 3; i++) detector.record(toolB);

      const summary = detector.getSummary();
      expect(summary.activeLoops).toBe(2);
      expect(summary.totalLoopsDetected).toBe(2);
      expect(summary.totalWastedCostUsd).toBeCloseTo(0.06, 6); // $0.03 per loop
      expect(summary.totalWastedTokensIn).toBe(60);
      expect(summary.totalWastedTokensOut).toBe(30);
      expect(summary.topOffenders.map((o) => o.toolName).sort()).toEqual(['toolA', 'toolB']);
    });

    it('sorts topOffenders by wastedCostUsd descending, and respects topOffendersLimit', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const cheap = mkInput({ sessionId: 's1', toolName: 'cheap', fingerprint: 'fp1', costUsd: 0.01 });
      const mid = mkInput({ sessionId: 's2', toolName: 'mid', fingerprint: 'fp2', costUsd: 0.05 });
      const expensive = mkInput({ sessionId: 's3', toolName: 'expensive', fingerprint: 'fp3', costUsd: 0.1 });

      for (const input of [cheap, mid, expensive]) {
        detector.record(input);
        detector.record(input);
        detector.record(input);
      }

      const full = detector.getSummary();
      expect(full.topOffenders.map((o) => o.toolName)).toEqual(['expensive', 'mid', 'cheap']);
      // The limit only caps topOffenders — cumulative totals are unaffected.
      expect(full.totalLoopsDetected).toBe(3);

      const limited = detector.getSummary({ topOffendersLimit: 2 });
      expect(limited.topOffenders.map((o) => o.toolName)).toEqual(['expensive', 'mid']);
      expect(limited.totalLoopsDetected).toBe(3);

      const none = detector.getSummary({ topOffendersLimit: 0 });
      expect(none.topOffenders).toEqual([]);
      expect(none.totalLoopsDetected).toBe(3);
    });

    it('keeps cumulative totals unchanged across LRU eviction, while activeLoops reflects only what remains', () => {
      const detector = new ThrashDetector(resolveThrashConfig({ maxTrackedKeys: 5 }));

      // Detect 5 loops — fills the store to its 5-key capacity.
      for (let i = 0; i < 5; i++) {
        const input = mkInput({ sessionId: `s${i}`, toolName: `tool${i}`, fingerprint: `fp${i}` });
        detector.record(input);
        detector.record(input);
        detector.record(input);
      }

      const before = detector.getSummary();
      expect(before.activeLoops).toBe(5);
      expect(before.totalLoopsDetected).toBe(5);

      // Overflow the store with 15 brand-new, single-failure keys (count 1
      // each, below threshold — none of these detect a loop themselves),
      // more than enough to LRU-evict all 5 previously-detected entries.
      for (let i = 0; i < 15; i++) {
        detector.record(mkInput({ sessionId: `overflow-${i}`, toolName: `overflow-tool-${i}`, fingerprint: `overflow-fp-${i}` }));
      }

      const after = detector.getSummary();
      expect(after.activeLoops).toBe(0); // all 5 detected loops evicted; overflow entries never crossed threshold
      expect(after.totalLoopsDetected).toBe(5); // cumulative counter survives eviction, unlike activeLoops
      expect(after.totalWastedCostUsd).toBeCloseTo(before.totalWastedCostUsd, 6);
      expect(after.totalWastedTokensIn).toBe(before.totalWastedTokensIn);
      expect(after.totalWastedTokensOut).toBe(before.totalWastedTokensOut);
    });

    it('keeps cumulative totals unchanged after TTL expiry removes the entry from the live store', () => {
      const { clock, state } = makeClock(0);
      const detector = new ThrashDetector(resolveThrashConfig({ entryTtlMs: 1000 }), clock);
      const input = mkInput();

      detector.record(input);
      detector.record(input);
      detector.record(input); // detected at t=0

      const before = detector.getSummary();
      expect(before.activeLoops).toBe(1);
      expect(before.totalLoopsDetected).toBe(1);

      state.now = 5000; // well past entryTtlMs — the entry is now expired, though never explicitly deleted

      const after = detector.getSummary();
      expect(after.activeLoops).toBe(0); // expired entries are lazily excluded from the live scan
      expect(after.totalLoopsDetected).toBe(1); // cumulative counter survives TTL expiry, unlike activeLoops
      expect(after.totalWastedCostUsd).toBeCloseTo(before.totalWastedCostUsd, 6);
    });

    it('does not double-count a loop\'s early calls when it re-emits (delta-based accumulation)', () => {
      const detector = new ThrashDetector(resolveThrashConfig({ threshold: 3, reEmitAfter: 3 }));
      const input = mkInput({ tokensIn: 10, tokensOut: 5, costUsd: 0.01 }); // this call's own contribution

      for (let i = 0; i < 6; i++) detector.record(input); // emits at call 3 AND call 6 (re-emit)

      const summary = detector.getSummary();
      // 6 calls x $0.01 = $0.06 actually spent — NOT $0.03 (call 3's snapshot)
      // + $0.06 (call 6's snapshot) = $0.09, which naively summing every
      // emitted event's own cumulative total would produce.
      expect(summary.totalWastedCostUsd).toBeCloseTo(0.06, 6);
      expect(summary.totalWastedTokensIn).toBe(60);
      expect(summary.totalWastedTokensOut).toBe(30);
      // One episode, two emissions (3 and 6) — still just one detected loop.
      expect(summary.totalLoopsDetected).toBe(1);
    });

    it('returns a zeroed summary when detection is disabled, without ever throwing', () => {
      const detector = new ThrashDetector(resolveThrashConfig({ enabled: false }));
      const input = mkInput();
      for (let i = 0; i < 10; i++) detector.record(input);

      expect(() => detector.getSummary()).not.toThrow();
      expect(detector.getSummary()).toEqual({
        activeLoops: 0,
        totalLoopsDetected: 0,
        totalWastedCostUsd: 0,
        totalWastedTokensIn: 0,
        totalWastedTokensOut: 0,
        topOffenders: [],
      });
    });

    it('never throws for a malformed options argument, and falls back to the default limit', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      expect(() => detector.getSummary(null)).not.toThrow();
      expect(() => detector.getSummary('not-an-object')).not.toThrow();
      expect(() => detector.getSummary({ topOffendersLimit: -5 })).not.toThrow();
      expect(() => detector.getSummary({ topOffendersLimit: NaN })).not.toThrow();
      expect(detector.getSummary({ topOffendersLimit: -5 }).topOffenders).toEqual([]);
    });

    it('reset() also zeroes the cumulative counters, not just the store', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const input = mkInput();
      detector.record(input);
      detector.record(input);
      detector.record(input);
      expect(detector.getSummary().totalLoopsDetected).toBe(1);

      detector.reset();

      expect(detector.getSummary()).toEqual({
        activeLoops: 0,
        totalLoopsDetected: 0,
        totalWastedCostUsd: 0,
        totalWastedTokensIn: 0,
        totalWastedTokensOut: 0,
        topOffenders: [],
      });
    });

    it('getSummary() is a pure read: calling it repeatedly does not change subsequent record() results', () => {
      const detector = new ThrashDetector(resolveThrashConfig());
      const input = mkInput();
      detector.record(input);
      detector.record(input);

      // Reading the summary several times must not itself count as
      // activity, mutate the store, or otherwise perturb the hot path.
      detector.getSummary();
      detector.getSummary();
      detector.getSummary();

      const event = detector.record(input); // still the 3rd real failure
      expect(event?.loopLength).toBe(3);
    });
  });
});
