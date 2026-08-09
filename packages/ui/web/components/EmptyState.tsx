/**
 * Shown when no spans have arrived yet. Deliberately plain -- restraint
 * is the point (see the design brief's "dense-but-expensive, not
 * dense-but-cramped" framing, applied here to the opposite problem: an
 * empty screen shouldn't feel broken or unfinished, just quiet).
 */
export function EmptyState() {
  return (
    <div className="empty-state">
      <p className="empty-state-title">Waiting for spans</p>
      <p className="empty-state-body">
        Point an instrumented server's <code className="mono">exporterUrl</code> at this dashboard, or attach{' '}
        <code className="mono">withUI()</code> in-process. See the README for both integration modes.
      </p>
    </div>
  );
}
