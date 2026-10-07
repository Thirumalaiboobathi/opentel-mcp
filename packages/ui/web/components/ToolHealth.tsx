import type { SerializedSpan } from '../../src/types.d.ts';
import { computeToolHealth, shortReason } from '../data/healthGrades';
import './ToolHealth.css';

/**
 * Per-tool A-F grades (data/healthGrades.ts, docs/health-grades.md).
 * Each grade's tooltip says which signal set it, so a grade is never a
 * bare letter.
 */
export function ToolHealth({ spans }: { spans: SerializedSpan[] }) {
  const rows = computeToolHealth(spans);
  if (rows.length === 0) return null;

  return (
    <section className="health-panel" aria-label="Tool health">
      <h2 className="panel-title">Tool health</h2>
      <table className="health-table">
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col" className="health-num">
              Calls
            </th>
            <th scope="col">Grade</th>
            <th scope="col" className="health-why-col">
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.toolName} data-testid={`health-row-${row.toolName}`}>
              <td className="mono">{row.toolName}</td>
              <td className="health-num mono">{row.calls}</td>
              <td>
                <span
                  className={`health-grade ${row.grade ? `health-grade-${row.grade}` : 'health-grade-na'}`}
                  title={row.explanation}
                  aria-label={row.grade ? `Grade ${row.grade}. ${row.explanation}` : row.explanation}
                  tabIndex={0}
                >
                  {row.grade ?? 'Not enough data'}
                </span>
              </td>
              <td className="health-why-col health-why">{shortReason(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
