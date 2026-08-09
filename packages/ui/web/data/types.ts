import type { ObservationState } from 'opentel-mcp-contract';

/** Mirrors meta.js's DetectorAvailability + { reason } shape exactly. */
export interface MetaDetector {
  status: 'live' | 'unavailable' | 'unknown';
  reason: string;
}

/** Mirrors server.js's GET /api/meta response shape exactly. */
export interface MetaResponse {
  coreVersion: string;
  uiVersion: string;
  transport: { shape: 'single-connection' | 'session-oriented' | 'undeterminable' };
  buffer: { capacity: number; size: number; totalPushed: number };
  detectors: {
    thrashDetection: MetaDetector;
    costTracking: MetaDetector;
    schemaDrift: MetaDetector;
    toolOutcome: MetaDetector;
  };
}

/**
 * Mirrors summary.js's GET /api/summary response shape exactly -- kept as
 * two separate, honestly-labeled buckets per your Step 3/5 correction:
 * `observationState` (core's own cumulative bookkeeping) and `buffered`
 * (real per-span counts). Never merge these into one object for
 * rendering convenience.
 */
export interface SummaryResponse {
  observationState: ObservationState | null;
  buffered: { total: number; success: number; error: number; silentFailure: number };
}
