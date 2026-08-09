import type { ToolOutcomeCounts } from './tool-outcome.d.ts';

/**
 * Observation integrity, per ADR 008's two-axis contract
 * (docs/adr/008-observation-liveness.md — "Update (2026-08-05): The
 * two-axis reframe"). Deliberately a TWO-value type — `HEALTHY` is
 * absent, not merely unused: no code path in opentel-mcp, in any
 * `setupNodeSdk` configuration, can ever positively confirm telemetry is
 * flowing, so a `HEALTHY` member would be permanently unreachable
 * (Finding 1). See opentel-mcp's `detectObservationIntegrity()`
 * (`src/observation/integrity.js`).
 *
 * IMPORTANT — this is a property of the whole instrumented process, re-
 * evaluated on demand (see `ObservationState` below), NOT an attribute of
 * any individual span or tool call. There is no mechanism, in this
 * contract or in opentel-mcp's emission, that varies this value per
 * call — do not attach it to a per-span record or a per-call
 * classification; that would misrepresent what this axis measures. If
 * you're building something that wants "was THIS call observed," you
 * want `ToolOutcome`/`mcp.tool.outcome`, not this.
 */
export type ObservationIntegrity = 'DEGRADED' | 'UNKNOWN';

/**
 * Return shape of `instrumentMcpServer()`'s `getObservationState()`
 * accessor (ADR 008 "Update", Finding 4). Computed fresh on every call,
 * never cached from instrument time: `observationIntegrity` re-runs
 * `detectObservationIntegrity()` against whatever `TracerProvider` is
 * registered globally *at the moment of the call*, since a host may
 * register one asynchronously after `instrumentMcpServer()` already ran
 * — a value computed once at startup would go stale the instant that
 * happens. `toolOutcome` reads `ToolOutcomeCounter.getCounts()`'s current
 * cumulative totals.
 */
export interface ObservationState {
  toolOutcome: ToolOutcomeCounts;
  observationIntegrity: ObservationIntegrity;
}

/**
 * Frozen runtime enum object backing {@link ObservationIntegrity} — see
 * `observation-integrity.js`. Declared here, alongside the type, because
 * this file is the `.d.ts` companion `observation-integrity.js` resolves
 * to (same base name, same directory); it must declare every value that
 * module exports, not just the type.
 */
export const OBSERVATION_INTEGRITY: Readonly<Record<'DEGRADED' | 'UNKNOWN', ObservationIntegrity>>;
