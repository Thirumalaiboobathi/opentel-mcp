/**
 * @module summary
 *
 * Backs `/api/summary`. Two genuinely different kinds of number, kept in
 * separate, clearly-labeled buckets rather than merged into one grid —
 * see RUNLOG.md's Step 2/5 entries for why a literal ToolOutcome x
 * ObservationIntegrity 2x2 crosstab can't be built faithfully (ADR 008:
 * ObservationIntegrity is a process-level property, not a per-span one):
 *
 * - `observationState` — opentel-mcp core's own cumulative, OTel-
 *   independent bookkeeping (`getObservationState()`, if attached; `null`
 *   when the instrumented server has `enabled: false` or doesn't have the
 *   accessor for any other reason). Lifetime counts, since the counter was
 *   constructed — see ADR 012 for why that's not necessarily "since the
 *   process started" under some deployment shapes.
 * - `buffered` — real per-span counts derived from whatever
 *   `SerializedSpan`s are CURRENTLY held in this dashboard's bounded ring
 *   buffer (so: a recent window, capped at buffer capacity, not a
 *   lifetime total — the two will diverge under sustained traffic, by
 *   design, and both are reported so a consumer can tell).
 */

/** @typedef {import('./types.d.ts').SerializedSpan} SerializedSpan */
/** @typedef {import('opentel-mcp').ObservationState} ObservationState */
/** @typedef {import('./span-buffer.js').SpanBuffer} SpanBuffer */

/**
 * @param {SerializedSpan[]} spans
 */
function summarizeBufferedSpans(spans) {
  const summary = { total: spans.length, success: 0, error: 0, silentFailure: 0 };
  for (const span of spans) {
    if (span.errorType === 'tool_error') summary.silentFailure++;
    else if (span.status === 'ERROR') summary.error++;
    else summary.success++;
  }
  return summary;
}

/**
 * @param {{ instrumentedServer: *, buffer: SpanBuffer }} options
 * @returns {{ observationState: ObservationState | null, buffered: ReturnType<typeof summarizeBufferedSpans> }}
 */
export function computeSummary({ instrumentedServer, buffer }) {
  const observationState =
    typeof instrumentedServer?.getObservationState === 'function' ? instrumentedServer.getObservationState() : null;

  return {
    observationState,
    buffered: summarizeBufferedSpans(buffer.toArray()),
  };
}
