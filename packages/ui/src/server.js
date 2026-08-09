/**
 * @module server
 *
 * The local telemetry HTTP server: `node:http` only, no Express, no
 * framework — this package's entire runtime dependency footprint should
 * stay small enough to `npm install` in the seconds a developer is
 * willing to wait before giving up on a dev tool.
 *
 * Routes:
 *   GET /                    serves the SPA bundle (stub until Step 4 —
 *                            pass `spaHtml` to override the placeholder)
 *   GET /api/spans           SSE stream of newly-ingested spans
 *   GET /api/spans/history   current ring-buffer contents (initial load)
 *   GET /api/summary         see summary.js
 *   GET /api/meta            see meta.js — load-bearing, read that file's
 *                            docblock before changing detector semantics
 *   POST /v1/traces          OTLP/HTTP JSON trace receiver — see
 *                            otlp-json-receiver.js. Present on EVERY
 *                            server this module creates, not just the
 *                            standalone CLI's — see the note below.
 *
 * A CORRECTION, found by writing this module's own tests, worth reading
 * before touching `with-ui.js`: the original design assumed a
 * `TracerProvider` could have a `SpanProcessor` attached to it AFTER
 * construction (`provider.addSpanProcessor(...)`), the same way older
 * OTel SDK versions worked. Verified directly against the installed
 * `@opentelemetry/sdk-trace@2.9.0`: `TracerProvider` builds one
 * `MultiSpanProcessor` from `options.spanProcessors` at CONSTRUCTION time
 * (`TracerProvider.js`) and exposes no public method to add another one
 * afterwards — the field is private (`_activeSpanProcessor`). Reaching
 * into that private field would work at runtime, but is exactly the
 * "coupling to unstable SDK internals" this project's own ADRs (001, 008)
 * already reject as a pattern — not done here. The reliable mechanism for
 * BOTH of opentel-mcp-ui's integration modes is therefore this route:
 * `instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl: '<this
 * server's URL>/v1/traces' })` already sends spans here today, using
 * opentel-mcp core's own, already-shipping OTLP export path — zero core
 * changes. `with-ui.js` ALSO still attempts the dynamic-attach path as a
 * best-effort bonus (for a custom `TracerProvider` that happens to expose
 * it), but does not depend on it.
 */

import { createServer as createHttpServer } from 'node:http';
import { computeSummary } from './summary.js';
import { describeInMemoryTrackerAvailability, inspectTransport } from './meta.js';
import { parseOtlpJsonTraceRequest } from './otlp-json-receiver.js';

const PLACEHOLDER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>opentel-mcp-ui</title></head>
<body><p>opentel-mcp-ui backend is running. The dashboard UI ships in a later step.</p></body>
</html>
`;

/**
 * Best-effort opentel-mcp core version lookup. Never throws — an
 * unresolvable version reports 'unknown' rather than crashing /api/meta.
 *
 * @returns {Promise<string>}
 */
async function getCoreVersion() {
  try {
    const corePkg = await import('opentel-mcp/package.json', { with: { type: 'json' } });
    return corePkg.default?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getUiVersion() {
  try {
    const uiPkg = await import('../package.json', { with: { type: 'json' } });
    return uiPkg.default?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Builds just the request-handling function, without binding it to a
 * listening `http.Server` — exported separately so the standalone CLI
 * (`bin/opentel-mcp-ui.js`) can compose it with its own extra
 * `/v1/traces` route ahead of it, instead of needing a second throwaway
 * server just to extract this closure. `createServer()` below is a thin
 * wrapper over this for the common case (no extra routes needed).
 *
 * @param {{
 *   instrumentedServer: *,
 *   collector: import('./collector-span-processor.js').CollectorSpanProcessor,
 *   statelessTransport?: boolean | 'auto',
 *   spaHtml?: string,
 * }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ instrumentedServer, collector, statelessTransport = 'auto', spaHtml = PLACEHOLDER_HTML }) {
  const buffer = collector.buffer;

  return function handleRequestSync(req, res) {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message ?? 'internal error' }));
    });
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/v1/traces') {
      await handleOtlpTraces(req, res, collector);
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(spaHtml);
      return;
    }

    if (url.pathname === '/api/spans/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spans: buffer.toArray(), capacity: buffer.capacity, size: buffer.size }));
      return;
    }

    if (url.pathname === '/api/summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(computeSummary({ instrumentedServer, buffer })));
      return;
    }

    if (url.pathname === '/api/meta') {
      const [coreVersion, uiVersion] = await Promise.all([getCoreVersion(), getUiVersion()]);
      const { shape } = inspectTransport(instrumentedServer);
      const detectorOptions = { instrumentedServer, statelessTransport };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          coreVersion,
          uiVersion,
          transport: { shape },
          buffer: { capacity: buffer.capacity, size: buffer.size, totalPushed: buffer.totalPushed },
          detectors: {
            thrashDetection: describeInMemoryTrackerAvailability('Thrash detection', detectorOptions),
            costTracking: describeInMemoryTrackerAvailability('Cost/budget tracking', detectorOptions),
            schemaDrift: describeInMemoryTrackerAvailability('Schema drift detection', detectorOptions),
            toolOutcome: describeInMemoryTrackerAvailability('ToolOutcome counting', detectorOptions),
          },
        }),
      );
      return;
    }

    if (url.pathname === '/api/spans') {
      handleSpansSse(req, res, url);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  function handleSpansSse(req, res, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Tell EventSource how long to wait before auto-reconnecting after a
      // dropped connection -- short, since this is a localhost dev tool.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');

    // Reconnect support: a client that lost its connection sends back
    // whatever `id:` it last saw via the Last-Event-ID header (standard
    // EventSource behavior) OR the caller can pass ?lastEventId=N
    // explicitly (used by this package's own tests, since Node's fetch/
    // EventSource setup for tests is simpler via query param than headers).
    // Anything buffered with seq > lastEventId gets replayed immediately,
    // so a client never silently misses spans ingested during a
    // disconnect window shorter than the buffer's capacity.
    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventIdParam = url.searchParams.get('lastEventId');
    const lastEventId = Number(lastEventIdHeader ?? lastEventIdParam ?? 0) || 0;

    const snapshot = buffer.toArray();
    const latestSeq = buffer.totalPushed;
    const firstSeq = latestSeq - snapshot.length + 1;
    for (let i = 0; i < snapshot.length; i++) {
      const seq = firstSeq + i;
      if (seq > lastEventId) writeSseEvent(res, snapshot[i], seq);
    }

    const unsubscribe = collector.subscribe((span, seq) => {
      writeSseEvent(res, span, seq);
    });

    req.on('close', unsubscribe);
  }
}

/**
 * Convenience wrapper over `createRequestHandler()` for the common case
 * (`withUI()`'s in-process mode) — no extra routes needed beyond this
 * package's own.
 *
 * @param {Parameters<typeof createRequestHandler>[0]} options
 * @returns {import('node:http').Server}
 */
export function createServer(options) {
  return createHttpServer(createRequestHandler(options));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('opentel-mcp-contract').SerializedSpan} span
 * @param {number} seq
 */
function writeSseEvent(res, span, seq) {
  res.write(`id: ${seq}\ndata: ${JSON.stringify(span)}\n\n`);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./collector-span-processor.js').CollectorSpanProcessor} collector
 */
function handleOtlpTraces(req, res, collector) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const spans = parseOtlpJsonTraceRequest(body);
        for (const span of spans) collector.ingestSerializedSpan(span);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ partialSuccess: {} }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message ?? 'invalid OTLP payload' }));
      }
      resolve();
    });
  });
}
