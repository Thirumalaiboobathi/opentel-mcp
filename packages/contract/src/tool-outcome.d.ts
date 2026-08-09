/**
 * One tool call's outcome, per ADR 008's two-axis observation contract.
 * Uppercase literals, matching the ADR's own notation (`ToolOutcome:
 * SUCCESS | FAILURE | UNKNOWN`) — deliberately distinct from the
 * lowercase snake_case convention opentel-mcp uses for actual OTel span/
 * metric attribute values (e.g. `mcp.tool.outcome`'s `'success'` /
 * `'error'` / `'silent_failure'`, see attributes.d.ts in this package)
 * since `ToolOutcome` is not an OTel attribute at all — it is a
 * cumulative, OTel-independent count (see `ToolOutcomeCounts` below),
 * deliberately duplicating what the span/metric already express so it
 * stays trustworthy even when the OTel pipeline itself isn't confirmed
 * healthy (ADR 008, Finding 5).
 */
export type ToolOutcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

/**
 * Cumulative tool-call outcome counts since the counter that produced
 * them was constructed — see opentel-mcp's `ToolOutcomeCounter`
 * (`src/observation/tool-outcome-counter.js`). In-memory, no per-session
 * or per-tool breakdown. Scoped to the `instrumentMcpServer()` call that
 * constructed the counter, NOT necessarily the whole process — see ADR
 * 012 (docs/adr/012-tracker-lifecycle-and-shared-state.md) for why those
 * are only equivalent under a long-lived, once-per-process instrumented
 * instance.
 */
export interface ToolOutcomeCounts {
  success: number;
  failure: number;
  unknown: number;
}

/**
 * Frozen runtime enum object backing {@link ToolOutcome} — see
 * `tool-outcome.js`. Declared here, alongside the type, because this file
 * is the `.d.ts` companion `tool-outcome.js` resolves to (same base name,
 * same directory); it must declare every value that module exports, not
 * just the type.
 */
export const TOOL_OUTCOME: Readonly<Record<'SUCCESS' | 'FAILURE' | 'UNKNOWN', ToolOutcome>>;
