#!/usr/bin/env node
/**
 * Standalone integration mode: `npx opentel-mcp-ui`. Starts the same
 * dashboard server `withUI()` starts in-process, but with no
 * `instrumentedServer` reference of its own (this runs as a separate OS
 * process). Point an opentel-mcp-instrumented server's `exporterUrl` at
 * `http://localhost:<port>/v1/traces` (with `setupNodeSdk: true`) and
 * spans arrive here via opentel-mcp core's OWN, already-shipping OTLP
 * export mechanism — see `src/server.js`'s module docblock for why this,
 * not a dynamic in-process hook, is this package's one reliable
 * ingestion path in EITHER integration mode.
 *
 * `/api/summary` and `/api/meta` necessarily report less in this mode
 * than `withUI()`'s in-process mode does when it CAN resolve an
 * instrumented server: there is no `instrumentedServer` object to call
 * `getObservationState()` on, and transport shape can't be inspected
 * from a separate process. `/api/meta` reflects that honestly
 * (`transport.shape: 'undeterminable'`, `observationState: null`) rather
 * than guessing — pass `--stateless` / `--stateful` to assert what
 * auto-detection can't determine from here, same
 * `statelessTransport`-style escape hatch `withUI()` takes.
 *
 * Flags: --port=<n> (default 4319), --open, --stateless, --stateful,
 * --demo (seeds a realistic fixture -- see src/demo-fixture.js -- so the
 * dashboard can be reviewed/screenshotted with no live MCP server at all).
 */

import { createServer } from '../src/server.js';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';
import { openBrowser } from '../src/open-browser.js';
import { loadBuiltSpaHtml } from '../src/spa-html.js';
import { buildDemoFixture } from '../src/demo-fixture.js';

function parseArgs(argv) {
  const args = { port: 4319, open: false, statelessTransport: 'auto', demo: false };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--open') args.open = true;
    else if (arg === '--stateless') args.statelessTransport = true;
    else if (arg === '--stateful') args.statelessTransport = false;
    else if (arg === '--demo') args.demo = true;
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const { port, open, statelessTransport, demo } = parseArgs(argv);

  const collector = new CollectorSpanProcessor();
  if (demo) {
    for (const span of buildDemoFixture()) collector.ingestSerializedSpan(span);
  }
  const server = createServer({ instrumentedServer: null, collector, statelessTransport, spaHtml: loadBuiltSpaHtml() });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`opentel-mcp-ui: dashboard listening at ${url}`);
    if (demo) {
      console.log(`opentel-mcp-ui: seeded ${collector.buffer.size} demo spans -- no live MCP server needed.`);
    } else {
      console.log(`opentel-mcp-ui: OTLP/HTTP JSON trace receiver at ${url}/v1/traces`);
      console.log(
        "opentel-mcp-ui: point your instrumented server's exporterUrl at the URL above " +
          '(instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl: ... })).',
      );
    }
    if (open) openBrowser(url);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
