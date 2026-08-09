/**
 * Shared type definitions for the two-axis observation contract (ADR 008,
 * docs/adr/008-observation-liveness.md — "Update (2026-08-05): The
 * two-axis reframe").
 *
 * v0.9.0: `ToolOutcome`, `ToolOutcomeCounts`, `ObservationIntegrity`, and
 * `ObservationState` moved to the standalone `opentel-mcp-contract`
 * package (zero runtime dependencies — types and frozen constants only),
 * so this library's emission and any consumer (e.g. opentel-mcp-ui) share
 * the exact same definitions and can't drift apart. This file is now a
 * thin re-export so every internal call site that already imports from
 * `./types.d.ts` (this file) keeps working unchanged. `ToolOutcomeCounter`
 * and `detectObservationIntegrity()` themselves stay internal to
 * instrument.js's wiring, not part of the public API — same posture as
 * `ThrashDetector`/`SchemaDriftDetector`.
 */
export type { ToolOutcome, ToolOutcomeCounts, ObservationIntegrity, ObservationState } from 'opentel-mcp-contract';
