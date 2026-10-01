/**
 * @module with-ui
 *
 * `withUI(instrumentedServer, options)` — the in-process integration mode.
 *
 * IMPORTANT, corrected after verifying against the installed OTel SDK
 * (see server.js's module docblock for the full finding): this does NOT
 * reliably attach to spans by dynamically registering a `SpanProcessor`
 * on an already-constructed `TracerProvider` — `@opentelemetry/sdk-trace`
 * 2.x's `TracerProvider` fixes its span processors at construction time
 * and exposes no public method to add more afterwards. `resolveAttachableProvider()`
 * below still ATTEMPTS this (best-effort — it will work for a
 * `TracerProvider` implementation, host-authored or a future OTel SDK
 * version, that DOES happen to expose `addSpanProcessor`), but it is not
 * this function's real ingestion path, and every test that exercises it
 * uses a hand-built fake provider to prove `withUI()`'s OWN logic is
 * correct, independent of whether the installed real SDK supports it
 * (it currently doesn't).
 *
 * The RELIABLE path, in both of this package's integration modes, is the
 * `POST /v1/traces` OTLP/HTTP JSON receiver this call's server also
 * exposes (`server.js`): instrument with `setupNodeSdk: true` and set
 * `exporterUrl` to `<the URL withUI() resolves to>/v1/traces` —
 * opentel-mcp core already ships this exporter path unconditionally
 * today; nothing about it is new or opentel-mcp-ui-specific. This is "the
 * existing core hook" honored literally: an already-shipping capability,
 * not a new emission path, and zero changes to opentel-mcp core.
 *
 * Never throws when the best-effort dynamic attach isn't available: the
 * dashboard still starts and serves `/api/meta` honestly, and remains
 * fully able to receive spans via the OTLP receiver regardless — the
 * same "degrade to an honest, still-functional path, never a wrong
 * confident answer" posture ADR 008 established for `ObservationIntegrity`
 * itself.
 */

import { trace, diag } from '@opentelemetry/api';
import { CollectorSpanProcessor } from './collector-span-processor.js';
import { createServer } from './server.js';
import { openBrowser } from './open-browser.js';
import { loadBuiltSpaHtml } from './spa-html.js';
import { buildDemoFixture } from './demo-fixture.js';

/**
 * Resolves whatever concrete `TracerProvider` is currently registered,
 * unwrapping `@opentelemetry/api`'s `ProxyTracerProvider` indirection —
 * the same technique opentel-mcp core's own `detectObservationIntegrity()`
 * uses (`src/observation/integrity.js`) — and checks whether it happens
 * to expose a dynamic `addSpanProcessor()`. Best-effort only: the
 * installed `@opentelemetry/sdk-trace-node` does NOT expose this (see
 * this module's docblock) and this will return `null` against it. Kept
 * as a real attempt, not dead code, because a host-authored custom
 * `TracerProvider` (or a future OTel SDK version) reasonably might.
 *
 * @returns {{ addSpanProcessor: (p: import('@opentelemetry/sdk-trace').SpanProcessor) => void } | null}
 */
function resolveAttachableProvider() {
  const registered = trace.getTracerProvider();
  const delegate = typeof registered?.getDelegate === 'function' ? registered.getDelegate() : registered;
  if (delegate && typeof delegate.addSpanProcessor === 'function') return delegate;
  return null;
}

/**
 * @param {*} instrumentedServer - the object `instrumentMcpServer()` returned.
 * @param {{
 *   port?: number,
 *   open?: boolean,
 *   bufferCapacity?: number,
 *   statelessTransport?: boolean | 'auto',
 *   spaHtml?: string,
 *   demo?: boolean,
 * }} [options] `demo: true` seeds a realistic fixture (src/demo-fixture.js)
 *   so the dashboard has something to render immediately -- for reviewing
 *   the UI itself, not for production use.
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   collector: CollectorSpanProcessor,
 *   url: string,
 *   close: () => Promise<void>,
 * }>} Resolves once the HTTP server is listening. `withUI(server, opts)`
 *   without `await` (as shown in the README) is intentionally fine —
 *   nothing about span ingestion depends on the listen callback having
 *   fired yet, only serving HTTP requests does.
 */
export function withUI(instrumentedServer, options = {}) {
  const { port = 4319, open = false, bufferCapacity, statelessTransport = 'auto', spaHtml, demo = false } = options;

  const collector = new CollectorSpanProcessor({ capacity: bufferCapacity });
  if (demo) {
    for (const span of buildDemoFixture()) collector.ingestSerializedSpan(span);
  }

  const provider = resolveAttachableProvider();
  if (provider) {
    provider.addSpanProcessor(collector);
  } else {
    diag.warn(
      "opentel-mcp-ui: this process's registered TracerProvider does not support attaching a SpanProcessor " +
        "dynamically (true of the installed @opentelemetry/sdk-trace-node as of v2.x). The dashboard is still " +
        'fully functional: instrument your server with setupNodeSdk: true and exporterUrl pointing at ' +
        "this dashboard's URL + '/v1/traces' to send it spans over OTLP/HTTP JSON -- opentel-mcp core already " +
        'supports this today.',
    );
  }

  const server = createServer({ instrumentedServer, collector, statelessTransport, spaHtml: spaHtml ?? loadBuiltSpaHtml() });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // ADR 022 (v0.1.0 publish): loopback only by default -- see bin/opentel-mcp-ui.js's
    // identical comment for why this has no host override.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://localhost:${actualPort}`;
      if (open) openBrowser(url);
      resolve({
        server,
        collector,
        url,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
