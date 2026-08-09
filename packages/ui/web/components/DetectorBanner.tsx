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

/**
 * Persistent, non-dismissible, styled as information rather than a
 * warning — a tool that shows its own blind spots is more trustworthy
 * than one displaying a confident zero (ADR 012). Lists every detector
 * that ISN'T confidently live, using /api/meta's own reason text
 * verbatim rather than inventing new copy, so the banner never drifts
 * from what the backend actually determined.
 */
export function DetectorBanner({ meta }: Props) {
  if (!meta) return null;

  const entries = Object.entries(meta.detectors) as Array<[keyof MetaResponse['detectors'], MetaResponse['detectors'][keyof MetaResponse['detectors']]]>;
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

  return (
    <div className="detector-banner" role="status">
      {notLive.map(([key, detector]) => (
        <p key={key} className={`detector-banner-line detector-banner-${detector.status}`}>
          <span className="detector-banner-icon" aria-hidden="true">
            ●
          </span>
          <strong>{DETECTOR_LABELS[key]}:</strong> {detector.reason}
        </p>
      ))}
    </div>
  );
}
