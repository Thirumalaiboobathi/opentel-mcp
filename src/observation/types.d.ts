/**
 * Shared type definitions for the two-axis observation contract (ADR 008,
 * docs/adr/008-observation-liveness.md — "Update (2026-08-05): The
 * two-axis reframe" — Phase 1: the `ToolOutcome` counter; Phase 2:
 * `ObservationIntegrity` detection; Phase 3: the `getObservationState()`
 * accessor and wiring; Phase 4: this file's re-export from
 * src/index.d.ts).
 *
 * Hand-written, not a compiled build artifact — this project ships plain
 * JS with no TypeScript build step (see CONTRIBUTING.md). `ToolOutcome`,
 * `ToolOutcomeCounts`, `ObservationIntegrity`, and `ObservationState` are
 * re-exported from src/index.d.ts (via `instrumentMcpServer()`'s
 * `getObservationState()` return type) — the same pattern
 * src/thrash/types.d.ts's `ThrashSummary` already establishes.
 * `ToolOutcomeCounter` and `detectObservationIntegrity()` themselves stay
 * internal to instrument.js's wiring, not part of the public API — same
 * posture as `ThrashDetector`/`SchemaDriftDetector`.
 */

/**
 * One tool call's outcome, per ADR 008's two-axis observation contract.
 * Uppercase literals, matching the ADR's own notation (`ToolOutcome:
 * SUCCESS | FAILURE | UNKNOWN`) — deliberately distinct from the
 * lowercase snake_case convention this package uses for actual OTel span/
 * metric attribute values (e.g. `mcp.tool.outcome`'s `'success'` /
 * `'error'`) since `ToolOutcome` is not an OTel attribute at all; the
 * entire point of this axis is that it's computed independently of OTel.
 *
 * Not itself the shape `getObservationState()` returns — see
 * `ObservationState` below, which reports the raw `ToolOutcomeCounts`
 * breakdown, not a single collapsed `ToolOutcome` verdict (the ADR's
 * Finding 3 names the concept; this rollout exposes the counts it's
 * derived from, not a computed single value).
 */
export type ToolOutcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

/**
 * Cumulative tool-call outcome counts since this counter was constructed
 * — see src/observation/tool-outcome-counter.js's
 * `ToolOutcomeCounter.getCounts()`. In-memory, no per-session or per-tool
 * breakdown in this phase. Scoped to the `instrumentMcpServer()` call
 * that constructed the counter, NOT necessarily the whole process — see
 * that module's docblock and ADR 012
 * (docs/adr/012-tracker-lifecycle-and-shared-state.md) for why those are
 * only equivalent under a long-lived, once-per-process instrumented
 * instance.
 */
export interface ToolOutcomeCounts {
  success: number;
  failure: number;
  unknown: number;
}

/**
 * Observation integrity, per ADR 008's two-axis contract. Deliberately a
 * TWO-value type — `HEALTHY` is absent, not merely unused: the ADR's
 * Finding 1 concluded no code path in this library, in any
 * `setupNodeSdk` configuration, can ever positively confirm telemetry is
 * flowing, so a `HEALTHY` member would be permanently unreachable. See
 * src/observation/integrity.js's `detectObservationIntegrity()`.
 */
export type ObservationIntegrity = 'DEGRADED' | 'UNKNOWN';

/**
 * Return shape of `instrumentMcpServer()`'s `getObservationState()`
 * accessor (ADR 008 "Update", Finding 4 — src/instrument.js). Computed
 * fresh on every call, never cached from instrument time:
 * `observationIntegrity` re-runs `detectObservationIntegrity()` against
 * whatever `TracerProvider` is registered globally *at the moment of the
 * call*, since a host may register one asynchronously after
 * `instrumentMcpServer()` already ran — a value computed once at startup
 * would go stale the instant that happens. `toolOutcome` reads
 * `ToolOutcomeCounter.getCounts()`'s current cumulative totals.
 */
export interface ObservationState {
  toolOutcome: ToolOutcomeCounts;
  observationIntegrity: ObservationIntegrity;
}
