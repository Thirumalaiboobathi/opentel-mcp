import type { SerializedSpan } from '../../src/types.d.ts';
import { summarizeOperations } from '../data/operations';
import './ToolHealth.css';

/**
 * Resource and prompt calls (opentel-mcp core's opt-in `coverage`, ADR
 * 026) and their failures. Renders nothing unless such spans exist, so a
 * tools-only server sees no change. Reuses the Tool health table styles.
 */
export function Operations({ spans }: { spans: SerializedSpan[] }) {
  const rows = summarizeOperations(spans);
  if (rows.length === 0) return null;

  return (
    <section className="health-panel" aria-label="Resources and prompts">
      <h2 className="panel-title">Resources &amp; prompts</h2>
      <table className="health-table operations-table">
        <thead>
          <tr>
            <th scope="col">Method</th>
            <th scope="col">Prompt</th>
            <th scope="col" className="health-num">
              Calls
            </th>
            <th scope="col" className="health-num">
              Failures
            </th>
            <th scope="col" className="health-why-col">
              Error types
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.method} ${row.target ?? ''}`} data-testid={`operation-row-${row.method}${row.target ? `-${row.target}` : ''}`}>
              <td className="mono">{row.method}</td>
              <td className="mono">{row.target ?? '—'}</td>
              <td className="health-num mono">{row.calls}</td>
              <td className="health-num mono">
                {row.failures > 0 ? <span className="health-grade health-grade-F">{row.failures}</span> : 0}
              </td>
              <td className="health-why-col health-why mono">{row.errorTypes.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
