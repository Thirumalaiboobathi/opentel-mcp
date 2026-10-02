import { describe, it, expect } from 'vitest';
import { computeHeroStat, type MatrixCounts } from './classify';

function counts(overrides: Partial<MatrixCounts> = {}): MatrixCounts {
  return { successVisible: 0, successMissed: 0, failureVisible: 0, failureMissed: 0, ...overrides };
}

describe('computeHeroStat', () => {
  it('demo fixture shape: 11 missed of 18 total failures (7 visible + 11 missed) -> 61%', () => {
    const result = computeHeroStat(counts({ failureVisible: 7, failureMissed: 11 }));
    expect(result).toEqual({ missed: 11, totalFailures: 18, percent: 61 });
  });

  it('includes successMissed (structurally near-always zero) in both missed and totalFailures', () => {
    const result = computeHeroStat(counts({ failureVisible: 1, failureMissed: 1, successMissed: 1 }));
    expect(result).toEqual({ missed: 2, totalFailures: 3, percent: 67 });
  });

  it('all failures visible, none missed -> 0%, not hidden', () => {
    const result = computeHeroStat(counts({ failureVisible: 5 }));
    expect(result).toEqual({ missed: 0, totalFailures: 5, percent: 0 });
  });

  it('all failures missed -> 100%', () => {
    const result = computeHeroStat(counts({ failureMissed: 4 }));
    expect(result).toEqual({ missed: 4, totalFailures: 4, percent: 100 });
  });

  it('zero failures -> percent is null, not NaN or Infinity (no divide-by-zero)', () => {
    const result = computeHeroStat(counts({ successVisible: 10 }));
    expect(result).toEqual({ missed: 0, totalFailures: 0, percent: null });
  });
});
