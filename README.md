# opentel-mcp

> Turn every MCP tool call into an OpenTelemetry trace — including the
> failures your logs won't show you.

[![CI](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opentel-mcp.svg)](https://www.npmjs.com/package/opentel-mcp)
[![node](https://img.shields.io/node/v/opentel-mcp.svg)](https://www.npmjs.com/package/opentel-mcp)
[![license](https://img.shields.io/npm/l/opentel-mcp.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/LICENSE)

opentel-mcp watches every tool call your MCP (Model Context Protocol)
server handles: which tool ran, how long it took, and whether it worked.
It reports that as OpenTelemetry (OTel) traces — the standard most
dashboards already read. One function call; no changes to your tools'
code.

## The problem

Your AI agent calls 15 MCP tools across 3 servers this turn. One tool
returns `{ isError: true }` inside an otherwise-successful response — how
a tool reports "I couldn't do that" without crashing. Your logs show
success. Your metrics show success. The agent gives a wrong answer, and
nothing you're monitoring says why.

opentel-mcp makes that failure visible: one span per tool call, marked as
an error when it actually is one, using the same standard your dashboards
already speak.

## Install

```bash
npm install opentel-mcp @opentelemetry/api
```

opentel-mcp is an ES module — add `"type": "module"` to package.json.

## 30-second quickstart

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { instrumentMcpServer } from 'opentel-mcp';
import { z } from 'zod';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

// Wraps every tool registered below. Must run BEFORE server.tool() —
// see "Ordering constraint" below for why.
instrumentMcpServer(server, {
  serviceName: 'my-mcp-server', // shows up on your traces
  setupNodeSdk: true, // dev mode: prints traces to your terminal
});

// A normal tool, registered exactly as usual.
server.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `you said: ${text}` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

That's it. Every tool call now emits a trace. Wire an exporter to see them
(next section).

## See it working

Run the snippet above and this prints to your terminal — a real, captured
run (full dump: `examples/hello-mcpserver/README.md`):

```
name: 'tools/call echo'
kind: 1                    // SpanKind.SERVER
status: { code: 1 }        // OK
attributes: {
  'mcp.method.name': 'tools/call',
  'gen_ai.tool.name': 'echo',
  'mcp.tool.argument_count': 1,
  'jsonrpc.request.id': '1'
}
```

No dashboard needed — `setupNodeSdk: true`'s dev exporter printed this
directly. Point it at a real backend later; see "Two modes" below.

---

The rest of this README goes deeper: both server APIs, every attribute
and metric emitted, how failure grouping works, configuration, and the
non-obvious design decisions behind each.

## Both server APIs

MCP servers are built on one of two classes from `@modelcontextprotocol/sdk`;
opentel-mcp detects and wraps either one the same way (see ADR 001 in
`docs/adr/` for how).

**`McpServer`** — the high-level API most servers are actually built on.
Use it unless you have a specific reason not to; this is what the
quickstart above uses.

**`Server`** — the low-level API, for when you're handling raw JSON-RPC
yourself or building a library on top of MCP:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new Server({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });

// Must run before setRequestHandler(CallToolRequestSchema, ...) below.
instrumentMcpServer(server, { serviceName: 'my-mcp-server', setupNodeSdk: true });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { text } = request.params.arguments ?? {};
  return { content: [{ type: 'text', text: `you said: ${text}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

Runnable versions of both live in `examples/hello-server/` and
`examples/hello-mcpserver/`.

## What gets emitted

### Tool-level failures, specifically

An MCP tool can fail two ways: it can throw, or it can return
`isError: true` on an otherwise-successful response (the case from "The
problem" above). opentel-mcp treats both the same way — span marked
`ERROR`, nothing thrown, the result returned to the caller unchanged:

```
tools/call fetch_weather ................. 605ms   ERROR
error.type = tool_error
```

Verified in `test/instrument.test.js`'s "tool-level failure" tests.

### Span attributes

Every span follows the OpenTelemetry MCP semantic conventions (see
"Semantic conventions" below), name `{mcp.method.name} {tool name}`
(e.g. `tools/call echo`), kind `SERVER`, status `ERROR` whenever
`error.type` is set.

| Attribute | Requirement Level | Description | Example |
|---|---|---|---|
| mcp.method.name | Required | JSON-RPC method name | "tools/call" |
| gen_ai.tool.name | Conditionally Required | Tool name from request | "echo" |
| gen_ai.operation.name | Recommended | GenAI operation type | "execute_tool" |
| jsonrpc.request.id | Conditionally Required | JSON-RPC request id (string) | "abc-123" |
| error.type | Conditionally Required (on failure) | Error class name, or `"tool_error"` when the tool call itself returned `isError: true` | "TypeError" |
| mcp.tool.argument_count | **Custom — not spec** | Number of arguments (values not captured) | 2 |

Span status description carries the error message on failure (thrown
errors); there's no separate error-message attribute — the spec expresses
success/failure through span status, not an attribute. Source of truth:
`src/attributes.js`.

### Metrics

Four `mcp.tool.*` metrics via `@opentelemetry/api`'s Metrics API — same
API-only pattern as tracing (see "Two modes" below): nothing is recorded
until a `MeterProvider` is registered. Set `enableMetrics: false` to opt
out even when one is; tracing is unaffected either way. Source of truth:
`src/metrics.js`.

| Metric | Type | Unit | Attributes | Emitted when |
|---|---|---|---|---|
| `mcp.tool.calls` | Counter | — | `gen_ai.tool.name`, `mcp.method.name` | Every tool call |
| `mcp.tool.errors` | Counter | — | `gen_ai.tool.name`, `error.type`[^1] | Handler threw or rejected |
| `mcp.tool.silent_failures` | Counter | — | `gen_ai.tool.name`[^1] | Result had `isError: true` |
| `mcp.tool.duration` | Histogram | ms | `gen_ai.tool.name`, `mcp.tool.outcome`[^1] | Every call, completion |

[^1]: Also carries `mcp.failure.category` when fingerprinting finds one — see "Failure Fingerprinting" below.

`mcp.tool.silent_failures` increments from the exact same check that marks
the span `ERROR` (`isToolResultError()` in `src/instrument.js`) — the
detection logic isn't duplicated between traces and metrics.

Wiring a real `MeterProvider`/`TracerProvider` — a worked example against
SigNoz's local OTLP endpoint:

```js
import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { instrumentMcpServer } from 'opentel-mcp';

const resource = resourceFromAttributes({ 'service.name': 'my-mcp-server' });

const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
    }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }))],
});
tracerProvider.register();

const server = new Server({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });

// setupNodeSdk: false (default) — both providers above are already
// registered globally, so instrumentMcpServer() picks them up as-is.
instrumentMcpServer(server, {});
```

`http://localhost:4318` is SigNoz's default local OTLP/HTTP (OpenTelemetry
Protocol — the wire format traces/metrics travel over) endpoint; point it
at your own collector in production. `@opentelemetry/sdk-metrics` and
`@opentelemetry/exporter-metrics-otlp-http` are host-app dependencies —
opentel-mcp doesn't bundle them (see `package.json`'s `peerDependencies`).
`@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http`
are already runtime dependencies of opentel-mcp itself (its `setupNodeSdk:
true` dev path uses them), so no extra install is needed for those two.

## Failure Fingerprinting (v0.4.0+)

Groups logically identical failures under one stable identifier, even
when the error message contains UUIDs, timestamps, or user IDs. Ten
calls that fail the same way but each mention a different user ID show
up as **one** issue, not ten.

Runs locally and synchronously over the error object already in hand —
no network call, no third-party service. Every thrown error and every
`isError: true` result gets one, automatically; disable with
`{ fingerprinting: false }` (default: enabled). Full algorithm: ADR 006
in `docs/adr/`.

| Attribute | Description | Example |
|---|---|---|
| mcp.failure.fingerprint | Stable 16-hex-char identity for the failure | "a3f4c8e2b1d09f77" |
| mcp.failure.signature | Human-readable `errorClass@fn:line`, ≤60 chars | "TypeError@doThing:42" |
| mcp.failure.category | One of 8 categories (below) | "timeout" |
| mcp.failure.origin | `tool_error` \| `thrown` \| `transport` | "thrown" |
| mcp.failure.error_class | Error class / constructor name | "TypeError" |

Source of truth: `src/fingerprint/attributes.js`. Every category:

- `validation` — bad input (Zod/Joi/Yup errors, "invalid"/"required" wording)
- `timeout` — an operation timed out (`TimeoutError`, `ETIMEDOUT`, ...)
- `network` — a connection failed (`ECONNREFUSED`, `FetchError`, ...)
- `auth` — 401/403, "unauthorized"/"forbidden" wording
- `dependency` — a downstream service or package failed (Mongo, Postgres, ...)
- `serialization` — malformed JSON, "unexpected token" wording
- `internal` — nothing more specific matched (the catch-all)
- `unknown` — fingerprinting itself hit an internal error (should not normally happen)

Full classifier source: `src/fingerprint/classify/`.

**Cardinality:** the fingerprint itself is unbounded — a new bug means a
new fingerprint, forever. That's fine on span attributes (each span is
its own record), but it must **never** go on a metric label, or every
distinct failure becomes its own permanent time series. opentel-mcp
enforces this structurally, not by convention: `src/metrics.js` can only
reach a fingerprint-derived value through
`METRIC_SAFE_ATTRIBUTES` — a frozen list containing only `category` and
`origin` (24 combinations max). There is no code path today that could
accidentally attach `fingerprint`, `signature`, or `error_class` to a
counter or histogram label. See `src/fingerprint/attributes.js` and ADR
006's "Consequences" section.

**Extending it:** `computeFingerprint(err, ctx, opts)`
(`src/fingerprint/compose.js`) accepts `opts.classifiers` to prepend your
own detection rules ahead of the built-in eight, and `opts.stackFrames` to
change how many stack frames feed the signature — see
`test/fingerprint/compose.test.js`'s "uses a custom classifiers list" and
"respects a custom opts.stackFrames count" tests, and
`examples/fingerprint-demo.js` for a runnable, standalone demo (`node
examples/fingerprint-demo.js`). Not yet wired through
`instrumentMcpServer()`'s own options — today this means importing
`computeFingerprint` directly rather than configuring the automatic
per-call-site wrapping; tracked in the roadmap below.

## Configuration

All options passed to `instrumentMcpServer(server, options)`. Source of
truth: `src/config.js`.

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceName` | string | — | Resource name for traces[^2] |
| `setupNodeSdk` | boolean | `false` | Dev mode: stderr tracer, no setup[^3] |
| `exporterUrl` | string | — | OTLP/HTTP traces endpoint[^4] |
| `enabled` | boolean | `true` | `false` disables all instrumentation |
| `enableMetrics` | boolean | `true` | `false` disables `mcp.tool.*` metrics only |
| `fingerprinting` | boolean | `true` | `false` disables `mcp.failure.*` attributes |

[^2]: Required only when `setupNodeSdk` is `true`. Has no effect otherwise — the host app's registered `TracerProvider` owns the resource; passing it anyway logs a one-time `diag.warn`.
[^3]: Creates and registers a `NodeTracerProvider` that always prints to stderr (safe alongside stdio-transport servers — ADR 003), additionally exporting via OTLP/HTTP if `exporterUrl` is set.
[^4]: Only takes effect when `setupNodeSdk` is `true`.

## Ordering constraint

Instrumentation works by wrapping the tool-call handler at the moment
it's registered. If a handler is registered before `instrumentMcpServer()`
runs, that handler was never wrapped — it slipped past the trap before it
was set.

Call `instrumentMcpServer()` **before** registering any tool handlers —
before `server.setRequestHandler(CallToolRequestSchema, ...)` (low-level
`Server`) or before any `.tool()`/`.registerTool()` call (`McpServer`).
See ADR 002 in `docs/adr/` for the detection logic that catches violations
of this at instrument time.

## Two modes

### Quick dev setup

`setupNodeSdk: true` sets up a `NodeTracerProvider` that prints spans to
stderr (safe alongside stdio-transport MCP servers — see ADR 003),
optionally plus an OTLP exporter if `exporterUrl` is provided. No separate
OTel SDK setup needed — `serviceName` is required in this mode, since it
names the resource of the provider opentel-mcp creates.

### Production setup

Omit `setupNodeSdk` (default `false`). opentel-mcp uses whatever
`TracerProvider` is already registered via
`trace.setGlobalTracerProvider()`, so it plugs into any existing OTel
setup without conflict. The host's `TracerProvider` owns the resource
here, so `serviceName` is not needed and has no effect — set
`service.name` on the host's `Resource` instead. Passing `serviceName`
anyway is harmless but logs a one-time `diag.warn`.

## Semantic conventions

`0.x` — the [MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
this library implements are Development-stage, not Stable, and may still
change upstream; breaking attribute renames will land in minor versions
until `1.0`, tracked in release notes rather than silently shipped.

opentel-mcp follows those conventions (published by the OTel GenAI SIG,
moved there from the main `semantic-conventions` repo, where the MCP
conventions are now deprecated) for everything they define, and adds two
namespaces of its own where they don't yet: `mcp.tool.*` (call-count and
duration metrics) and `mcp.failure.*` (failure fingerprinting). Both are
documented as non-spec at every attribute (`src/attributes.js`,
`src/fingerprint/attributes.js`), and are candidates to fold into the
spec's own metrics/error vocabulary if it grows an equivalent. Full
reasoning: ADR 004 in `docs/adr/`.

## Compatibility

- Node.js 20+
- Windows, macOS, Linux (CI matrix tested)
- Pure JavaScript, zero native dependencies
- Supports both low-level `Server` and high-level `McpServer` APIs
- @modelcontextprotocol/sdk ^1.0.0
- @opentelemetry/api ^1.9.0
- 127 tests (`npm test`) — see `test/`

## Roadmap

- v0.4: Deep Failure Fingerprinting ✓ — see "Failure Fingerprinting" above
  and ADR 006.
- v0.5: Failure clustering + regression detection
- Future: recovery hints, root-cause chaining across parent spans,
  alignment with the OTel GenAI SIG's MCP semantic conventions when
  published
- Also still tracked, not silently dropped: exposing `computeFingerprint`'s
  `classifiers`/`stackFrames` options through `instrumentMcpServer()`
  itself; opt-in `gen_ai.tool.call.arguments` support with a redaction
  callback; the spec's own `mcp.server.operation.duration` /
  `mcp.server.session.duration` metrics; W3C trace context propagation via
  `params._meta` per
  [SEP-414](https://modelcontextprotocol.io/community/seps/414-request-meta);
  and client-side instrumentation, so a single trace can span the client
  call and the server's tool execution

## Contributing

See CONTRIBUTING.md and docs/adr/ for architecture decisions.
Issues and PRs welcome.

## License

MIT © Thirumalaiboobathi B
