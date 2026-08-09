/**
 * @module tool-outcome
 *
 * Runtime shape backing the `ToolOutcome` half of opentel-mcp's two-axis
 * observation contract (ADR 008, docs/adr/008-observation-liveness.md —
 * "Update (2026-08-05): The two-axis reframe"). Moved out of
 * opentel-mcp core (v0.9.0) so the emitter (opentel-mcp) and any consumer
 * (opentel-mcp-ui) import the exact same frozen object — see this
 * package's README for why that matters.
 *
 * This is a frozen constant object, not a TypeScript `enum` — this
 * package ships plain JS with hand-written `.d.ts` files (no compile
 * step), matching opentel-mcp core's own convention.
 */

/** @typedef {import('./tool-outcome.d.ts').ToolOutcome} ToolOutcome */

/** @type {Readonly<Record<'SUCCESS' | 'FAILURE' | 'UNKNOWN', ToolOutcome>>} */
export const TOOL_OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  UNKNOWN: 'UNKNOWN',
});
