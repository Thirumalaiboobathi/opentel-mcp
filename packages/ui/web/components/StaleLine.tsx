import type { SerializedSpan } from '../../src/types.d.ts';
import { isStale } from '../data/freshness';
import './HeroStat.css';

/**
 * The one staleness line under the hero (ADR 027, core 0.17.0+). Stale
 * responses aren't failures, so they stay out of the hero's own sentence;
 * this sits beneath it and opens the feed's Stale data view. Renders
 * nothing when there are none, which also covers older cores (they never
 * set the freshness attributes).
 */
export function StaleLine({ spans, onOpen }: { spans: SerializedSpan[]; onOpen: () => void }) {
  const stale = spans.filter(isStale);
  if (stale.length === 0) return null;
  const tools = new Set(stale.map((s) => s.toolName ?? s.name)).size;

  return (
    <button type="button" className="hero-stale-line" data-testid="hero-stale-line" onClick={onOpen}>
      <span className="hero-stale-number mono">{stale.length}</span> response{stale.length === 1 ? '' : 's'} served
      stale data across {tools} tool{tools === 1 ? '' : 's'} <span aria-hidden="true">→</span>
    </button>
  );
}
