import type { MatrixCell, MatrixCounts } from '../data/classify';
import type { MetaResponse } from '../data/types';
import { computeCompleteness } from '../data/completeness';
import './ObservationMatrix.css';

interface Props {
  counts: MatrixCounts;
  meta: MetaResponse | null;
  selectedCell: MatrixCell | null;
  onSelectCell: (cell: MatrixCell | null) => void;
}

const CELL_ORDER: Array<{ cell: MatrixCell; row: 'SUCCESS' | 'FAILURE'; col: 'visible' | 'missed' }> = [
  { cell: 'successVisible', row: 'SUCCESS', col: 'visible' },
  { cell: 'successMissed', row: 'SUCCESS', col: 'missed' },
  { cell: 'failureVisible', row: 'FAILURE', col: 'visible' },
  { cell: 'failureMissed', row: 'FAILURE', col: 'missed' },
];

/**
 * The hero panel. Rows: ToolOutcome (SUCCESS/FAILURE). Columns: per-span
 * visibility to standard OTel, derived from errorType (see classify.ts).
 * `failureMissed` -- spans where isError: true was reported inside an
 * otherwise-successful response -- is the product: opentel-mcp caught a
 * failure a vanilla OTel setup would render as a clean green span. It
 * gets the accent colour (a confident "we caught this" claim), not amber
 * or red. `successMissed` is structurally near-always empty (see
 * classify.ts) -- rendered, not hidden, with an em-dash and an
 * explanation of why.
 */
export function ObservationMatrix({ counts, meta, selectedCell, onSelectCell }: Props) {
  const completeness = computeCompleteness(meta);

  return (
    <section className="matrix-panel" aria-label="Observation matrix">
      <h2 className="panel-title">Observation matrix</h2>

      <div className="matrix-grid" role="grid">
        <div className="matrix-corner" />
        <div className="matrix-col-header">VISIBLE TO OTEL</div>
        <div className="matrix-col-header">MISSED BY OTEL</div>

        {(['SUCCESS', 'FAILURE'] as const).map((row) => (
          <RowCells
            key={row}
            row={row}
            counts={counts}
            selectedCell={selectedCell}
            onSelectCell={onSelectCell}
          />
        ))}
      </div>

      <p className={`completeness completeness-${completeness.level}`}>{completeness.message}</p>
    </section>
  );
}

function RowCells({
  row,
  counts,
  selectedCell,
  onSelectCell,
}: {
  row: 'SUCCESS' | 'FAILURE';
  counts: MatrixCounts;
  selectedCell: MatrixCell | null;
  onSelectCell: (cell: MatrixCell | null) => void;
}) {
  const cellsInRow = CELL_ORDER.filter((c) => c.row === row);
  return (
    <>
      <div className="matrix-row-header">{row}</div>
      {cellsInRow.map(({ cell, col }) => (
        <MatrixCellButton
          key={cell}
          cell={cell}
          col={col}
          row={row}
          count={counts[cell]}
          selected={selectedCell === cell}
          onSelectCell={onSelectCell}
        />
      ))}
    </>
  );
}

function MatrixCellButton({
  cell,
  col,
  row,
  count,
  selected,
  onSelectCell,
}: {
  cell: MatrixCell;
  col: 'visible' | 'missed';
  row: 'SUCCESS' | 'FAILURE';
  count: number;
  selected: boolean;
  onSelectCell: (cell: MatrixCell | null) => void;
}) {
  const isTheProduct = cell === 'failureMissed';
  const isStructurallyEmpty = cell === 'successMissed';

  const classes = ['matrix-cell'];
  if (isTheProduct) classes.push('matrix-cell-product');
  if (isStructurallyEmpty) classes.push('matrix-cell-empty');
  if (selected) classes.push('matrix-cell-selected');

  const title = isStructurallyEmpty
    ? "Structurally near-always empty: opentel-mcp core only sets errorType to 'tool_error' in the same branch that also sets the span's status to ERROR, so a SUCCESS-status span can't carry it."
    : isTheProduct
      ? 'isError: true reported inside an otherwise-successful response — a standard OTel setup would render this as a clean, successful span.'
      : undefined;

  return (
    <button
      type="button"
      role="gridcell"
      className={classes.join(' ')}
      title={title}
      aria-pressed={selected}
      aria-label={`${row}, ${col === 'visible' ? 'visible to OTel' : 'missed by OTel'}: ${count}`}
      onClick={() => onSelectCell(selected ? null : cell)}
    >
      <span className="matrix-count mono">{isStructurallyEmpty && count === 0 ? '—' : count}</span>
    </button>
  );
}
