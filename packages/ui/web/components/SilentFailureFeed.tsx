import { useEffect, useRef, useState } from 'react';
import type { SerializedSpan } from '../../src/types.d.ts';
import { classifySpan, type MatrixCell } from '../data/classify';
import { hasUnactionableSignal, isUnactionable } from '../data/unactionable';
import { VirtualizedList } from './VirtualizedList';
import './SilentFailureFeed.css';

interface Props {
  spans: SerializedSpan[];
  selectedCell: MatrixCell | null;
}

// Bug (v0.1.0): a single fixed itemHeight (96) was shorter than the
// tallest row -- the failureMissed two-card comparison -- at every
// width this was actually checked at, including plain desktop widths
// with no wrapping involved. VirtualizedList gives each row an absolutely
// positioned, fixed-height slot (see VirtualizedList.tsx); content taller
// than that slot doesn't just clip, it bleeds down into the next row's
// slot, which is what read as "the next row's tool name overlaps the
// previous cards." Below MOBILE_BREAKPOINT_PX, SilentFailureFeed.css also
// stacks the two comparison cards into one column (full card width
// avoids the pill text wrapping it would otherwise need at ~300px of
// available content width) -- that layout is taller, so the row height
// below the breakpoint is taller too, kept in sync with the same
// breakpoint via `useIsNarrowViewport`.
const DESKTOP_ROW_HEIGHT = 116;
const MOBILE_ROW_HEIGHT = 184;
const MOBILE_BREAKPOINT_PX = 560;
const LIST_HEIGHT = 480;

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** Mirrors the `@media (max-width: ${MOBILE_BREAKPOINT_PX}px)` breakpoint in SilentFailureFeed.css. */
function useIsNarrowViewport(breakpointPx: number): boolean {
  const [isNarrow, setIsNarrow] = useState(
    () => supportsMatchMedia() && window.matchMedia(`(max-width: ${breakpointPx}px)`).matches,
  );

  useEffect(() => {
    if (!supportsMatchMedia()) return undefined;
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpointPx]);

  return isNarrow;
}

const CELL_LABELS: Record<MatrixCell, string> = {
  successVisible: 'Successful calls',
  successMissed: 'Successful calls missed by OTel (structurally empty)',
  failureVisible: 'Failures visible to standard OTel',
  failureMissed: 'Silent failures — missed by standard OTel',
};

/**
 * The feed below the matrix. Defaults to `failureMissed` (silent
 * failures) with no cell selected — that comparison is the demo, per the
 * design brief. Clicking any OTHER matrix cell filters this list to that
 * cell instead (per the Step 5a acceptance criterion), using the exact
 * same per-span classification the matrix summary is checked against.
 *
 * Each row is the side-by-side comparison the whole project exists to
 * make for FAILURE rows: what a naive/standard OTel setup would show for
 * this call versus what opentel-mcp actually detected. SUCCESS rows have
 * no discrepancy to illustrate, so they render as a single plain line —
 * the two-pane treatment is reserved for the cases where it's the point.
 */
export function SilentFailureFeed({ spans, selectedCell }: Props) {
  const activeCell = selectedCell ?? 'failureMissed';
  const [onlyUnactionable, setOnlyUnactionable] = useState(false);
  const inCell = spans.filter((s) => classifySpan(s) === activeCell);
  // ADR 025 filter: only on the silent-failure view, and only once some
  // span in the buffer actually carries the attribute (core 0.16.0+).
  const showUnactionableFilter = activeCell === 'failureMissed' && hasUnactionableSignal(inCell);
  const unactionableCount = showUnactionableFilter ? inCell.filter(isUnactionable).length : 0;
  const filtered = showUnactionableFilter && onlyUnactionable ? inCell.filter(isUnactionable) : inCell;
  // Newest first -- a live feed reads top-down like a log/chat stream.
  const ordered = [...filtered].reverse();

  const newIds = useNewlyArrivedIds(filtered);
  const isNarrow = useIsNarrowViewport(MOBILE_BREAKPOINT_PX);
  const rowHeight = isNarrow ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT;

  return (
    <section className="feed-panel" aria-label="Span feed">
      <h2 className="panel-title">{CELL_LABELS[activeCell]}</h2>
      {activeCell === 'failureMissed' && (
        <p className="feed-subtitle">
          Calls where <code className="mono">isError: true</code> was reported inside an otherwise-successful
          response — the exact case a standard OpenTelemetry setup renders as a clean, successful span.
        </p>
      )}

      {showUnactionableFilter && (
        <div className="feed-filter" role="group" aria-label="Filter silent failures">
          <button
            type="button"
            className="feed-filter-option"
            aria-pressed={!onlyUnactionable}
            onClick={() => setOnlyUnactionable(false)}
          >
            All silent failures <span className="mono">({inCell.length})</span>
          </button>
          <button
            type="button"
            className="feed-filter-option"
            aria-pressed={onlyUnactionable}
            data-testid="unactionable-filter"
            title="isError: true with no content, or under 10 characters of text and nothing else — the agent can't tell what went wrong or what to do next."
            onClick={() => setOnlyUnactionable(true)}
          >
            Errors your agent can't act on <span className="mono" data-testid="unactionable-count">({unactionableCount})</span>
          </button>
        </div>
      )}

      <VirtualizedList
        items={ordered}
        itemHeight={rowHeight}
        height={LIST_HEIGHT}
        emptyState={<p className="feed-empty">No spans in this category yet.</p>}
        renderItem={(span) => <FeedRow span={span} cell={activeCell} isNew={newIds.has(span.id)} />}
      />
    </section>
  );
}

/**
 * Tracks which span ids are new SINCE THE LAST RENDER of this list (not
 * "new since mount" -- the initial history load must not fade in every
 * row at once, only spans that arrive live afterward). Motion is
 * functional only, per the design brief: this is the one thing that
 * animates.
 */
function useNewlyArrivedIds(spans: SerializedSpan[]): Set<string> {
  const seenRef = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(spans.map((s) => s.id));
    if (seenRef.current === null) {
      // First render with data -- treat everything already present as
      // "seen," not "new," so the initial history load doesn't burst-
      // animate every row.
      seenRef.current = currentIds;
      return;
    }
    const freshlyArrived = new Set<string>();
    for (const id of currentIds) {
      if (!seenRef.current.has(id)) freshlyArrived.add(id);
    }
    if (freshlyArrived.size > 0) {
      setNewIds(freshlyArrived);
      seenRef.current = currentIds;
    }
  }, [spans]);

  return newIds;
}

function FeedRow({ span, cell, isNew }: { span: SerializedSpan; cell: MatrixCell; isNew: boolean }) {
  const isFailure = cell === 'failureVisible' || cell === 'failureMissed';

  return (
    <div className={`feed-row ${isNew ? 'fade-in' : ''}`}>
      <div className="feed-row-meta">
        <span className="mono feed-tool-name">{span.toolName ?? span.name}</span>
        <span className="mono feed-timestamp">{new Date(span.startTimeMs).toLocaleTimeString()}</span>
        <span className="mono feed-duration">{span.durationMs.toFixed(1)}ms</span>
      </div>

      {cell === 'failureMissed' ? (
        <div className="feed-comparison">
          <div className="feed-side feed-side-otel">
            <span className="feed-side-label">Standard OTel would show</span>
            <span className="feed-pill feed-pill-ok">200 OK · no error</span>
          </div>
          <div className="feed-side feed-side-detected">
            <span className="feed-side-label">opentel-mcp detected</span>
            <span className="feed-pill feed-pill-failure">
              isError: true{span.failureCategory ? ` · ${span.failureCategory}` : ''}
              {isUnactionable(span) ? ' · no actionable detail' : ''}
            </span>
          </div>
        </div>
      ) : (
        <span className={`feed-pill ${isFailure ? 'feed-pill-failure' : 'feed-pill-ok'} mono`}>
          {isFailure ? (span.errorType ?? 'error') : 'success'}
        </span>
      )}
    </div>
  );
}
