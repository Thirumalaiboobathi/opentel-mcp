import { describe, it, expect } from 'vitest';
import { ThrashDetector } from '../../src/thrash/detector.js';
import { resolveThrashConfig } from '../../src/thrash/config.js';

/**
 * ADR 007, Phase 3: per-origin (channel) thresholds for Agent Thrash
 * Detection. See docs/adr/007-protocol-error-channel.md.
 */

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

describe('ThrashDetector — per-origin (channel) thresholds', () => {
  it('execution channel uses the unchanged default threshold (3)', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ channel: 'execution' });

    expect(detector.record(input)).toBeNull(); // 1
    expect(detector.record(input)).toBeNull(); // 2
    expect(detector.record(input)?.loopLength).toBe(3); // 3rd — crosses threshold
  });

  it('protocol.input uses the separately configured, higher inputThreshold (default 5)', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ channel: 'protocol.input' });

    expect(detector.record(input)).toBeNull(); // 1
    expect(detector.record(input)).toBeNull(); // 2
    expect(detector.record(input)).toBeNull(); // 3 — would already have fired at the execution threshold
    expect(detector.record(input)).toBeNull(); // 4
    expect(detector.record(input)?.loopLength).toBe(5); // 5th — crosses inputThreshold
  });

  it('protocol.input threshold is independently configurable', () => {
    const detector = new ThrashDetector(resolveThrashConfig({ inputThreshold: 2 }));
    const input = mkInput({ channel: 'protocol.input' });

    expect(detector.record(input)).toBeNull(); // 1
    expect(detector.record(input)?.loopLength).toBe(2); // 2nd — crosses the configured inputThreshold
  });

  it('protocol.not_found flags immediately by default (notFoundThreshold: 1)', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ channel: 'protocol.not_found' });

    const event = detector.record(input); // 1st call already crosses threshold 1
    expect(event?.loopLength).toBe(1);
  });

  it('protocol.not_found threshold is independently configurable', () => {
    const detector = new ThrashDetector(resolveThrashConfig({ notFoundThreshold: 2 }));
    const input = mkInput({ channel: 'protocol.not_found' });

    expect(detector.record(input)).toBeNull(); // 1
    expect(detector.record(input)?.loopLength).toBe(2); // 2nd
  });

  it('protocol.other and unknown fall back to the shared default threshold', () => {
    const detector = new ThrashDetector(resolveThrashConfig());

    const other = mkInput({ channel: 'protocol.other', fingerprint: 'fp-other' });
    expect(detector.record(other)).toBeNull();
    expect(detector.record(other)).toBeNull();
    expect(detector.record(other)?.loopLength).toBe(3);

    const unknown = mkInput({ channel: 'unknown', fingerprint: 'fp-unknown' });
    expect(detector.record(unknown)).toBeNull();
    expect(detector.record(unknown)).toBeNull();
    expect(detector.record(unknown)?.loopLength).toBe(3);
  });

  it('a missing channel (backward compatibility) behaves exactly like the pre-Phase-3 default threshold', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput(); // no channel at all

    expect(detector.record(input)).toBeNull();
    expect(detector.record(input)).toBeNull();
    expect(detector.record(input)?.loopLength).toBe(3);
  });
});

describe('ThrashDetector — protocol.output is never counted as thrash (ADR 007)', () => {
  it('never emits a thrash event for protocol.output, no matter how many times it repeats', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ channel: 'protocol.output' });

    for (let i = 0; i < 50; i++) {
      expect(detector.record(input)).toBeNull();
    }
  });

  it('does not contribute to totalLoopsDetected or the wasted totals', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const input = mkInput({ channel: 'protocol.output', tokensIn: 1000, tokensOut: 1000, costUsd: 5 });

    for (let i = 0; i < 10; i++) detector.record(input);

    const summary = detector.getSummary();
    expect(summary.totalLoopsDetected).toBe(0);
    expect(summary.totalWastedCostUsd).toBe(0);
    expect(summary.activeLoops).toBe(0);
  });

  it('a separate execution-channel failure on the same tool is unaffected and still thrashes normally', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const outputInput = mkInput({ channel: 'protocol.output', fingerprint: 'fp-output' });
    const execInput = mkInput({ channel: 'execution', fingerprint: 'fp-exec' });

    for (let i = 0; i < 10; i++) detector.record(outputInput);

    expect(detector.record(execInput)).toBeNull();
    expect(detector.record(execInput)).toBeNull();
    expect(detector.record(execInput)?.loopLength).toBe(3);
  });
});

describe('ThrashDetector — mixed-origin failures on one tool do not merge into a single loop', () => {
  it('the same tool+session+fingerprint on different channels tracks independent counts', () => {
    // Same fingerprint deliberately reused across channels: this proves
    // channel is part of the tracking key, not relying on fingerprints
    // happening to differ across channels (see ThrashKey's docblock).
    const detector = new ThrashDetector(resolveThrashConfig());
    const sharedFingerprint = 'fp-shared';
    const exec = mkInput({ channel: 'execution', fingerprint: sharedFingerprint });
    const input = mkInput({ channel: 'protocol.input', fingerprint: sharedFingerprint });
    const notFound = mkInput({ channel: 'protocol.not_found', fingerprint: sharedFingerprint });

    // Interleaved calls across three channels on the same tool/session/fingerprint.
    expect(detector.record(exec)).toBeNull(); // execution count 1
    expect(detector.record(input)).toBeNull(); // protocol.input count 1
    const notFoundEvent = detector.record(notFound); // protocol.not_found count 1 -- already crosses threshold 1
    expect(notFoundEvent?.loopLength).toBe(1);

    expect(detector.record(exec)).toBeNull(); // execution count 2, NOT 3 -- proves no merge with the other channels
    expect(detector.record(input)).toBeNull(); // protocol.input count 2, NOT 3

    const execEvent = detector.record(exec); // execution count 3
    expect(execEvent?.loopLength).toBe(3);
  });

  it('clearOnSuccess only clears the most-recently-active channel, leaving other channels tracked independently', () => {
    const detector = new ThrashDetector(resolveThrashConfig());
    const sharedFingerprint = 'fp-shared-2';
    const notFound = mkInput({ channel: 'protocol.not_found', fingerprint: sharedFingerprint });
    const exec = mkInput({ channel: 'execution', fingerprint: sharedFingerprint });

    detector.record(notFound); // flags immediately (threshold 1), becomes the "most recently active" entry
    detector.record(exec); // execution count 1 -- exec is now most-recently-active
    detector.record(exec); // execution count 2

    detector.clearOnSuccess(exec.sessionId, exec.toolName); // clears execution's episode only

    // Execution restarts fresh; protocol.not_found's already-fired episode
    // is untouched by the success (it happened on a different channel).
    expect(detector.record(exec)).toBeNull(); // fresh count 1, not count 3
    expect(detector.record(exec)).toBeNull(); // fresh count 2
    expect(detector.record(exec)?.loopLength).toBe(3); // fresh count 3
  });
});
