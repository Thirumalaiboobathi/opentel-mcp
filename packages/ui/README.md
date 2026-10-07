# opentel-mcp-ui

> A zero-infrastructure local dashboard for [`opentel-mcp`](https://www.npmjs.com/package/opentel-mcp) — see which of your MCP server's tool calls failed silently, without standing up a backend.

`opentel-mcp` can tell you that a tool call returned `isError: true` inside
an otherwise-successful JSON-RPC response — the exact failure a standard
OpenTelemetry setup renders as a clean, green span. This package is the
one-command way to actually look at that signal, with no Prometheus, no
Grafana, no OTel Collector to configure first.

## 30-second demo

```bash
npx opentel-mcp-ui --demo
```

Opens a dashboard at `http://127.0.0.1:4319` seeded with 60 realistic
fixture spans (42 clean successes, 7 ordinary thrown/protocol failures a
standard OTel setup would also catch, and 11 silent failures it wouldn't)
— nothing to configure, no MCP server required. Three panels:

- **Observation matrix** — SUCCESS/FAILURE rows × visible-to-OTel/missed-by-OTel
  columns. The "missed" + "failure" cell is the whole point: calls a
  plain OTel setup would show as green.
- **Silent-failure feed** — defaults to that exact cell, newest-first,
  with the side-by-side comparison of what standard tracing would have
  shown versus what actually happened.
- **Detector status banner** — which of opentel-mcp's four in-memory
  trackers (thrash detection, cost/budget, schema drift, tool-outcome
  counting) are confidently live for the server you've pointed this at —
  stated honestly, not implied by a confident-looking zero. (In `--demo`
  mode, since there's no real server, it says so plainly instead of
  guessing.)

Add `--open` to launch your browser automatically. Run `npx opentel-mcp-ui --help`
for the full flag list.

## Pointing a real MCP server at it

Drop `--demo` and start the dashboard against nothing:

```bash
npx opentel-mcp-ui
```

```
opentel-mcp-ui: dashboard listening at http://localhost:4319
opentel-mcp-ui: OTLP/HTTP JSON trace receiver at http://localhost:4319/v1/traces
opentel-mcp-ui: point your instrumented server's exporterUrl at the URL above
(instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl: ... })).
```

Then, in the MCP server you're instrumenting with `opentel-mcp` core,
point its exporter at that URL — no new dependency, no new mechanism;
this is the same OTLP/HTTP JSON export path `setupNodeSdk: true` already
ships:

```js
import { instrumentMcpServer } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
  exporterUrl: 'http://127.0.0.1:4319/v1/traces',
});
```

Until the first span arrives, the dashboard shows a **Connect your
server** screen with this exact snippet, pre-filled with the endpoint the
instance is actually listening on. Make real tool calls against your
server and the dashboard replaces it live, over Server-Sent Events — no
page reload needed.

**Environment variable, as an alternative to hardcoding the URL:**
`opentel-mcp` core doesn't read an env var for `exporterUrl` itself (it's
a plain constructor option), so set one yourself and reference it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319 node your-server.js
```

```js
instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
  exporterUrl: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4319'}/v1/traces`,
});
```

### In-process mode: `withUI()`

If your server runs in the same process you want the dashboard in (dev
tooling, a single-process demo), skip the separate CLI process:

```js
import { instrumentMcpServer } from 'opentel-mcp';
import { withUI } from 'opentel-mcp-ui';

const instrumented = instrumentMcpServer(server, { setupNodeSdk: true });
const { url } = await withUI(instrumented, { open: true });
// Point setupNodeSdk's own OTLP exporter back at this URL -- see the
// note below for why that extra step is still required.
```

`withUI()`'s most reliable ingestion path is the exact same OTLP/HTTP
receiver the standalone CLI exposes (`<url>/v1/traces`) — it also
*attempts* to attach directly to your `TracerProvider` as a bonus, best
effort only, since the installed `@opentelemetry/sdk-trace-node` (2.x) has
no public API to add a `SpanProcessor` after construction. Don't rely on
the direct-attach path; wire `exporterUrl` to `withUI()`'s own `url` the
same way the two-process setup above does.

## CLI reference

```
opentel-mcp-ui [options]

  --demo              Seed a realistic fixture with no live MCP server.
  --port=<n>          Port to listen on (default: 4319). Binds to
                       127.0.0.1 only -- never reachable off this machine.
  --open               Open the dashboard in your default browser.
  --stateless          Assert the transport is stateless HTTP.
  --stateful            Assert the transport is a long-lived instance.
  --help, -h            Show this help and exit.
```

`--stateless`/`--stateful` matter only when you have real traffic and
want accurate detector-status reporting: whether opentel-mcp core's
in-memory trackers (thrash detection, cost/budget, schema drift,
tool-outcome counting) can meaningfully accumulate state depends on
whether your server is re-instrumented fresh per request (common under
stateless HTTP deployments) or long-lived (stdio, or a persistent HTTP
process). Auto-detection (the default) makes a best-effort structural
guess from the transport shape and says so honestly when it can't be
sure — pass one of these two flags if you know your own deployment
topology and want a confident answer instead.

## What this never does

- **Never phones home.** No telemetry, no update check, no outbound
  request beyond what your own instrumented server sends it.
- **Never persists anything outside the running process.** Spans live in
  an in-memory, bounded ring buffer; nothing touches disk. Stop the
  process and the data is gone.
- **Never binds to anything but `127.0.0.1`.** This dashboard has no
  authentication, so it is never reachable from another machine, even on
  your own local network, regardless of flags.

## Version compatibility

`opentel-mcp-ui` has zero compile-time coupling to `opentel-mcp` core's
exports — it reads well-known span attribute keys as plain strings
(`error.type`, `mcp.tool.argument_count`, …), not imported constants, so
an attribute this UI version doesn't recognize from a newer core simply
doesn't render anything new; it never breaks a build or crashes the
dashboard. Requires `opentel-mcp >=0.8.0 <1.0.0` (the version range where
`getObservationState()` — used for the detector banner when a real
in-process server is attached — has existed). Full reasoning:
[`docs/adr/022-publish-ui.md`](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/docs/adr/022-publish-ui.md)
in the main repo.

## License

MIT © Thirumalaiboobathi B
