import type { MatrixCounts } from '../data/classify';
import { computeHeroStat } from '../data/classify';
import './HeroStat.css';

interface Props {
  counts: MatrixCounts;
}

/**
 * The headline, shown above everything else: of all the failures in the
 * buffer, how many would a standard OTel setup have rendered as a clean,
 * successful span. Computed from the exact same `MatrixCounts` the
 * matrix below renders -- never a separate count that could drift from
 * it. Zero failures is a real, expected state (a quiet buffer, or one
 * that's all successes) -- shown as a neutral message, not "0 of 0
 * (NaN%)".
 */
export function HeroStat({ counts }: Props) {
  const { missed, totalFailures, percent } = computeHeroStat(counts);

  if (totalFailures === 0) {
    return (
      <p className="hero-stat hero-stat-empty">No failures observed yet in this buffer.</p>
    );
  }

  return (
    <p className="hero-stat">
      <span className="hero-stat-number">{missed}</span> of <span className="hero-stat-number">{totalFailures}</span>{' '}
      failures were invisible to standard OTel
      <span className="hero-stat-percent"> ({percent}%)</span>
    </p>
  );
}
