import type { MetaResponse } from '../data/types';
import './DetectorBanner.css';

interface Props {
  meta: MetaResponse | null;
}

const DETECTOR_LABELS: Record<keyof MetaResponse['detectors'], string> = {
  thrashDetection: 'Thrash detection',
  costTracking: 'Cost/budget tracking',
  schemaDrift: 'Schema drift detection',
  toolOutcome: 'ToolOutcome counting',
};

type DetectorEntry = [keyof MetaResponse['detectors'], MetaResponse['detectors'][keyof MetaResponse['detectors']]];

/**
 * Persistent, non-dismissible, styled as information rather than a
 * warning — a tool that shows its own blind spots is more trustworthy
 * than one displaying a confident zero (ADR 012). Lists every detector
 * that ISN'T confidently live, using /api/meta's own reason text
 * verbatim rather than inventing new copy, so the banner never drifts
 * from what the backend actually determined.
 *
 * Detectors that share the exact same reason (the common case: all four
 * trackers hit the identical structural cause, e.g. a session-oriented
 * transport) are collapsed into ONE notice naming all of them, rather
 * than four near-identical paragraphs repeating the same sentence.
 */
export function DetectorBanner({ meta }: Props) {
  if (!meta) return null;

  // ADR 022 (v0.1.1): --demo mode's fixture data already stands in for
  // live detector output (meta.js reports status: 'live' for exactly
  // this reason) -- a small "demo data" badge is the honest, low-noise
  // equivalent of the full banner here, not the four-line warning list
  // or the "all four live" message (neither of which is true: nothing is
  // actually tracking anything in this mode).
  if (meta.demo) {
    return (
      <div className="detector-banner-demo-badge" role="status">
        <span className="detector-banner-icon" aria-hidden="true">
          ●
        </span>
        Demo data — fixture spans, not live detector output.
      </div>
    );
  }

  const entries = Object.entries(meta.detectors) as DetectorEntry[];
  const notLive = entries.filter(([, d]) => d.status !== 'live');

  if (notLive.length === 0) {
    return (
      <div className="detector-banner detector-banner-complete" role="status">
        <span className="detector-banner-icon" aria-hidden="true">
          ●
        </span>
        All four in-memory trackers live for this session.
      </div>
    );
  }

  const groups: Array<{ reason: string; status: string; entries: DetectorEntry[] }> = [];
  for (const entry of notLive) {
    const [, detector] = entry;
    const group = groups.find((g) => g.reason === detector.reason);
    if (group) group.entries.push(entry);
    else groups.push({ reason: detector.reason, status: detector.status, entries: [entry] });
  }

  return (
    <div className="detector-banner" role="status">
      {groups.map((group) => {
        const labels = group.entries.map(([key]) => DETECTOR_LABELS[key]).join(', ');
        return (
          <p key={labels} className={`detector-banner-line detector-banner-${group.status}`}>
            <span className="detector-banner-icon" aria-hidden="true">
              ●
            </span>
            <span className="detector-banner-notice-labels">{labels}:</span> {group.reason}
          </p>
        );
      })}
    </div>
  );
}
