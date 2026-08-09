import type { SerializedSpan } from '../../src/types.d.ts';
import type { SummaryResponse } from './types';

/**
 * The four matrix cells, per your Step 5a correction: rows are
 * ToolOutcome (SUCCESS/FAILURE), columns are per-span OTel visibility
 * derived from `errorType`. `successMissed` is structurally near-always
 * empty by construction (opentel-mcp core only ever sets `errorType:
 * 'tool_error'` in the same branch that also sets span status ERROR --
 * see instrument.js's isError branch) -- kept as a real, distinct cell
 * rather than folded away, so the matrix can render and explain the
 * empty cell rather than hide it.
 */
export type MatrixCell = 'successVisible' | 'successMissed' | 'failureVisible' | 'failureMissed';

/**
 * Per-span classification, used ONLY to filter the feed (5b) when a
 * matrix cell is clicked -- exactly mirrors opentel-mcp-ui's own backend
 * classification (src/summary.js's summarizeBufferedSpans()). NOT used
 * to compute the matrix's displayed counts -- those are sourced directly
 * from `/api/summary`'s `buffered` bucket (see `matrixCountsFromSummary`
 * below), which is the backend's own authoritative bucketing of its
 * actual ring buffer, not a client-side recomputation that could drift
 * from it (e.g. during a brief SSE reconnect gap).
 */
export function classifySpan(span: SerializedSpan): MatrixCell {
  const isMissedByOtel = span.errorType === 'tool_error';
  const isFailure = span.status === 'ERROR';

  if (isFailure && isMissedByOtel) return 'failureMissed';
  if (isFailure) return 'failureVisible';
  if (isMissedByOtel) return 'successMissed'; // structurally near-impossible; see above
  return 'successVisible';
}

export interface MatrixCounts {
  successVisible: number;
  successMissed: number;
  failureVisible: number;
  failureMissed: number;
}

/**
 * Maps `/api/summary`'s three-bucket `buffered` shape onto the matrix's
 * four cells. `successMissed` has no corresponding backend bucket at all
 * -- summary.js's own classification never produces it (a span can't
 * have `errorType: 'tool_error'` without also having `status: 'ERROR'`,
 * by construction in opentel-mcp core's emission) -- so it is always 0
 * here, not estimated or omitted.
 */
export function matrixCountsFromSummary(summary: SummaryResponse | null): MatrixCounts {
  const buffered = summary?.buffered ?? { total: 0, success: 0, error: 0, silentFailure: 0 };
  return {
    successVisible: buffered.success,
    successMissed: 0,
    failureVisible: buffered.error,
    failureMissed: buffered.silentFailure,
  };
}
