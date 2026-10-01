import type { MetaResponse, MetaDetector } from './types';

export type CompletenessLevel = 'complete' | 'partial' | 'unknown';

export interface Completeness {
  level: CompletenessLevel;
  message: string;
}

const DETECTOR_LABELS: Record<keyof MetaResponse['detectors'], string> = {
  thrashDetection: 'thrash',
  costTracking: 'budget',
  schemaDrift: 'schema drift',
  toolOutcome: 'tool outcome',
};

function namesWithStatus(detectors: MetaResponse['detectors'], status: MetaDetector['status']): string[] {
  return (Object.keys(detectors) as Array<keyof MetaResponse['detectors']>)
    .filter((key) => detectors[key].status === status)
    .map((key) => DETECTOR_LABELS[key]);
}

/**
 * Panel-level integrity for the observation matrix -- per your Step 5a
 * correction, ObservationIntegrity and in-memory tracker availability
 * qualify the ENTIRE matrix, not any individual cell. Uses /api/meta's
 * three-state detector status values AS-IS: 'unknown' is never flattened
 * into 'unavailable' for visual convenience, matching the Step 3
 * decision that a session-oriented transport is correlated risk, not
 * confirmed unavailability.
 */
export function computeCompleteness(meta: MetaResponse | null): Completeness {
  if (!meta) {
    return { level: 'unknown', message: 'Completeness unknown — waiting for /api/meta.' };
  }

  // ADR 022 (v0.1.0 publish): --demo mode has no live server at all, so the
  // "session-oriented transport, tracker state unconfirmed" wording below
  // would be actively wrong here — there is no transport to be unconfirmed
  // about. Checked before the detector-status logic, same short-circuit
  // describeInMemoryTrackerAvailability() (meta.js) applies server-side.
  if (meta.demo) {
    return {
      level: 'unknown',
      message: 'Demo mode — fixture spans, not live detector output. Point a real instrumented server at this dashboard to see tracker completeness.',
    };
  }

  const unavailable = namesWithStatus(meta.detectors, 'unavailable');
  const unknown = namesWithStatus(meta.detectors, 'unknown');

  if (unavailable.length > 0) {
    return {
      level: 'partial',
      message: `Partial view — ${unavailable.join(' and ')} tracker${unavailable.length > 1 ? 's' : ''} unavailable under this transport.`,
    };
  }

  if (unknown.length > 0) {
    return {
      level: 'unknown',
      message: `Completeness unknown — session-oriented transport, ${unknown.join('/')} tracker state unconfirmed.`,
    };
  }

  return { level: 'complete', message: 'Complete view — all four in-memory trackers live.' };
}
