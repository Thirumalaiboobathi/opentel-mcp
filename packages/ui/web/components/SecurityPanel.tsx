import type { SerializedSpan } from '../../src/types.d.ts';
import { deriveSecurity, hashPrefix, BURST_THRESHOLD, BURST_WINDOW_MS, type IntegrityKind } from '../data/security';
import { formatAge } from '../data/freshness';
import './ToolHealth.css';
import './SecurityPanel.css';

const KIND_LABEL: Record<IntegrityKind, string> = {
  changed: 'Definition changed',
  pin_mismatch: 'Pin mismatch',
  added: 'Tool added',
  removed: 'Tool removed',
};

/**
 * The Security panel (ADR 033, opentel-mcp core 0.18.0+). Read-only: no controls, no links, no inputs. Every
 * value comes from span data a server controls, so everything is rendered as React text (never HTML) and hashes
 * are shown as 12-character prefixes. Renders nothing when no span carries a security signal, which also covers
 * older cores. This is detection, not enforcement: it shows what opentel-mcp observed.
 */
export function SecurityPanel({ spans }: { spans: SerializedSpan[] }) {
  const data = deriveSecurity(spans);
  if (!data.any) return null;

  return (
    <section className="health-panel security-panel" aria-label="Security" data-testid="security-panel">
      <h2 className="panel-title">Security</h2>
      <p className="security-note">Signals opentel-mcp observed. Detection, not enforcement: pattern-based checks can miss things and can fire on look-alikes.</p>

      {data.integrity.length > 0 && (
        <div data-testid="security-integrity">
          <h3 className="panel-subtitle">Tool definitions</h3>
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Tool</th>
                <th scope="col">Before / expected</th>
                <th scope="col">After / actual</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {data.integrity.map((f, i) => (
                <tr key={`${f.kind}-${f.tool}-${f.atMs}-${i}`} data-testid={`integrity-row-${f.kind}`}>
                  <td>
                    {f.kind === 'pin_mismatch' ? <span className="health-grade health-grade-F">{KIND_LABEL[f.kind]}</span> : KIND_LABEL[f.kind]}
                  </td>
                  <td className="mono">{f.tool}</td>
                  <td className="mono">{hashPrefix(f.before)}</td>
                  <td className="mono">{hashPrefix(f.after)}</td>
                  <td className="mono">{new Date(f.atMs).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.leaks.length > 0 && (
        <div data-testid="security-leaks">
          <h3 className="panel-subtitle">Secret-shaped output</h3>
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="health-num">
                  Results
                </th>
                <th scope="col">Types</th>
              </tr>
            </thead>
            <tbody>
              {data.leaks.map((r) => (
                <tr key={r.tool} data-testid={`leak-row-${r.tool}`}>
                  <td className="mono">{r.tool}</td>
                  <td className="health-num mono">{r.calls}</td>
                  <td className="mono">{r.types.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.auth.length > 0 && (
        <div data-testid="security-auth">
          <h3 className="panel-subtitle">Auth failures</h3>
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="health-num">
                  Failures
                </th>
                <th scope="col">Pattern</th>
              </tr>
            </thead>
            <tbody>
              {data.auth.map((r) => (
                <tr key={r.tool} data-testid={`auth-row-${r.tool}`}>
                  <td className="mono">{r.tool}</td>
                  <td className="health-num mono">{r.failures}</td>
                  <td>
                    {r.burst ? (
                      <span className="health-grade health-grade-F" data-testid={`auth-burst-${r.tool}`}>
                        Burst: {BURST_THRESHOLD}+ within {formatAge(BURST_WINDOW_MS)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.sensitive.length > 0 && (
        <div data-testid="security-sensitive">
          <h3 className="panel-subtitle">Sensitive tool calls</h3>
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="health-num">
                  Success
                </th>
                <th scope="col" className="health-num">
                  Silent failure
                </th>
                <th scope="col" className="health-num">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {data.sensitive.map((r) => (
                <tr key={r.tool} data-testid={`sensitive-row-${r.tool}`}>
                  <td className="mono">{r.tool}</td>
                  <td className="health-num mono">{r.success}</td>
                  <td className="health-num mono">{r.silentFailure}</td>
                  <td className="health-num mono">{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.skew.length > 0 && (
        <div data-testid="security-skew">
          <h3 className="panel-subtitle">Clock skew</h3>
          <table className="health-table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col" className="health-num">
                  Responses
                </th>
                <th scope="col" className="health-num">
                  Largest lead
                </th>
              </tr>
            </thead>
            <tbody>
              {data.skew.map((r) => (
                <tr key={r.tool} data-testid={`skew-row-${r.tool}`}>
                  <td className="mono">{r.tool}</td>
                  <td className="health-num mono">{r.calls}</td>
                  <td className="health-num mono">{formatAge(r.maxMs)} ahead</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
