import { useState } from 'react';
import { connectSnippet, OTLP_TRACES_PATH } from '../data/connect';
import './ConnectScreen.css';

/**
 * Shown instead of an empty dashboard when this instance is live (not
 * `--demo`) and no span has arrived yet. App.tsx swaps it for the real
 * dashboard as soon as the first span lands over SSE -- no reload.
 */
export function ConnectScreen({ origin }: { origin: string }) {
  const endpoint = `${origin}${OTLP_TRACES_PATH}`;
  const snippet = connectSnippet(endpoint);
  const [copied, setCopied] = useState(false);

  function copySnippet() {
    try {
      navigator.clipboard
        ?.writeText(snippet)
        .then(() => setCopied(true))
        .catch(() => {});
    } catch {
      // Clipboard unavailable (insecure context, old browser) -- the
      // snippet is still selectable on screen.
    }
  }

  return (
    <section className="connect-screen" aria-labelledby="connect-title">
      <h1 id="connect-title" className="connect-title">
        Connect your server
      </h1>
      <p className="connect-body">
        This dashboard is running and listening for spans. Point an MCP server instrumented with{' '}
        <code className="mono">opentel-mcp</code> at it:
      </p>

      <dl className="connect-endpoint">
        <dt>OTLP/HTTP endpoint</dt>
        <dd>
          <code className="mono" data-testid="connect-endpoint">
            {endpoint}
          </code>
        </dd>
      </dl>

      <div className="connect-snippet">
        <pre className="mono" data-testid="connect-snippet">
          {snippet}
        </pre>
        <button type="button" className="connect-copy" onClick={copySnippet}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <p className="connect-waiting" role="status">
        <span className="connect-pulse" aria-hidden="true" />
        Waiting for spans… the dashboard opens as soon as the first tool call arrives.
      </p>
    </section>
  );
}
