import { useState } from 'react';
import './ConnectScreen.css';

/**
 * The OTLP/HTTP JSON receiver path every opentel-mcp-ui server exposes
 * (server.js's `POST /v1/traces` route).
 */
export const OTLP_TRACES_PATH = '/v1/traces';

/**
 * The exact snippet to point an instrumented server at this dashboard.
 * Kept to options opentel-mcp core really has (config.js): `serviceName`
 * is required when `setupNodeSdk` is true, and `exporterUrl` only takes
 * effect with `setupNodeSdk: true`. This is the same call
 * test/e2e-silent-failure.test.js drives end to end.
 */
export function connectSnippet(endpoint: string): string {
  return [
    "import { instrumentMcpServer } from 'opentel-mcp';",
    '',
    '// Before registering any tools:',
    'instrumentMcpServer(server, {',
    "  serviceName: 'my-mcp-server',",
    '  setupNodeSdk: true,',
    `  exporterUrl: '${endpoint}',`,
    '});',
  ].join('\n');
}

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
