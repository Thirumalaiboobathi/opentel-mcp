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
 * dashboard can be reviewed/screenshotted with no live MCP server at all),
 * --help/-h (ADR 022, v0.1.0 publish -- prints this usage and exits, starts no
 * server).
 */

import { createServer } from '../src/server.js';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';
import { openBrowser } from '../src/open-browser.js';
import { loadBuiltSpaHtml } from '../src/spa-html.js';
import { buildDemoFixture } from '../src/demo-fixture.js';

export const USAGE = `opentel-mcp-ui -- zero-infrastructure local dashboard for opentel-mcp

Usage: opentel-mcp-ui [options]

Options:
  --demo              Seed a realistic fixture so the dashboard has
                       something to show with no live MCP server.
  --port=<n>           Port to listen on (default: 4319). Binds to
                       127.0.0.1 only -- never reachable off this
                       machine.
  --open               Open the dashboard in your default browser once
                       it's listening.
  --stateless          Assert the instrumented server's transport is
                       stateless HTTP (skips auto-detection).
  --stateful           Assert the instrumented server's transport is a
                       long-lived, stateful instance (skips auto-detection).
  --help, -h           Show this help and exit.

Standalone mode has no instrumented server reference of its own -- point
an opentel-mcp-instrumented server's exporterUrl at
http://127.0.0.1:<port>/v1/traces (with setupNodeSdk: true) to send it
real spans over OTLP/HTTP JSON. See the README for the full walkthrough.`;

const DEFAULT_PORT = 4319;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, open: false, statelessTransport: 'auto', demo: false, help: false };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      // ADR 022 (v0.1.0 publish): an unparseable --port must degrade to the
      // default, never throw -- this is this CLI's own never-throw
      // discipline, same posture the library it fronts holds for the
      // tool-call hot path.
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed >= 0 && parsed < 65536) {
        args.port = parsed;
      } else {
        console.error(`opentel-mcp-ui: ignoring invalid --port value, using default ${DEFAULT_PORT}`);
      }
    } else if (arg === '--open') args.open = true;
    else if (arg === '--stateless') args.statelessTransport = true;
    else if (arg === '--stateful') args.statelessTransport = false;
    else if (arg === '--demo') args.demo = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/**
 * @returns {import('node:http').Server | undefined} `undefined` for
 *   `--help` (never-throw discipline applies here too: a help request
 *   must not start a server, but it also must not look like a crash --
 *   it's a normal, successful exit from this CLI's perspective).
 */
export function main(argv = process.argv.slice(2)) {
  const { port, open, statelessTransport, demo, help } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    return undefined;
  }

  const collector = new CollectorSpanProcessor();
  if (demo) {
    for (const span of buildDemoFixture()) collector.ingestSerializedSpan(span);
  }
  const server = createServer({ instrumentedServer: null, collector, statelessTransport, spaHtml: loadBuiltSpaHtml(), demo });

  // ADR 022 (v0.1.0 publish): bind to loopback only -- Node's default host for
  // .listen(port) with no host argument is all interfaces, not localhost,
  // which is the wrong default for something a stranger might `npx` on a
  // shared network. No --host override: this dashboard has no auth, so
  // "never reachable off this machine by default" isn't a convenience
  // setting to make configurable, it's the one this CLI commits to.
  server.listen(port, '127.0.0.1', () => {
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
