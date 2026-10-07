import { describe, it, expect } from 'vitest';
import { computeCompleteness } from './completeness';
import type { MetaResponse } from './types';

function meta(overrides: Partial<MetaResponse> = {}): MetaResponse {
  return {
    coreVersion: '0.14.0',
    uiVersion: '0.1.0',
    demo: false,
    transport: { shape: 'undeterminable' },
    buffer: { capacity: 1000, size: 0, totalPushed: 0 },
    detectors: {
      thrashDetection: { status: 'live', reason: '' },
      costTracking: { status: 'live', reason: '' },
      schemaDrift: { status: 'live', reason: '' },
      toolOutcome: { status: 'live', reason: '' },
    },
    ...overrides,
  };
}

describe('computeCompleteness -- demo mode (ADR 022)', () => {
  it('returns null -- no completeness line at all, since the DetectorBanner badge already says "Demo data" (never the "session-oriented transport" wording meant for a real server)', () => {
    const result = computeCompleteness(
      meta({
        demo: true,
        detectors: {
          thrashDetection: { status: 'unknown', reason: '' },
          costTracking: { status: 'unknown', reason: '' },
          schemaDrift: { status: 'unknown', reason: '' },
          toolOutcome: { status: 'unknown', reason: '' },
        },
      }),
    );
    expect(result).toBeNull();
  });

  it('non-demo, all trackers live: reports complete, unaffected by the new branch', () => {
    const result = computeCompleteness(meta());
    expect(result).toEqual({ level: 'complete', message: 'Complete view — all four in-memory trackers live.' });
  });
});

describe('computeCompleteness -- unknown-tracker-state wording (v0.1.1)', () => {
  it("plain language in the inline message -- no 'session-oriented transport'/'tracker state unconfirmed' jargon for a first-time user", () => {
    const result = computeCompleteness(
      meta({
        detectors: {
          thrashDetection: { status: 'unknown', reason: '' },
          costTracking: { status: 'unknown', reason: '' },
          schemaDrift: { status: 'unknown', reason: '' },
          toolOutcome: { status: 'unknown', reason: '' },
        },
      }),
    );
    expect(result?.level).toBe('unknown');
    expect(result?.message).not.toContain('session-oriented transport');
    expect(result?.message).not.toContain('tracker state unconfirmed');
  });

  it('moves the technical detail (including the withUI() hint) into `detail`, not the inline message', () => {
    const result = computeCompleteness(
      meta({
        detectors: {
          thrashDetection: { status: 'unknown', reason: '' },
          costTracking: { status: 'live', reason: '' },
          schemaDrift: { status: 'live', reason: '' },
          toolOutcome: { status: 'live', reason: '' },
        },
      }),
    );
    expect(result?.detail).toContain('Session-oriented transport');
    expect(result?.detail).toContain('thrash');
    expect(result?.detail).toContain('withUI()');
  });
});
