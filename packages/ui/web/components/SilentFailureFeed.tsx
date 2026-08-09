import { useEffect, useRef, useState } from 'react';
import type { SerializedSpan } from '../../src/types.d.ts';
import { classifySpan, type MatrixCell } from '../data/classify';
import { VirtualizedList } from './VirtualizedList';
import './SilentFailureFeed.css';

interface Props {
  spans: SerializedSpan[];
  selectedCell: MatrixCell | null;
}

const ROW_HEIGHT = 96;
const LIST_HEIGHT = 480;

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
  const filtered = spans.filter((s) => classifySpan(s) === activeCell);
  // Newest first -- a live feed reads top-down like a log/chat stream.
  const ordered = [...filtered].reverse();

  const newIds = useNewlyArrivedIds(filtered);

  return (
    <section className="feed-panel" aria-label="Span feed">
      <h2 className="panel-title">{CELL_LABELS[activeCell]}</h2>
      {activeCell === 'failureMissed' && (
        <p className="feed-subtitle">
          Calls where <code className="mono">isError: true</code> was reported inside an otherwise-successful
          response — the exact case a standard OpenTelemetry setup renders as a clean, successful span.
        </p>
      )}

      <VirtualizedList
        items={ordered}
        itemHeight={ROW_HEIGHT}
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
