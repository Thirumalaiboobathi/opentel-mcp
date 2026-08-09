/**
 * @module observation-integrity
 *
 * Runtime shape backing the `ObservationIntegrity` half of opentel-mcp's
 * two-axis observation contract (ADR 008 "Update"). Moved out of
 * opentel-mcp core (v0.9.0) — the *detection* logic
 * (`detectObservationIntegrity()`, which depends on `@opentelemetry/api`)
 * stays in core, since this package has zero runtime dependencies; only
 * the frozen enum shape moves here.
 *
 * Two, and only two, reachable values: `DEGRADED | UNKNOWN`. `HEALTHY` is
 * deliberately absent from the type entirely — no code path in
 * opentel-mcp, in any `setupNodeSdk` configuration, can positively
 * confirm telemetry is flowing (ADR 008, Finding 1). Including a
 * `HEALTHY` value that could never be produced would be an unreachable
 * enum member.
 */

/** @typedef {import('./observation-integrity.d.ts').ObservationIntegrity} ObservationIntegrity */

/** @type {Readonly<Record<'DEGRADED' | 'UNKNOWN', ObservationIntegrity>>} */
export const OBSERVATION_INTEGRITY = Object.freeze({
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
});
