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
    const s2Event = detector.record(s2); // session-2's 3rd, independently
    expect(s2Event?.loopLength).toBe(3);
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
});
