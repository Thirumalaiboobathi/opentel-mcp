# opentel-mcp

> Turn every MCP tool call into an OpenTelemetry trace — including the
> failures your logs won't show you, and what it cost in LLM tokens.

[![CI](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opentel-mcp.svg)](https://www.npmjs.com/package/opentel-mcp)
[![node](https://img.shields.io/node/v/opentel-mcp.svg)](https://www.npmjs.com/package/opentel-mcp)
[![license](https://img.shields.io/npm/l/opentel-mcp.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/LICENSE)

opentel-mcp watches every tool call your MCP (Model Context Protocol)
server handles: which tool ran, how long it took, whether it worked, and —
when the tool result carries usage data — how many tokens it burned and
what that cost. It reports all of that as OpenTelemetry (OTel) traces —
the standard most dashboards already read. One function call; no changes
to your tools' code.

opentel-mcp is the only Node.js MCP instrumentation library that ties
tool calls to LLM cost.

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

## MCP v2 (`@modelcontextprotocol/server`) support (v0.10.0+)

Both the original SDK and the new one work with `instrumentMcpServer()` —
they're two separate, OPTIONAL peer dependencies (install whichever one(s)
you actually use):

- `@modelcontextprotocol/sdk` ("v1" throughout this README) — protocol
  revisions through 2025-11-25. The `Server`/`McpServer` APIs above.
- `@modelcontextprotocol/server` ("v2") — protocol revision 2026-07-28,
  whose headline change is removing the `initialize` handshake and the
  `Mcp-Session-Id` Streamable HTTP header in favor of a stateless,
  self-contained-request model. Same `Server`/`McpServer` shapes, same
  `instrumentMcpServer()` call — detection and wrapping happen
  automatically, resolved once per `instrumentMcpServer()` call by which
  SDK the object you passed in actually came from (ADR 015,
  `docs/adr/015-mcp-v2-support.md`).

```js
import { McpServer } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from 'opentel-mcp';
import { z } from 'zod';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
instrumentMcpServer(server, { serviceName: 'my-mcp-server' });

server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));
```

**The important difference isn't the API — it's the deployment shape.**
v2's own `createMcpHandler`/`serveStdio` entry points construct a fresh
`Server`/`McpServer` instance **per request** (via a factory function you
provide), not once at process start — including for `createMcpHandler`'s
default stateless HTTP posture, not just an edge case. That means
`instrumentMcpServer()` has to run **inside the factory**, on every
invocation, not once at module load the way the v1 examples above do:

```js
import { createMcpHandler } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from 'opentel-mcp';

const handler = createMcpHandler((ctx) => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });

  // Runs on every request this factory serves. instanceKey is what makes
  // that not mean "trackers reset every time" — see below.
  instrumentMcpServer(server, { serviceName: 'my-mcp-server', instanceKey: 'my-mcp-server' });

  server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));

  return server;
});
```

**`instanceKey` (see the dedicated section below) is the mechanism for
this** — it's not a new, v2-specific option; it's the same one ADR 012
built for a v1 "stateless Streamable HTTP" deployment shape that turned
out to be exactly what v2 makes the *default*, SDK-recommended pattern
instead of something a host happened to build. Without it, the same four
in-memory trackers ("In-memory tracker state is scoped to one
instrumentMcpServer() call" below) reset to empty on every request under
this pattern, same as they always have for any fresh-instance-per-request
deployment — v2 doesn't change that mechanism, it just makes hitting it
the default instead of an edge case.

**What works today:** spans, standard attributes (`mcp.method.name`,
`gen_ai.tool.name`, `jsonrpc.request.id` — read from v2's `ctx.mcpReq.id`),
deep failure fingerprinting, `mcp.failure.channel`/`mcp.failure.validation_paths`
classification, and — as of this release — Agent Thrash Detection's
fallback-session path and transport auto-detection all work the same as
v1 (ADR 015 Phases 1–3, plus a follow-up round documented in ADR 015's
Update section):

- `isSingleConnectionTransport()` requires positive confirmation
  (`transport.constructor.name === 'StdioServerTransport'`) for v2
  specifically, instead of inferring single-connection from an absent
  `sessionId` property — closing a confirmed false positive against the
  transport `createMcpHandler` builds internally
  (`PerRequestHTTPServerTransport`), which also has no `sessionId`, for
  the opposite reason stdio doesn't. v1 is completely unaffected by this
  change. See `docs/known-gaps.md` entry 8 for the full history.
- The generated fallback session id is now shared across repeated
  `instrumentMcpServer()` calls when `instanceKey` is set (the same
  registry the four ADR-012 trackers already use), fixing the gap
  "instanceKey alone does not fix thrash detection" below originally
  described for v1's stateless deployment shape, for the v2 factory
  pattern specifically. See `docs/known-gaps.md` entry 6.

**One narrower thing still open**, tracked in `docs/known-gaps.md` entry
6's own update: `thrashSessionState` (the internal flag tracking "has
this server ever proven itself session-aware") is not registry-backed the
way the fallback id now is, so that specific memory still resets on every
v2 per-request call. This only matters for a deployment that mixes
real-session-id calls with occasional no-session-id ones under a shared
`instanceKey` — thrash detection using a **real** session id on every
call (`ctx.sessionId`) is unaffected either way.

Runnable end-to-end coverage lives in `test/instrument.v2.test.js` and
`test/integration/thrash-v2-transport-detection.test.js`, not a dedicated
`examples/` directory yet.

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

#### Using the Prometheus exporter instead of OTLP — `service.name` needs an extra option

If you scrape metrics with `@opentelemetry/exporter-prometheus` (pull-based)
rather than exporting over OTLP (push-based, the example above), be aware
that the Prometheus exporter does **not** attach resource attributes —
including `service.name` — to every metric point by default. It only
exposes them on a separate `target_info` series, which most PromQL you'd
actually write (`rate(mcp_tool_calls_total[5m])`, grouped `sum by
(gen_ai_tool_name)`, etc.) never joins against. In a single-service setup
this is invisible; the moment you're scraping more than one instrumented
server into the same Prometheus and need to tell their metrics apart —
which is exactly what a `service.name` filter/template variable is for —
every series looks identical without it.

Fix: pass `withResourceConstantLabels`, a regex matching the resource
attribute(s) you want flattened onto every point:

```js
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';

const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({ 'service.name': 'my-mcp-server' }),
  readers: [
    new PrometheusExporter({
      port: 9464,
      withResourceConstantLabels: /^service\.name$/,
    }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);
```

With this set, `mcp_tool_calls_total{...}` (and every other `mcp.tool.*`
series) carries a `service_name` label directly, so
`mcp_tool_calls_total{service_name="my-mcp-server"}` and a Grafana
`service.name` template variable both work without a `target_info` join.
See `dashboards/grafana-mcp-health.json` and `dashboards/dev/` in the repo
for a full worked example (dashboard JSON + a script that exercises this
exact setup end to end).

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
| mcp.failure.channel | `execution` \| `protocol.not_found` \| `protocol.input` \| `protocol.output` \| `protocol.other` \| `unknown` — see "Agent Thrash Detection" below | "protocol.input" |
| mcp.failure.validation_paths | Which schema field(s) a Zod validation failure named, one dot-joined path per failing issue — omitted entirely when nothing parseable was found (ADR 009) | `["email", "user.profile.age"]` |

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
006's "Consequences" section. `mcp.failure.validation_paths` above is
held to the exact same rule and for the exact same reason — field/path
names are bounded per tool but unbounded across every tool anyone
registers, so it is permanently excluded from `METRIC_SAFE_ATTRIBUTES`,
span-only, no exceptions (ADR 009).

**Field-level discrimination is a property of the fingerprint, not a
separate detector.** Two validation failures on the *same* schema field
normalize to the same message and hash to the *same* fingerprint, even
across different invalid values tried; a failure on a *different* field
normalizes differently and hashes to a *different* fingerprint. This
already falls out of hashing the full Zod issues JSON (which embeds each
failing field's path) — it is not a dedicated field-convergence detector,
and `mcp.failure.validation_paths` doesn't change this behavior, it just
makes it queryable instead of implicit in an opaque hash. See ADR 009
(`docs/adr/009-field-level-convergence.md`) for the full investigation,
including the one gap this doesn't cover: fixing one of several failing
fields changes the issues array's shape, which changes the fingerprint
even though another field is still failing underneath — tracked in
`docs/known-gaps.md`, not solved here.

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

## Error recording (v0.13.0+)

Every thrown `tools/call`/`tools/list` error goes through
`span.recordException(err)` (an OpenTelemetry SDK method, not one of this
library's own attributes) plus `span.setStatus({ code: ERROR, message:
err.message })` — unconditionally, whether or not `fingerprinting` is
enabled. By default that means `err.message` and `err.stack` land on the
span exactly as thrown. `errorRecording.mode` controls this:

| Mode | `exception.message` / status message | `exception.stacktrace` | When to use |
|---|---|---|---|
| `'full'` (default) | Raw `err.message`, unmodified | Raw `err.stack`, unmodified | Today's behavior, unchanged — matches what every other OTel-instrumented library in the same trace does for the same kind of event |
| `'normalized'` | `normalizeMessage(err.message)` — the exact scrubbing pipeline (`src/fingerprint/normalize/message.js`) fingerprinting already runs before hashing: UUIDs, emails, URLs, IPs, timestamps, filesystem paths, hex runs, quoted ids | Reconstructed from `parseAndNormalizeStack()` (`src/fingerprint/normalize/stack.js`) — keeps every function name/file/line, strips only the local `cwd` prefix (and collapses `node_modules` package versions) | Tool results come from third-party or unaudited MCP servers and you want the same scrubbing fingerprinting already trusts, applied to the raw exception content too |
| `'none'` | Not set — `span.setStatus({ code: ERROR })` with no message, the same pattern already used for tool-level `isError: true` failures | Not set | You rely entirely on `mcp.failure.*` (category/fingerprint/signature — already hashed/normalized) and don't want any free-text exception content on the span at all |

No mode mutates the original `err` — both call sites rethrow it
afterward, so `'normalized'`/`'none'` build the exception event
independently rather than editing `err.message`/`err.stack` in place.
`error.type`/`exception.type` (`err.name`) is capped at 128 characters
unconditionally in every mode — the same cap `mcp.failure.error_class`
uses — since a length cap on a class-identifier field costs a
well-behaved tool nothing, unlike message/stack content.

**`'normalized'` is targeted scrubbing, not general-purpose redaction —
read this before treating it as a PII filter.** `normalizeMessage()`
matches specific, structured shapes: UUIDs, email addresses, URLs,
IPv4/IPv6 addresses, ISO-8601/Unix timestamps, filesystem paths, long hex
runs, and quoted alphanumeric ids (8–64 chars, mixed letters/digits). It
does not recognize sensitive content in general. An API key in a format
none of those patterns match (a bare, unquoted token with no digit in it,
or a custom prefix scheme), or a customer's name embedded in ordinary
prose ("could not process request for Jane Smith"), passes through
`'normalized'` mode completely unchanged — identical to what `'full'`
mode would put on the span. Treat `'normalized'` as "the same scrubbing
fingerprinting already trusts for hashing," not as a guarantee that
whatever a tool's error messages contain is safe to record; if a tool's
errors routinely carry sensitive free text these patterns don't happen to
match, `'none'` is the only mode that keeps message/stack content off the
span entirely.

**Default stays `'full'` through all of `0.x`.** Changing it would alter
what every trace backend renders for the single highest-traffic failure
path in this library, silently, for every existing deployment that
doesn't opt in — see ADR 019 Part 1 (`docs/adr/019-raw-content-on-spans.md`)
for the full argument, including why the default is expected to flip to
`'normalized'` at `1.0`, not before.

### Configuration

| Option | Env var | Type | Default | Description |
|---|---|---|---|---|
| `mode` | `OTEL_MCP_ERROR_RECORDING_MODE` | `'full'` \| `'normalized'` \| `'none'` | `'full'` | See table above. An unrecognized value falls back to `'full'` silently, same as every other `OTEL_MCP_*` env var |

## Cost & Token Attribution (v0.5.0)

MCP tools increasingly wrap LLM calls themselves — a tool that
summarizes a document, drafts a reply, or classifies a ticket usually
does it by calling out to a model, and that call has a real dollar cost.
Standard MCP/OTel instrumentation has no opinion on any of this: a trace
shows a tool ran in 800ms and succeeded, with nothing about which model
it used, how many tokens it burned, or what that cost. That's the AI
FinOps gap in MCP observability today — cost and usage data exists
inside the tool call, but nothing carries it out to your traces. opentel-mcp
closes it: when a tool result carries recognizable usage data, the same
span your other instrumentation already reads also gets token counts, the
detected model, and an estimated USD cost.

### Zero-config quick-start

```js
import { instrumentMcpServer } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true, // dev mode: prints traces to your terminal
});
```

That's it — `costTracking` defaults to enabled. Any tool result whose
usage data matches one of `defaultExtractor`'s recognized conventions
(Anthropic's `usage.input_tokens`/`usage.output_tokens`, OpenAI's
`usage.prompt_tokens`/`usage.completion_tokens`, Bedrock's
`usage.inputTokens`/`usage.outputTokens`, the MCP `_meta.usage` extension
point, or JSON-in-text inside `content[0].text`) automatically gets
`mcp.tool.tokens.*` / `mcp.tool.model` / `mcp.tool.cost.*` span
attributes, priced against `DEFAULT_PRICING`.

### Advanced: overriding pricing, a custom extractor, and a budget guardrail

```js
import { instrumentMcpServer } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  costTracking: {
    // Merged per-model OVER DEFAULT_PRICING — correct a stale price or add
    // a model DEFAULT_PRICING doesn't know about, without having to spread
    // the whole default table yourself. Everything you don't name here is
    // untouched. See "Overriding pricing" below.
    pricing: {
      'my-internal-model': { pricingKind: 'chat', inputPer1M: 1.0, outputPer1M: 2.0, currency: 'USD' },
    },
    // Recognize your own tool result shape. Return null for anything you
    // don't recognize — never throw (see src/cost/extractor.js).
    extractor: (toolResult) => {
      if (!toolResult?.tokenStats) return null;
      const { in: inputTokens, out: outputTokens, modelId } = toolResult.tokenStats;
      return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model: modelId };
    },
    // Observability guardrail, NOT enforcement — opentel-mcp never blocks
    // or throws on a budget overrun, it just flags the span.
    budget: {
      perSessionUsd: 5, // flag once one MCP session's calls total > $5
      perToolUsd: 1, // ...or once any single tool's calls total > $1
    },
  },
});
```

### Overriding pricing (v0.11.0+)

Two ways to change what `costTracking` prices against, composing as
`{ ...(pricingTable ?? DEFAULT_PRICING), ...pricing }` — see ADR 016
(`docs/adr/016-pricing-override-and-staleness.md`) for the full reasoning:

- **`costTracking.pricing`** — a *partial* table, merged **per-model**
  over `DEFAULT_PRICING` (or over `pricingTable`, if you set both). Each
  key you supply replaces that one model's entire pricing entry; every
  model you don't name keeps its default price. This is the recommended
  way to correct a stale number or add a model — enterprises on
  committed-use discounts, AWS EDP, Bedrock provisioned throughput, or
  Azure OpenAI negotiated rates should use this to reflect what they
  actually pay, not list price.
- **`costTracking.pricingTable`** — *fully replaces* `DEFAULT_PRICING`.
  Use this when you want an effective table containing **only** your own
  models, none of `DEFAULT_PRICING`'s.

A model priced via either option reports `pricing_status: 'user_override'`
(see the span attributes table below) instead of `'known'`.

### Embedding models (v0.11.0+)

Embeddings are input-token-only — there's no "output" to price. Rather
than modeling that as `outputPer1M: 0` (indistinguishable from a
data-entry bug), `ModelPricing` carries an explicit
`pricingKind: 'chat' | 'embedding'` discriminator; an `'embedding'` entry
has no `outputPer1M` field at all, and `calculateCost()` never reads
`outputTokens` for one. `DEFAULT_PRICING` includes OpenAI
`text-embedding-3-small`/`text-embedding-3-large`/`text-embedding-ada-002`,
Cohere `cohere-embed-v3`, and Bedrock `amazon-titan-embed-v2` out of the
box. A pre-v0.11.0 custom pricing entry with no `pricingKind` field is
still treated as `'chat'` at runtime — only the TypeScript type is
stricter, not the runtime.

### Span attributes

| Attribute | Standard OTel? | Description | Example |
|---|---|---|---|
| `mcp.tool.tokens.input` | Custom | Input tokens consumed | 1000 |
| `mcp.tool.tokens.output` | Custom | Output tokens produced | 500 |
| `mcp.tool.tokens.total` | Custom | input + output | 1500 |
| `mcp.tool.model` | Custom | Detected model name, gated by a length/shape check (v0.13.0) — see below | "claude-sonnet-5" |
| `gen_ai.response.model` | Standard (GenAI semconv)[^5] | Same value as `mcp.tool.model`, co-emitted for dashboard compatibility | "claude-sonnet-5" |
| `mcp.tool.pricing_status` | Custom[^7] | `"known"` \| `"unknown"` \| `"user_override"` — set whenever token usage was extracted, even with no model detected | "known" |
| `mcp.tool.cost.usd` | Custom | Estimated cost, from `calculateCost()` | 0.0105 |
| `mcp.tool.cost.currency` | Custom | Always `"USD"` today | "USD" |
| `mcp.tool.cost.budget_exceeded` | Custom | `true` once a configured `costTracking.budget` limit is crossed | true |
| `mcp.tool.cost.budget_scope` | Custom | Which budget scope tripped: `"session"` \| `"tool"` (session wins if both did) | "session" |

[^5]: `gen_ai.response.model` is a real OTel GenAI semantic convention attribute ("the name of the model that generated the response") — but this span is an MCP tool-call span (`gen_ai.operation.name: execute_tool`), not a dedicated LLM request/response span, so co-emitting it here is a **pragmatic dashboard-compatibility choice, not a spec-pure emission**. It's set purely so off-the-shelf GenAI dashboards (Grafana, SigNoz, Honeycomb) that filter/group by `gen_ai.response.model` pick these spans up without any opentel-mcp-specific configuration. Full reasoning in `src/attributes.js`'s `ATTR_GEN_AI_RESPONSE_MODEL` docblock.
[^7]: `mcp.tool.pricing_status` is provenance-based, not value-based: `"user_override"` means the model's key was present in your `costTracking.pricing`/`pricingTable`, whether or not the numbers you supplied happen to match `DEFAULT_PRICING`. `"unknown"` covers both "no model detected" and "model detected but not priceable" (unrecognized, or a malformed override entry) — see ADR 016 point 4.

The four token/model attributes are set together or not at all;
`mcp.tool.pricing_status` is set whenever usage was extracted at all
(unlike the model/cost attributes, it's present even with no model
detected); the two cost attributes only appear when a model was detected
*and* it resolves in the effective pricing table; the two budget
attributes only appear when a cost was calculated *and* a configured
limit was crossed. Source of truth: `src/attributes.js` and
`src/instrument.js`'s `applyCostAttribution()`.

### Model identifier validation (v0.13.0)

A tool result's declared model field (`result.model`, `result.usage.model`,
`result._meta.model`, or the same read out of JSON in
`result.content[0].text`) is tool-result content, not library-computed
metadata like everything else `applyCostAttribution()` puts on a span — so
before it can reach `mcp.tool.model`, `gen_ai.response.model`,
`calculateCost()`, or a metric label
(`mcp.tool.tokens.total`/`mcp.tool.cost.total`), it has to pass a length
cap (256 characters) and character allowlist
(`/^[A-Za-z0-9._:/@-]{1,256}$/`). The allowlist is deliberately generous —
verified against every `DEFAULT_PRICING` key *and* `normalizeModelName()`'s
documented `provider/model` input contract (e.g.
`"Anthropic/Claude-Opus-4-7"`), plus headroom for conventions like a full
Bedrock ARN or a Vertex AI `@version` suffix — because silently rejecting a
legitimate model name is a worse failure than admitting a few characters
no known provider convention actually uses.

**A rejected value is never a silent drop.** `mcp.tool.pricing_status` is
set to `"unknown"` — the same status a legitimately unrecognized model
already produces (see the footnote above) — and a `diag.warn()` fires
once per `instrumentMcpServer()` call, reporting shape only (length, and
whether length or character class failed), **never the rejected value
itself**: echoing a malformed model id into log output would just move
this exact problem from spans into logs instead of closing it. Token
counts (`mcp.tool.tokens.*`) are unaffected either way — they're set
before this gate runs. `costTracking.pricing`/`pricingTable` override keys
(operator-authored config) are never subject to this check — only
tool-result content is. Full design: ADR 019 Part 2
(`docs/adr/019-raw-content-on-spans.md`).

### Metrics

Two more `mcp.tool.*` metrics, via the same API-only pattern as the four
in "Metrics" above — nothing recorded until a `MeterProvider` is
registered, `enableMetrics: false` opts out of these too.

| Metric | Type | Unit | Attributes | Emitted when |
|---|---|---|---|---|
| `mcp.tool.tokens.total` | Counter | tokens | `gen_ai.tool.name`, `mcp.tool.model`[^6], `mcp.tool.pricing_status` | Usage detected in the tool result |
| `mcp.tool.cost.total` | Counter | USD | `gen_ai.tool.name`, `mcp.tool.model`[^6], `mcp.tool.pricing_status` | Cost calculated (model resolved in the effective pricing table) |

[^6]: `mcp.tool.model` is only added when a model was detected — the same optional-attribute cardinality pattern `mcp.failure.category` already uses on the other four metrics. `mcp.tool.pricing_status` is always added — a fixed, closed 3-value enum, well within this package's metric-label cardinality discipline (see `COST_METRIC_SAFE_ATTRIBUTES` in `src/attributes.js`).

Grouping `mcp.tool.tokens.total` by `mcp.tool.pricing_status` answers "what
fraction of tokens/spend is running through models we can't price" as a
direct query, instead of inferring it from missing `mcp.tool.cost.*` data.

### Pricing accuracy and staleness

> **`DEFAULT_PRICING` is a best-effort snapshot, not a maintained price
> list.** Provider pricing changes frequently and varies by region/contract
> — `opentel-mcp` does not guarantee it stays current, and says so at
> runtime, not just here: once `DEFAULT_PRICING` (checked via
> `DEFAULT_PRICING_LAST_VERIFIED`, also exported) is more than 90 days
> past its last-verified date, `instrumentMcpServer()` fires a one-time
> `diag.warn()` naming that date — and, when `setupNodeSdk: true`, also
> attaches an `mcp.pricing.default_table_last_verified` resource
> attribute, so long-running deployments can alert on it directly. Both
> only fire when `DEFAULT_PRICING` is actually contributing to your
> effective table (i.e. you haven't fully replaced it via `pricingTable`)
> — see ADR 016 point 3.

`DEFAULT_PRICING` (`src/cost/pricing.js`) covers 20+ models — chat and
embedding — across six providers: Anthropic, OpenAI, Google, Cohere, AWS
Bedrock, and DeepSeek. **Bedrock entries (Nova and Titan embeddings)
assume us-east-1 list pricing** — Bedrock pricing varies by region and
this table is not region-keyed (no reliable region signal exists in any
tool-result usage shape this package recognizes to key a lookup on — see
ADR 016 point 5); override via `costTracking.pricing` for a different
region.

### Extending it

- `defaultExtractor` (also exported) recognizes the five conventions
  listed under "Zero-config quick-start" above; pass your own
  `costTracking.extractor` (a `UsageExtractor`: `(toolResult) =>
  TokenUsage | null`, never throwing) to recognize anything else.
- `calculateCost(inputTokens, outputTokens, model, pricingTable)` is also
  exported directly, for recomputing cost outside the instrumentation
  hot path (e.g. over historical spans). Malformed pricing entries
  (missing/negative/non-numeric `inputPer1M`/`outputPer1M`) degrade to
  `null`, same as an unknown model — never throws.
- `isDefaultPricingStale(now?, thresholdDays?)` (also exported) is the
  pure function backing the staleness warning above, if you want to check
  it yourself (e.g. in a startup health check).
- Disable everything in this section with `costTracking: { enabled:
  false }`; tracing, metrics, and fingerprinting are all unaffected.
- Budget tracking (`costTracking.budget`) is in-memory and scoped to one
  `instrumentMcpServer()` call — see "In-memory tracker state is scoped to
  one instrumentMcpServer() call" below for what that means under a
  fresh-`Server`-per-request deployment. Session-scoped limits are also
  skipped gracefully (not enforced against a fallback key) for transports
  with no session id, like stdio. **`perSessionUsd` is unsupported under
  stateless MCP (no real session id available at all) — unchanged from
  ADR 012's conclusion, and there is no fix pending.** Unlike thrash
  detection, this budget tracker has no fingerprint-equivalent attribute
  on the span today, so "Fleet-wide fingerprint frequency" below has
  nothing to substitute with for this scope specifically. `perToolUsd` is
  unaffected — it never depended on session id.
- **A budget only ever sees priced spend — an unpriced call (`mcp.tool.pricing_status:
  "unknown"`) never reaches it at all, and never counts toward
  `perSessionUsd`/`perToolUsd`, regardless of how many tokens it burned**
  (`docs/known-gaps.md` entry 9). v0.12.0 makes this loud instead of
  silent, but does not close it: setting a `budget` at all fires a one-time
  `diag.warn()` naming the constraint up front, and the first time an
  actual unpriced call happens while a budget is active, a second one-time
  `diag.warn()` names the model and which scope(s) are configured. Both
  are pure diagnostics — no new span attribute, no change to
  `mcp.tool.cost.budget_exceeded`'s meaning, and an unpriced call still
  contributes nothing to the running total. Deliberate: inventing a
  fallback price for an unpriceable call would trade one confidently-wrong
  number (silent zero) for a different one (a made-up price) — the exact
  failure this attribute/warning pair exists to catch, one layer up. If
  you're seeing either warning, the fix is the same one "Overriding
  pricing" above already documents: add the model to `costTracking.pricing`.
  Both warnings inherit the same per-tracker-instance granularity as the
  budget tracker itself — see the item above and `src/cost/budget.js`'s
  `createBudgetTracker()` docblock for exactly what that means under a
  fresh-`Server`-per-request deployment (a stable `instanceKey` shares one
  tracker, and one already-armed warning, across calls; without one, both
  warnings re-fire on every request).

## Agent Thrash Detection (v0.6.0+)

Watches for the same tool failing with the same v0.4 failure fingerprint
several times in a row inside one session — the pattern an LLM agent
produces when it keeps retrying a call that can't succeed. When that
crosses a threshold, it attributes the tokens and cost (v0.5) burned by
the whole retry loop to one event, instead of leaving it scattered across
N indistinguishable failed-tool-call spans.

### Zero-config quick-start

```js
import { instrumentMcpServer } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
});
```

That's it — `thrashDetection` defaults to enabled, same as `fingerprinting`
and `costTracking`. Any tool that fails 3 times in a row with the same
fingerprint inside 60 seconds gets flagged automatically. **Requires
`fingerprinting: true`** (also the default): detection keys off the same
`mcp.failure.fingerprint` fingerprinting computes, so with fingerprinting
disabled, thrash detection silently never fires, regardless of
`thrashDetection`'s own settings.

### Channel-aware thresholds (v0.7.0)

Not every repeated failure means the same thing. `mcp.failure.channel`
(see "Span attributes" above) classifies *where* a tools/call failure
actually came from, and thrash detection uses that classification to pick
a different threshold per channel instead of treating every repeat
identically:

| `mcp.failure.channel` | What it means | Threshold |
|---|---|---|
| `execution` | The call reached the tool and the tool itself reports a business-logic failure (`isError: true`). Retrying an unchanged upstream failure identically **is** thrash. | `threshold` (default 3) — unchanged from v0.6.0 |
| `protocol.input` | A JSON-RPC `InvalidParams` (-32602) whose message indicates the *agent* supplied bad arguments. An agent retrying with adjusted arguments may be genuinely converging on a correct call, not thrashing. | `inputThreshold` (default 5) — higher |
| `protocol.not_found` | `MethodNotFound` (-32601), or `InvalidParams` indicating an unknown/disabled tool. Retrying a tool name that doesn't exist is never convergence — there's no "getting closer" to a tool that isn't there. | `notFoundThreshold` (default 1) — an immediate flag |
| `protocol.output` | An `InvalidParams` (-32602) whose message indicates the **tool's own output** failed its declared output schema. This is the server author's bug — no argument the agent supplies can ever fix it. | **Excluded from thrash detection entirely.** Never counted, no matter how many times it repeats. |
| `protocol.other` | Any other JSON-RPC error code, or an unrecognized `-32602` message shape. | `threshold` (same as `execution`) |
| `unknown` | The failure doesn't confidently resemble either the execution or protocol shape. | `threshold` (same as `execution`) |

**This closes a real false positive present in every published version
through v0.6.1**: an output-validation bug — entirely the tool author's
fault — that an agent naively retried was being counted as agent thrash
before this release, because nothing distinguished it from an ordinary
repeated business-logic failure. It no longer is. Full investigation and
design rationale: ADR 007 (`docs/adr/007-protocol-error-channel.md`).

Configure the two new thresholds the same way as every other
`thrashDetection` field — see "Configuration" below.

### Reachability: high-level `McpServer` vs. low-level `Server`

**Read this before assuming `mcp.failure.channel` gives you full protocol
visibility on every server.** How much of the table above you actually
see depends on which server API you instrument, and the honest picture is
more limited than "protocol errors are now detected everywhere":

The high-level `McpServer` (`.tool()`/`.registerTool()` — the ergonomic,
documented API most real MCP servers use) already catches nearly every
protocol-shaped failure itself and converts it to `isError: true` *before*
this library ever sees a thrown error — tool not found, tool disabled,
input validation, output validation, or any other bug in a handler, all
land as `isError: true`, with the sole exception of one narrow
elicitation-flow error type. That means most of what `mcp.failure.channel`
reveals for `McpServer` users was **already visible via `isError`** before
this release — this feature isn't adding protocol-error detection where
none existed; it's adding *sub-classification* on top of detection that,
for the most part, already existed.

| `mcp.failure.channel` value | High-level `McpServer` | Low-level `Server` (hand-rolled dispatcher) |
|---|---|---|
| `execution` | Reachable — and the *only* value most failures produced before this release (see below) | Reachable when the handler returns `{isError:true}` itself |
| `protocol.not_found` | Not reachable via a raw thrown error (`McpServer` swallows it) — reachable only via the recovery mechanism below | Reachable directly |
| `protocol.input` | Same — recovery-only | Reachable directly |
| `protocol.output` | Same — recovery-only | Reachable directly |
| `protocol.other` | Reachable via a raw thrown error only for one narrow elicitation-flow error code; not a general catch-all for `McpServer` | Reachable for any other code, or an unrecognized `-32602` message |
| `unknown` | Effectively not reachable via a raw thrown error — `McpServer`'s catch swallows *any* error, not just protocol-shaped ones | Reachable for a thrown value with no error code at all |

For the low-level `Server`, all six values are directly reachable, since
nothing intercepts a thrown error before this library's own span/thrash
wrapping runs — this attribute's richest, most direct value is for
low-level `Server` users.

For `McpServer` users, closing the false positive above (the point of
this release) required a **recovery step**: `McpServer` preserves the
original error's message verbatim when it converts a thrown error to
`isError: true`, including the exact `MCP error {code}: ` wrapper its
error class's constructor always adds. `classifyFailureChannel()` reads
that wrapper back out of the disguised `isError: true` result and
recovers the real channel from it, falling back to `execution` only when
the message doesn't match that shape (i.e. it's a genuine, tool-authored
business message, not a disguised protocol failure). This is what makes
`protocol.output`'s exclusion actually work for `McpServer` users too —
without it, the false positive this release fixes would only have been
fixed for hand-rolled low-level `Server` apps.

**This recovery step is inherently fragile**, coupled to matching the
exact prose the installed SDK version happens to use — both the `MCP
error {code}: ` wrapper and the `-32602` sub-case message markers
(`"Input validation error:"`, `"Output validation error:"`, and the
looser `"not found"`/`"disabled"` substring matches). If the SDK changes
either format, the classifier degrades safely to `execution` (never a
thrown error, never a wrong specific answer) rather than breaking — but a
future SDK version could silently reopen part of the gap this release
closes. See ADR 007's addendum for the full verification, including how
this was confirmed against a real `McpServer` and a real Zod output
schema before being fixed.

**Known limitation — a forwarded/proxied error can collide with this
recovery.** A tool that forwards another MCP call's error text verbatim
(an orchestrator or proxy tool surfacing a downstream failure) could
plausibly produce a message starting with the same `MCP error {code}: `
wrapper, purely by coincidence of forwarding real McpError text. For most
codes this is cosmetic (`protocol.other` shares `execution`'s threshold).
The sharp case: a forwarded output-validation-shaped message would be
**excluded from thrash detection entirely**, even though it may be a
genuine, repeatable failure from the forwarding tool's own perspective —
a false negative, not a false positive. Assessed as an acceptable,
narrow risk for this release (see ADR 007's addendum for the full
reasoning); revisit if this pattern turns out to be common in practice.

### Metrics

Same API-only pattern as every other metric in this README — nothing
recorded until a `MeterProvider` is registered.

| Metric | Type | Unit | Attributes | Emitted when |
|---|---|---|---|---|
| `mcp.tool.loop.detected` | Counter | — | `gen_ai.tool.name` | A loop crosses `threshold`, and again every `reEmitAfter` failures past it |
| `mcp.tool.loop.length` | Histogram | — | `gen_ai.tool.name` | Same |
| `mcp.tool.loop.wasted_tokens` | Histogram | tokens | `gen_ai.tool.name` | Same |
| `mcp.tool.loop.wasted_cost_usd` | Histogram | USD | `gen_ai.tool.name` | Same |
| `mcp.tool.loop.duration` | Histogram | ms | `gen_ai.tool.name` | Same |

Every metric above carries **only** `gen_ai.tool.name`. `mcp.failure.fingerprint`
and `mcp.loop.session_id` are deliberately excluded from every one of them
— both are unbounded, per-caller values (a new bug is a new fingerprint,
forever; a new session is a new session id, forever), so putting either on
a metric label would turn every distinct bug or session into its own
permanent time series. See `METRIC_SAFE_ATTRIBUTES`'s docblock in
`src/fingerprint/attributes.js`. Full detail is still available — on the
span event below, where high-cardinality attributes are safe.

### Span event: `mcp.loop.detected`

Added to the **currently active span** (never a new one) each time a loop
metric above fires.

| Attribute | Description |
|---|---|
| `mcp.loop.length` | Consecutive same-fingerprint failures in the loop, at the moment of this emission |
| `mcp.loop.wasted_tokens_in` | Cumulative input tokens burned by the loop so far |
| `mcp.loop.wasted_tokens_out` | Cumulative output tokens burned by the loop so far |
| `mcp.loop.wasted_cost_usd` | Cumulative estimated USD cost burned by the loop so far |
| `mcp.loop.duration_ms` | Elapsed ms between the loop's first and most recent failure |
| `mcp.loop.first_span_id` | Span id of the loop's first failure |
| `mcp.loop.first_trace_id` | Trace id of the loop's first failure |
| `mcp.loop.session_id` | The session this loop belongs to |
| `mcp.failure.fingerprint` | The shared fingerprint (see "Failure Fingerprinting" above) |

**Also sets a boolean span *attribute*, `mcp.tool.thrash_detected: true`**,
on that same span, alongside the event above (v0.8.0, ADR 011 —
`docs/adr/011-cost-aware-sampling.md`). This exists for one specific
consumer: an OpenTelemetry Collector's `tailsamplingprocessor`, whose
`boolean_attribute` policy matches top-level span attributes — whether
such a policy can also match span-*event* data was investigated and left
genuinely unverified (no Go source to check against in this repository),
so the attribute exists to remove that uncertainty entirely for anyone
wiring up cost/thrash-aware tail sampling. See "Cost-aware trace sampling
(a Collector recipe, not a library feature)" below. Deliberately named
*differently* from the `mcp.tool.loop.detected` **metric** counter above,
not reusing its string: a metric name and a span attribute key are
unrelated OTel namespaces with no actual technical conflict, but the one
reader who most needs this name to be unambiguous — someone writing a
Collector tail-sampling policy — would otherwise see one bare string with
no way to tell which of the two same-named signals they're keying on.

### Configuration

All fields of `thrashDetection`, each independently overridable by its own
`OTEL_MCP_THRASH_*` env var (first env-var-driven config in this
codebase) — precedence is explicit option field, then env var, then
default; an invalid/unparseable env value falls back to the default
silently, never throws. Source of truth: `src/thrash/config.js`.

| Option | Env var | Type | Default | Description |
|---|---|---|---|---|
| `enabled` | `OTEL_MCP_THRASH_ENABLED` | boolean | `true` | `false` disables thrash detection entirely |
| `threshold` | `OTEL_MCP_THRASH_THRESHOLD` | number | `3` | Consecutive same-fingerprint failures required to trigger detection |
| `windowMs` | `OTEL_MCP_THRASH_WINDOW_MS` | number | `60000` | Failures must fall inside this rolling window to count toward the same loop |
| `maxTrackedKeys` | `OTEL_MCP_THRASH_MAX_TRACKED_KEYS` | number | `1000` | LRU cap on the bounded store (`src/thrash/store.js`) |
| `entryTtlMs` | `OTEL_MCP_THRASH_ENTRY_TTL_MS` | number | `900000` | How long an idle tracked key survives before expiry |
| `reEmitAfter` | `OTEL_MCP_THRASH_RE_EMIT_AFTER` | number | `3` | Re-emit every N further failures past `threshold` (e.g. 3, 6, 9, ...) instead of once |
| `assumeSingleSession` | `OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION` | boolean | `false` | Force-permits the fallback session id even when the transport can't be determined — see below |
| `inputThreshold` | `OTEL_MCP_THRASH_INPUT_THRESHOLD` | number | `5` | Per-origin threshold (ADR 007) for `mcp.failure.channel: protocol.input` — higher than `threshold`, since an agent retrying with adjusted arguments may be converging |
| `notFoundThreshold` | `OTEL_MCP_THRASH_NOT_FOUND_THRESHOLD` | number | `1` | Per-origin threshold (ADR 007) for `mcp.failure.channel: protocol.not_found` — lower than `threshold`; retrying a nonexistent tool is never convergence |

**A note on defaults and client-side retry caps.** Every threshold above
assumes an effectively uncapped agent — one that keeps retrying an
identically-failing call at least as many times as the threshold. Some
agent frameworks impose their own client-side cap on same-arguments
retries (e.g. giving up and reporting failure after 2 identical
attempts). If an agent's own cap is lower than the relevant threshold
(the default `threshold` is 3), that agent's thrashing never crosses the
threshold and `mcp.tool.loop.detected` never fires for it — arguably
correct in isolation (2 identical failures is a weaker signal than 3),
but worth knowing before assuming detection is silently catching
everything. If you know your agent framework caps retries at N, consider
setting the relevant threshold to N. Tracked as an open question, not
solved here: `docs/known-gaps.md`.

### Session id resolution — read this before setting `assumeSingleSession`

**This is the one setting most likely to get misconfigured, so this
section is deliberately explicit.** Thrash detection needs a session
boundary to group repeated failures under — merge two different clients'
failures into one bucket and you get a false-positive loop that never
happened to either client individually.

MCP sessions have a transport-provided id (`extra.sessionId`) on
session-oriented transports, but stdio has none — there's exactly one
connection for the process's whole lifetime instead. The resolution rules,
in order:

1. **A real `extra.sessionId` always wins**, and permanently marks the
   server as session-aware.
2. **Once a server has been observed handing out a real session id, a
   later call with none is skipped entirely** — never merged into a
   shared fallback key, even if `assumeSingleSession` is set. A server
   that has proven it hands out real session ids doesn't get to fall back
   just because one particular call lacked one.
3. **(v0.12.0, ADR 018) Before any real session id has ever been observed,
   and before the generated-fallback rule below runs**, if this call's
   span has a validly-extracted REMOTE trace parent — i.e.
   `request.params._meta` carried a valid W3C `traceparent` (see "Trace
   Context Propagation" below) that resolved to a remote `SpanContext`,
   not a freshly-generated root span — that parent's **trace id** is used
   as the session-id candidate instead. Never reads a span's own `traceId`
   unconditionally: a root span's trace id is fresh, random, and different
   on every single call, so using it without confirming it was actually
   inherited from a real upstream parent would silently turn "skip,
   undetermined" into "always produce a session id that never matches the
   previous call's" — quieter and worse than skipping. Does **not** mark
   the server session-aware (`hasSeenRealSessionId` stays untouched) — a
   trace id being present on one call is a fact about that one client's
   behavior, not a proof about the transport itself.

   **⚠️ Read this before assuming it closes the stateless-MCP session gap
   below.** This only fires when the calling *client* chooses to
   propagate trace context into `_meta.traceparent` — today, that means
   third-party OTel instrumentation (e.g.
   `@arizeai/openinference-instrumentation-mcp`) wrapping **v1-based** SDK
   clients, not either MCP SDK's own built-in behavior; no
   v2-targeting instrumentation exists yet. **It does not close
   `docs/known-gaps.md` entry 6** — a v2/2026-07-28-native deployment
   whose client doesn't propagate `_meta.traceparent` (the default,
   unconfigured case for essentially every v2 client today) gets nothing
   new here: the exact same skip behavior as before. Full investigation,
   including why one trace is typically one agent turn (not a protocol
   guarantee) and the residual merge risk this accepts: ADR 018
   (`docs/adr/018-trace-id-as-thrash-fallback.md`).
4. **Before any real session id has ever been observed, and no usable
   trace id was found above**, a generated per-connection fallback id is
   used only when:
   - the transport is **structurally confirmed single-connection** — no
     `sessionId` property on `server.transport` at all (e.g. stdio's
     `StdioServerTransport`, which has no session concept whatsoever), or
   - **you set `assumeSingleSession: true`** — an explicit opt-in for
     transports the auto-detection can't see (e.g. a custom `Transport`
     implementation), where you already know every connection is 1:1.

   Otherwise — an undetermined, potentially multi-client transport, with
   `assumeSingleSession` left at its default `false` — detection is
   **skipped silently** for that call rather than guessing.

**For `@modelcontextprotocol/server` (v2) users:** this structural check —
"no `sessionId` property on the transport" — is v1-specific. v2's
transport `createMcpHandler` builds internally
(`PerRequestHTTPServerTransport`) *also* declares no `sessionId`
property, but for the opposite reason stdio doesn't: the 2026-07-28
protocol revision has no session concept at the transport level at all,
not because each instance is genuinely 1:1 with one client — so for v2
specifically, this function requires POSITIVE confirmation
(`transport.constructor.name === 'StdioServerTransport'`) instead of
inferring single-connection from the absent property. `PerRequestHTTPServerTransport`
correctly falls through to "undetermined" rather than being misclassified.
v1's own check is completely unaffected by this. See `docs/known-gaps.md`
entry 8 for the full history (including the period where this was a
confirmed, live false positive) and ADR 015's Update section for the
design argument.

**The risk of getting this wrong:** if you set `assumeSingleSession: true`
on a transport that's actually serving multiple concurrent clients (a
typical HTTP/SSE deployment behind a load balancer, for instance), their
failures get merged into one shared session key. Three unrelated clients
each failing once looks identical to one client failing three times in a
row — a false-positive `mcp.loop.detected` event that never happened to
any real session. Only set `assumeSingleSession: true` when you have
independent knowledge that the transport is genuinely 1:1 (a custom
in-process transport, a dedicated single-tenant connection, etc.) — never
as a blanket "make the warning go away" setting. A one-time `diag.warn`
fires the first time the fallback is actually used on a given server,
naming exactly which of the three conditions above triggered it, so you
have a chance to catch a wrong assumption before it produces bad data.

### In-process summary

For a zero-infrastructure quick check — no metrics backend, no trace
viewer, just "is anything thrashing right now" — the object
`instrumentMcpServer()` returns gets a `getThrashSummary()` method:

```js
const server = instrumentMcpServer(new Server(...), { serviceName: 'my-mcp-server' });

// ...later, e.g. in a health-check handler or just to eyeball it:
console.log(server.getThrashSummary());
// {
//   activeLoops: 1,
//   totalLoopsDetected: 4,
//   totalWastedCostUsd: 0.09,
//   totalWastedTokensIn: 3600,
//   totalWastedTokensOut: 900,
//   topOffenders: [
//     { toolName: 'lookup_customer', fingerprint: 'a3f4c8e2b1d09f77', loops: 3, wastedCostUsd: 0.03, wastedTokensIn: 900, wastedTokensOut: 225 },
//   ],
// }
```

No OTel involved — nothing sent anywhere, safe to call from application
code. Never throws; returns an all-zero summary if `thrashDetection` is
disabled, or if instrumentation is disabled entirely (in which case
`getThrashSummary` isn't attached at all — check for its presence, same
as `shutdown`).

**`activeLoops` and `topOffenders` are bounded by `maxTrackedKeys`, and
are not a complete history.** They reflect only what's currently sitting
in the bounded LRU+TTL store this instant — a loop that got evicted (past
`maxTrackedKeys`) or expired (past `entryTtlMs`) since it was last
detected won't appear in either, even though it really happened.
`totalLoopsDetected` and `totalWasted*`, by contrast, are cumulative
counters that survive both eviction and expiry — they answer "how much
has this process wasted since it started" (or since the last call to an
internal `reset()`), not "what's currently active." Don't read
`topOffenders` as an audit log; read the cumulative totals for that.

### Known limitations

**In-memory tracker state is scoped to one `instrumentMcpServer()` call** —
see "In-memory tracker state is scoped to one instrumentMcpServer() call"
below. Under a fresh-`Server`-per-request deployment (e.g. stateless
Streamable HTTP), consecutive-failure tracking never accumulates past a
single call, and `mcp.tool.loop.detected` never fires — silently. Confirmed
gap, ADR 012.

**For deployments with no real session id at all** (see "instanceKey"
above, specifically the "MCP spec 2026-07-28" subsection, for exactly
when this applies) — **thrash detection is unsupported, unchanged from
ADR 012's conclusion.** There is a partial, downstream substitute: "Fleet-
wide fingerprint frequency" below. Read its caveat before treating it as a
fix for this gap — it detects how often a bug occurs across every caller,
not whether one agent is looping.

**A malformed `tools/call` request produces zero telemetry — no span, no
fingerprint, nothing.** If a request fails `CallToolRequestSchema`
validation itself (e.g. a missing or wrongly-typed `name`/`arguments`
field), the SDK's own request-parsing step throws *before*
`instrumentMcpServer()`'s wrapped handler is ever invoked — there's no
span to attach a status to and no error object reaches
`computeFingerprint()`. This is invisible by construction: closing it
means wrapping a layer above where this library currently patches
(`setRequestHandler`'s `handler` argument), which is exactly the larger,
less stable dependency surface ADR 001 chose not to depend on. **Deferred,
not solved** — tracked in `docs/known-gaps.md`, and would need its own
design pass (effectively revisiting ADR 001) rather than a patch-level
fix.

See `docs/known-gaps.md` for this gap in full, plus four more not fully
covered by this release: field-level convergence tracking for
`protocol.input` (distinguishing "ambiguous tool schema" from "agent is
converging" — mostly already works as a side effect of fingerprinting,
see "Failure Fingerprinting" above and ADR 009, but partial convergence
within that is its own separate, still-open entry), an
observation-liveness contract for `getThrashSummary()` (so "nothing
failed" and "nothing is being observed at all" stop looking identical),
and how client-side agent retry caps interact with the thresholds above.

### Benchmarks

Two kinds, both under `bench/` and `test/thrash/`:

- **Performance** (`test/thrash/benchmark.test.js`, runs as part of
  `npm test`): CPU/memory overhead of the detection code itself.
- **Data** (`bench/thrash-data-benchmark.js`, a standalone script — its
  own header docblock documents every `--flag`, including `--sweep`):
  how often a *configured* mix of healthy/broken tool calls results in a
  detected loop, and what it would cost. Two runs are committed under
  `bench/results/` as a reproducibility reference —
  [`published-seed-42.json`](bench/results/published-seed-42.json)
  / [`.txt`](bench/results/published-seed-42.txt) (a single run) and
  [`published-sweep-seed-42.json`](bench/results/published-sweep-seed-42.json)
  / [`.md`](bench/results/published-sweep-seed-42.md) (a sweep across
  `brokenToolRate` values 0.02–0.25).

  **Read the sweep table as a model you parameterize with your own
  observed failure rate, not as a measurement of real-world deployments.**
  `brokenToolRate` is an input the table's reader supplies — every row is
  a configured assumption, not something measured from production
  traffic. There is no single headline percentage here to quote as "how
  often agents thrash" — the whole point of the sweep is that the answer
  depends entirely on your own failure rate, which this benchmark cannot
  know. Both committed files carry a full methodology block (how sessions
  were isolated, that retries are scripted rather than driven by a real
  LLM agent loop, the exact retry/token-growth assumptions, the model and
  price used, and every known limitation that could inflate the numbers)
  and an exact `node bench/thrash-data-benchmark.js ...` command to
  reproduce them byte-for-byte.

## Tool schema drift detection (v0.8.0+)

Watches every `tools/list` response and flags when a tool's `inputSchema`
changes between two observations — a parameter renamed, a type tightened,
a `required` field added. A server that silently redefines a tool between
deployments currently breaks agents with no signal pointing at the actual
cause: the resulting `protocol.input` validation failures (see "Agent
Thrash Detection" above) look identical to an agent simply sending bad
arguments. This feature exists to connect those failures back to "the
schema itself changed under you." Full investigation and design: ADR 010
(`docs/adr/010-schema-drift.md`).

### Zero-config quick-start

```js
import { instrumentMcpServer } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
});
```

That's it — `schemaDrift` defaults to enabled, same as `fingerprinting`,
`costTracking`, and `thrashDetection`. **Read "Behavior change on upgrade"
below before relying on that default**, though — unlike those other
features, this one can change whether `instrumentMcpServer()` throws.

### What gets captured, and what counts as drift

Only `inputSchema` is captured and hashed — never `description` or any
other tool-definition field. `description` is deliberately a separate,
not-yet-built dimension (see ADR 010's "What 'drift' means"): a tool's
description is what the calling model actually reads to decide how to
invoke it, and a silently-changed description with an unchanged schema is
exactly the vector "MCP tool poisoning" / "rug-pull" attacks rely on — but
folding it into the same signal as a structural schema change would drown
the rare, high-signal case (a renamed parameter) in the comparatively
frequent, low-stakes noise of routine description wording edits. Tracking
description drift is out of scope for this release.

Drift is classified into one of six kinds, by structurally diffing the
new schema's `properties`/`required` against the last-observed schema for
that tool — not just comparing hashes:

| `mcp.tool.schema_drift.type` | What changed |
|---|---|
| `field_added` | A property present in the new schema, absent from the old one |
| `field_removed` | The inverse |
| `type_changed` | A property present in both, but its value differs (type, `enum`, nested shape, ...) |
| `required_changed` | The `required` set (compared as a set, not an ordered list) gained or lost an entry, independent of any property appearing/disappearing |
| `multiple` | More than one of the above changed in the same observation — reported as `multiple` rather than arbitrarily picking one |
| `unknown` | The hash changed, but the diff can't confidently characterize what — see below |

**`unknown` is not a rare edge case — it has two concrete, real triggers,
both confirmed by test:**

- A change to a **top-level composition keyword** (`oneOf`/`anyOf`/`allOf`,
  or the whole `inputSchema` being a `$ref`) — there's no `properties` key
  at that level for the differ to walk, so it can't attribute the change
  to a field. This is still reported as drift (the hash changed, so
  something did), just without a specific field name.
- A change to a **`$defs` entry reached only via `$ref`** from inside a
  normal, `properties`-based schema, where the referencing property's own
  `$ref` string is unchanged. The hash correctly changes (it hashes the
  whole canonicalized schema, `$defs` included), but the differ only ever
  compares each property's own value — it never inspects `$defs` — so it
  can't name the field. If your schemas use shared `$defs` definitions
  (common for Zod schemas with reused sub-shapes), expect this.

A composition keyword or `$ref` **nested inside** a property's own schema
value (e.g. `properties.kind = { anyOf: [...] }`) is not affected by
either limitation above — a change there is correctly attributed to that
field as `type_changed`, since the whole property value is compared by
deep equality regardless of what's inside it.

### Cold start, and the remove-then-reappear case

**The first time a tool is observed, it is never reported as drift** —
there's nothing to compare against yet. This is the same "no prior state,
no guessed answer" discipline `ThrashDetector` and `computeFingerprint()`
already follow elsewhere in this package.

**A tool that stops appearing in `tools/list` responses for a while and
later reappears is diffed against its last-observed schema — it is
NOT treated as a fresh cold start.** This is easy to get backwards:
intuitively, "the tool went away" might feel like it should reset
tracking, the way a session ending resets thrash detection. It doesn't,
and shouldn't — the stored snapshot for that tool simply isn't touched
while it's absent (nothing calls `capture()` for a tool that isn't in the
response), so when it comes back, comparison picks up exactly where it
left off:

- Reappears with an **unchanged** schema → no drift, correctly, even
  though there was a gap.
- Reappears with a **changed** schema → ordinary drift, classified
  against whatever was last seen — which may be several `tools/list`
  calls in the past, not necessarily the *immediately* preceding one.

The one way this resets is the LRU cap (`maxTrackedTools`, below) evicting
the entry in the meantime — an evicted tool is genuinely indistinguishable
from one never seen before, so it correctly (if unavoidably) cold-starts
again.

### Scope: per server instance, never per session

Schema drift state is scoped to **the instrumented server instance**, not
to any individual client session — deliberately the opposite of Agent
Thrash Detection's session-keyed design. Every client session connected to
one server sees the exact same tool registry; keying by session here would
produce a false "first observation" for every new session (nothing wrong,
just never seen by *that* session's key) and could silently swallow real
drift that happened between two sessions (the new session's own cold
start would just be the post-drift schema, with nothing to compare
against). See ADR 010, Q4, for the full reasoning.

**The honest limitation this implies**: this only works when the host
keeps one long-lived instrumented `Server`/`McpServer` instance alive
across the sessions it serves — the stdio case (one process, one
connection, for the process's whole lifetime) and the common HTTP pattern
this package's own thrash-detection session resolution already assumes
(one instrumented instance, many sessions). A host that instead
constructs a *fresh* `Server`/`McpServer` per HTTP session (stateless
mode) gets no cross-session drift detection at all, silently, by
construction. **This is not unique to schema drift** — see "In-memory
tracker state is scoped to one instrumentMcpServer() call" below, which
supersedes the framing above: the same construction pattern affects three
other features too, and ADR 012 tracks a proposed fix.

### Span volume: expect one span per `tools/list` call, not per drift

**Every `tools/list` call gets its own span, whether or not anything
drifted** — the same "always create the span, only sometimes it's
interesting" shape `tools/call` already has, but with a materially
different traffic pattern. A `tools/call` span is naturally bounded by how
often an agent actually invokes tools; a `tools/list` span is bounded only
by how often the *client* re-fetches the tool list, which is entirely
client-controlled and not something this library or the MCP spec limits.
Some MCP clients cache the tool list for a whole session; others re-fetch
it every turn. If a client calls `tools/list` 50 times in a session,
that's 50 `tools/list` spans, 49 of them (assuming nothing changed)
carrying no drift event at all — **this is correct, not a bug**, but it's
volume you may not have been expecting if you're used to span counts
tracking actual tool usage. If this matters for your trace volume/cost,
`schemaDrift: { enabled: false }` skips wrapping `tools/list` entirely —
no span, no capture, nothing (see "Configuration" below).

### Metrics

Same API-only pattern as every other metric in this README — nothing
recorded until a `MeterProvider` is registered.

| Metric | Type | Unit | Attributes | Emitted when |
|---|---|---|---|---|
| `mcp.tool.schema_drift.detected` | Counter | — | `gen_ai.tool.name`, `mcp.tool.schema_drift.type` | A previously-observed tool's `inputSchema` hash differs from its last-observed hash |

Both attributes are bounded (tool name by the server's own registry,
`type` a closed 6-value enum), following the same
`METRIC_SAFE_ATTRIBUTES` cardinality discipline as every other metric in
this package. No hash or field name ever reaches a metric label — see the
span event below for those.

### Span event: `mcp.tool.schema_drift.detected`

Added to the **currently active span** (never a new one — the same
`trace.getActiveSpan()` pattern the `mcp.loop.detected` event above uses)
each time the metric above fires. In the normal, wired-up path, the
active span at that point is the `tools/list` span this feature creates
(see "Span volume" above) — but this emitter has no dependency on that;
if schema capture ever runs with no active span, the event is skipped
silently and only the metric still fires.

| Attribute | Description |
|---|---|
| `mcp.tool.schema_drift.type` | Same six-value kind as the metric above |
| `mcp.tool.schema_drift.previous_hash` | The stored hash this observation differs from |
| `mcp.tool.schema_drift.current_hash` | This observation's hash |
| `mcp.tool.schema_drift.added_fields` | Property names added — present only when `type` is `field_added` or `multiple` (never set to an empty array) |
| `mcp.tool.schema_drift.removed_fields` | Property names removed — present only when `type` is `field_removed` or `multiple` |
| `mcp.tool.schema_drift.changed_fields` | Property names whose value changed — present only when `type` is `type_changed` or `multiple` |

**Also sets a boolean span *attribute*, `mcp.tool.schema_drift_detected: true`**,
on that same span, alongside the event above (v0.12.0, ADR 011 —
`docs/adr/011-cost-aware-sampling.md`, the same resolution already applied
to `mcp.tool.thrash_detected` above, for the identical reason). This
exists for one specific consumer: an OpenTelemetry Collector's
`tailsamplingprocessor`, whose `boolean_attribute` policy matches
top-level span attributes — whether such a policy can also match
span-*event* data was investigated and left genuinely unverified (no Go
source to check against in this repository), so the attribute exists to
remove that uncertainty entirely for anyone wiring up schema-drift-aware
tail sampling. See "Cost-aware trace sampling (a Collector recipe, not a
library feature)" below. Deliberately a different string from the
`mcp.tool.schema_drift.detected` span event/metric name above, for the
same reason `mcp.tool.thrash_detected` doesn't reuse `mcp.tool.loop.detected`'s
string: the one reader who most needs this name to be unambiguous —
someone writing a Collector tail-sampling policy — would otherwise see one
bare string with no way to tell which of the two same-named signals
they're keying on.

### Configuration

All fields of `schemaDrift`, each independently overridable by its own
`OTEL_MCP_SCHEMA_DRIFT_*` env var, following the exact `OTEL_MCP_THRASH_*`
pattern — precedence is explicit option field, then env var, then
default; an invalid/unparseable env value falls back to the default
silently, never throws. Source of truth: `src/schema-drift/config.js`.

| Option | Env var | Type | Default | Description |
|---|---|---|---|---|
| `enabled` | `OTEL_MCP_SCHEMA_DRIFT_ENABLED` | boolean | `true` | `false` is a true no-op: `tools/list` is not wrapped at all (no span, no capture, no detector/emitter construction) — unlike `thrashDetection`/`costTracking`, whose disabled state still wraps `tools/call` for other reasons |
| `maxTrackedTools` | `OTEL_MCP_SCHEMA_DRIFT_MAX_TRACKED_TOOLS` | number | `1000` | LRU cap on distinct tracked tools (`src/schema-drift/store.js`) — defense-in-depth, not a response to an expected failure mode; a server's own tool count is normally small and bounded already |

### Behavior change on upgrade — read this before updating

**`instrumentMcpServer()`'s existing instrument-first requirement now
also covers `tools/list`, for low-level `Server` users specifically,
because `schemaDrift.enabled` defaults to `true`.** This library has
always required being called before any `tools/call` handler is
registered; as of this release, with schema drift enabled (the default),
it also requires being called before any `tools/list` handler is
registered.

If your low-level `Server` code calls
`server.setRequestHandler(ListToolsRequestSchema, ...)` before calling
`instrumentMcpServer()` — never previously an error, since this library
was blind to `tools/list` entirely before this release — upgrading will
make that throw `INSTRUMENT_FIRST_ERROR` where it didn't before, with no
other code changes on your part.

**`McpServer` users are unaffected.** `McpServer` registers `tools/list`
and `tools/call` together, atomically, the first time `.tool()` or
`.registerTool()` is called — so anyone already following the documented
instrument-before-registration rule for `tools/call` automatically
satisfies it for `tools/list` too.

**Migration**: either reorder your `tools/list` registration to after
`instrumentMcpServer()`, or pass `schemaDrift: { enabled: false }` to
keep your existing registration order — both fully restore v0.7.0
behavior. See the CHANGELOG's v0.8.0 entry for the same note.

### Known limitations

- **`unknown` classification for `$ref`/`$defs`-indirected changes and
  top-level composition keywords** — see "What gets captured" above. Not
  a bug, but worth knowing if your schemas lean on shared `$defs`
  definitions or top-level `oneOf`/`anyOf`/`allOf`: you'll see drift
  detected (the hash changes correctly) without a field name attached.
- **Per-server-instance scope assumes a long-lived instrumented instance**
  — see "Scope" above and "In-memory tracker state is scoped to one
  instrumentMcpServer() call" below. Stateless-per-session HTTP
  deployments get no cross-session drift detection, silently, by
  construction — not unique to this feature; ADR 012 tracks a proposed fix
  covering all four affected trackers.
- **`tools/list` call frequency, and therefore span/capture-and-hash
  cost, is entirely client-controlled** — unlike `tools/call`, which is
  naturally rate-limited by actual agent tool usage. See "Span volume"
  above.
- **Description drift is not detected** — see "What gets captured" above.
  Tracked as a follow-up, not built in this release.

## Two-axis observation contract (v0.8.0+)

Answers a different question than every other feature in this README:
not "did a tool call fail," but "can this library's own signal about that
be trusted right now." Prompted by external review (Massimiliano
Brighindi), who first raised that `instrumentMcpServer()` with no
`TracerProvider`/`MeterProvider` registered silently no-ops — a tool call
that fails in that state produces exactly zero telemetry, indistinguishable
from a tool that never failed at all — and then, on a follow-up
investigation, supplied the reframe that shaped what actually shipped:
the goal was never to *detect* a broken pipeline, it's to *stop implying
health by omission*. Full investigation and design: ADR 008
(`docs/adr/008-observation-liveness.md`, see the "Update (2026-08-05)"
section — it supersedes the original four-state contract earlier in that
document).

### Zero-config quick-start

```js
import { instrumentMcpServer } from 'opentel-mcp';

const server = instrumentMcpServer(new Server(...), {
  serviceName: 'my-mcp-server',
});

// ...later, e.g. in a health-check handler:
console.log(server.getObservationState());
// {
//   toolOutcome: { success: 41, failure: 3, unknown: 0 },
//   observationIntegrity: 'DEGRADED',
// }
```

No configuration, no opt-in — `getObservationState()` is attached
unconditionally whenever instrumentation itself is enabled, the same way
`getThrashSummary()` is. No OTel involved in computing either field;
nothing sent anywhere; safe to call from application code.

### The two axes, and why they're separate

- **`toolOutcome`** — `{ success, failure, unknown }`, cumulative counts
  since this server was instrumented. Backed by a counter that increments
  on **every** tool call, unconditionally — independent of
  `fingerprinting`, `thrashDetection`, and `enableMetrics`. This is
  deliberate, not an oversight: `getThrashSummary()` already returns an
  all-zero summary when `thrashDetection` is disabled, and reading
  `toolOutcome` off that same bookkeeping would silently report "no
  failures" whenever fingerprinting is off (a fully supported,
  documented configuration) — the exact silent-success failure mode this
  whole feature exists to close, just relocated into the "fix." This
  counter has no dependency on any of those flags at all.
- **`observationIntegrity`** — `'DEGRADED' | 'UNKNOWN'`. Answers "is
  there positive evidence this library's own telemetry pipeline is
  broken," independently of whether any tool call has ever failed.

These are independent on purpose: a healthy-looking `toolOutcome` next to
`observationIntegrity: 'DEGRADED'` means "nothing has failed *that we
could tell you about* — but we can't currently vouch for whether that's
because nothing failed, or because failures aren't reaching anywhere."
Collapsing them into one field would force exactly the conflation this
feature exists to prevent.

### Why `toolOutcome` deliberately duplicates span status — read this before filing it as redundant

`span.setStatus({ code: SpanStatusCode.OK / ERROR })` and the metric-only
`mcp.tool.outcome` attribute already carry this same success/failure
information today. A reviewer's first instinct on seeing `toolOutcome`
will likely be "isn't this the same signal already on the span, just
copied?" — **yes, and that's the entire point, not a flaw.** A signal
that travels the same channel as the thing you're using it to question is
worthless for that purpose: asking "is the span/metric pipeline
trustworthy?" by reading a value that only exists *if* the span/metric
pipeline is working is circular — it can never say anything when the
pipeline is the thing in doubt. `toolOutcome` has to be computed and
stored somewhere that doesn't depend on OTel at all, specifically so it
still means something in the one situation where the OTel-based signal
might not: this is the same "you can't ask a span whether spans are
working" principle ADR 008's original investigation already established
for provider-liveness detection, now applied to outcome-tracking too.

### Why `HEALTHY` does not exist

The obvious design would be a three-state `observationIntegrity`:
`HEALTHY | DEGRADED | UNKNOWN`. It isn't that, and not by omission —
`HEALTHY` was investigated and found to be **structurally unreachable in
every configuration this library runs in.** The one real lead — OTel's
SDK self-observability metrics (`otel.sdk.processor.span.processed`) —
is a write-only `Counter`: the `@opentelemetry/api` Metrics API gives it
exactly one method, `add()`, with no way for the code that created it to
read its own current value back. That metric is real and useful to an
*external* system (a Collector, a Prometheus scrape) — it can never
become something this library's own synchronous accessor reads and turns
into a verdict, no matter how it's wired up. Applying this project's own
"a three-value enum where one value is unreachable should be a two-value
enum" standard (see "Tool schema drift detection" above for the same
discipline applied to `SchemaDriftKind`), `HEALTHY` is dropped from the
type entirely — not just never returned, structurally absent, so a
future implementation can't silently add it back without revisiting why
it was removed. TypeScript enforces this directly:
`'HEALTHY'` is not assignable to `ObservationIntegrity` at all — see the
type-level tests in `test/index.exports.test-d.ts`.

### `UNKNOWN` is an honest disclaimer, not a detected state

`UNKNOWN` is `observationIntegrity`'s default, and — for most
deployments, most of the time — its only ever-observed value. It does
not mean "we checked and found something specific"; it means "we have no
positive evidence either way." Both axes default to it and only move off
it on positive evidence, never a guess:

- `toolOutcome` starts at `{ success: 0, failure: 0, unknown: 0 }` and
  only increments a bucket when a call's outcome is confidently
  classified — a malformed, unrecognizable result (not a real
  `CallToolResult` shape at all) increments `unknown` rather than
  silently defaulting to `success`.
- `observationIntegrity` stays `UNKNOWN` unless the absence-detection
  mechanism below *confidently* resolves to "no delegate registered."
  Anything it can't confirm — including the mechanism itself throwing, or
  the SDK's shape looking unexpected — degrades to `UNKNOWN`, never a
  guessed `DEGRADED`.

### When `DEGRADED` is reachable, and when it never is

`DEGRADED` is detected via a fragile reference-equality trick against
`@opentelemetry/api`'s `ProxyTracerProvider`: a throwaway
`new ProxyTracerProvider().getDelegate()` and the real, globally
registered provider's own `getDelegate()` resolve to the same
module-scoped no-op singleton whenever nothing has ever been registered
— confirming absence, not merely failing to confirm presence.

- **`setupNodeSdk: false` (the default, host-owned provider):** this
  check runs, and `DEGRADED` is genuinely reachable — it fires whenever
  no `TracerProvider` has been registered globally at all.
- **`setupNodeSdk: true` (opentel-mcp owns the provider):** `instrumentMcpServer()`
  registers a delegate itself. It **always** returns `UNKNOWN` here,
  without even attempting the check — there is nothing left to detect;
  a delegate is known-present with certainty, not by inference. This is
  the one configuration where `DEGRADED` can never fire, full stop.

**This check is fragile on two independent axes**, both already true of
the installed `@opentelemetry/api`: it depends on `ProxyTracerProvider`,
a class its own maintainers have marked for removal in a future major
version, and its comparison singleton isn't registered via the
`globalThis`-keyed mechanism this same API otherwise uses to survive
multiple installed copies of itself — the same class of dual-package-hazard
bug this project already guards against elsewhere (`detectServerKind()`,
ADR 001). Both fragilities degrade to `UNKNOWN`, never a thrown error and
never a wrong confident `DEGRADED`, if the check itself throws or the
SDK's shape ever looks different than expected.

### `observationIntegrity` is computed per call, not cached

Every call to `getObservationState()` re-runs the absence-check fresh
against whatever `TracerProvider` is registered globally *at that
moment* — it is never computed once at `instrumentMcpServer()` time and
reused. If your host registers its OTel SDK asynchronously, after
`instrumentMcpServer()` already ran (a normal, common startup order), a
value cached at instrument time would report `DEGRADED` forever even
after a provider shows up — the very first health check after that
registration reflects it correctly, with no restart needed. The check
itself is cheap (an object construction and a reference comparison), so
there's no performance reason to cache it either.

### Known limitations

**`toolOutcome` is scoped to one `instrumentMcpServer()` call, not the
whole process** — see "In-memory tracker state is scoped to one
instrumentMcpServer() call" below. Under a fresh-`Server`-per-request
deployment, `toolOutcome` resets to all-zero every request instead of
accumulating, contrary to what an earlier version of this feature's own
source docblock claimed. Confirmed gap, ADR 012.

## Cost-aware trace sampling (a Collector recipe, not a library feature)

The ask that keeps coming up: keep traces that were expensive or that
thrashed, *regardless of what the head sampler decided* — don't sample
away the one call that burned $2 and 40 retries just because it lost a
1-in-10 coin flip at span start. This package does not, and will not,
implement that itself. Full investigation and reasoning: ADR 011
(`docs/adr/011-cost-aware-sampling.md`).

**Why this can't be a library feature — read this before filing an issue
asking why `instrumentMcpServer()` doesn't just do it:** OpenTelemetry's
`Sampler` decides whether to keep a span at span **start**
(`Tracer.startSpan()`, before the span object even exists) — cost
(`mcp.tool.cost.usd`) and thrash (`mcp.tool.thrash_detected`) are only known
at span **end**, after the tool handler has actually run. A head-based
sampler cannot see either signal, because the entire concept of "turns
out to be expensive" happens after the sampling decision already ran and
already produced an immutable result — this isn't a missing feature, it's
what "head sampling" means. Investigated further (ADR 011, Q2): even
setting that timing problem aside, this library doesn't own the
`Sampler` or the `SpanProcessor` chain in its default (and recommended)
configuration — both belong to whatever `TracerProvider` the host
application already registered, with no public API to inject either
after construction. Building this in-process would mean asking every host
application to change how *they* construct their own OTel SDK — a
fundamentally bigger, more invasive ask than `instrumentMcpServer(server,
options)`, and exactly the class of intervention this project has already
ruled out elsewhere (never override a host's own OpenTelemetry setup).

**What this package does instead: mark, don't decide.** Four of the five
signals a tail-sampling policy needs already exist as plain span
attributes with no changes required — `mcp.tool.cost.usd` and
`mcp.tool.pricing_status` (see "Cost & Token Attribution" above),
`mcp.tool.cost.budget_exceeded` (a cumulative budget guardrail, same
section), and `mcp.tool.thrash_detected` — a boolean span attribute set
alongside the existing `mcp.loop.detected` span event (see "Agent Thrash
Detection" → "Span event" above). The fifth, `mcp.tool.schema_drift_detected`
— a boolean span attribute set alongside the existing
`mcp.tool.schema_drift.detected` span event (see "Tool schema drift
detection" → "Span event" above) — is the one new addition this release
makes, for the identical reason `mcp.tool.thrash_detected` was added in
the first place: a tail-sampling policy needs an unambiguous,
attribute-level signal to key on, and a span *event* isn't confirmed
matchable the same way (see below). The actual decision — buffer a trace,
evaluate a policy, keep or drop the whole thing — belongs to the
OpenTelemetry Collector's `tailsamplingprocessor`, which already does this
correctly, already handles the hard parts (per-trace span buffering
across a wait window, multi-service traces, decision policies), and runs
where it can see every span in a trace regardless of which process
produced it — something this library, running inside one MCP server
process, never can.

### A working Collector config

The full, pasteable `tailsamplingprocessor` config lives in
[`docs/recipes/tail-sampling.yaml`](../../docs/recipes/tail-sampling.yaml)
— not duplicated here, so there's exactly one copy to keep in sync with
this package's actual attribute names. (Standard OpenTelemetry Collector
Contrib syntax — external to this repository, so treat field names as
that component's own documented contract, not something confirmed against
code living here.)

It keeps any trace containing:

| Policy | Type | Keys on | Why |
|---|---|---|---|
| `expensive-tool-calls` | `numeric_attribute` | `mcp.tool.cost.usd` ≥ `0.10` | A single call cost more than your threshold |
| `budget-exceeded-calls` | `boolean_attribute` | `mcp.tool.cost.budget_exceeded` = `true` | A configured cumulative budget was crossed |
| `thrash-loops` | `boolean_attribute` | `mcp.tool.thrash_detected` = `true` | An agent thrash loop was detected |
| `schema-drift-events` | `boolean_attribute` | `mcp.tool.schema_drift_detected` = `true` | A tool's `inputSchema` changed between two `tools/list` calls |
| `unpriced-calls` | `string_attribute` | `mcp.tool.pricing_status` = `"unknown"` | See below — a real, unpriced cost, not a cheap one |

— everything else gets an ordinary 10% probabilistic sample (policies are
OR'd together, so this doesn't reduce anything the policies above already
kept; it only adds baseline visibility into what none of them matched).

Point `instrumentMcpServer({ exporterUrl: 'http://localhost:4318/v1/traces' })`
(or your host's own OTLP exporter configuration) at this Collector's
`otlp` receiver, and it sits in front of your real trace backend, applying
this policy before anything is exported downstream.

**Adjust `min_value`/`sampling_percentage` to your own cost/volume
profile** — `0.10` and `10%` in the recipe are illustrative starting
points, not recommendations; `decision_wait`/`num_traces` should scale
with your actual traffic volume (the Collector's own docs cover sizing
these).

**Why `unpriced-calls` is in here — the v0.11.0 "confidently wrong zero"
problem, one layer up.** `mcp.tool.pricing_status` (ADR 016 point 4, "Cost
& Token Attribution" → "Span attributes" above) exists because an
unrecognized model must not be silently reported as costing nothing — it
gets `"unknown"`, distinct from a genuinely free/untracked call. But a
call with `mcp.tool.pricing_status: "unknown"` has real extracted token
usage and *no* `mcp.tool.cost.usd` at all (unpriced calls never reach
`mcp.tool.cost.usd`, by construction — see "Cost & Token Attribution"
above). To the `expensive-tool-calls` policy above, an attribute that
was never set is indistinguishable from a cost of exactly `0` — the same
"confidently wrong" failure the pricing-provenance work fixed at the
attribute level, reappearing here because a numeric-threshold policy has
no way to see the difference between "cheap" and "unknown." The
`unpriced-calls` policy closes that gap the same way `mcp.tool.pricing_status`
closes it at the attribute level: an explicit signal instead of an
inferred absence. (Cost tracking's other kind of absence — a plain-text
result with no recognizable token usage at all — has no attribute of any
kind, `mcp.tool.pricing_status` included, and is not what this policy is
for: that call genuinely has no cost signal, which is expected, not a
gap.)

**What's verified here, and what isn't — read this before trusting this
recipe blindly.** Every `mcp.tool.*` key in
[`tail-sampling.yaml`](../../docs/recipes/tail-sampling.yaml) is
cross-checked by
[`test/recipes/tail-sampling-attributes.test.js`](test/recipes/tail-sampling-attributes.test.js)
against this package's real, exported attribute constants — and,
specifically, against which of them are actually passed to
`span.setAttribute()` in `src/`, not merely a span-event or metric name
that happens to look like an attribute. That test is what would have
caught this recipe's own predecessor bug: an earlier version of this
section recommended the schema-drift span *event* name as a
`boolean_attribute` policy target, which could never have matched
anything. **What is not verified: the actual behavior of this config
against a real Collector.** `tailsamplingprocessor` is Contrib-only Go
source with no npm package and nothing installed in this repository, and
no Docker daemon was reachable in the environment this recipe was last
revised in — unlike the Grafana dashboard (`dashboards/README.md`, "Generating
sample data / verifying locally"), which was verified end to end against
a real Prometheus + Grafana stack before shipping, this recipe has not
had the equivalent live-Collector run. Treat the attribute names as
trustworthy and the policy semantics as sourced from public OpenTelemetry
Collector Contrib documentation, not as something this project has
independently confirmed by running it.

## Trace Context Propagation (v0.11.0+)

The most-complained-about gap in agent observability: an agent framework
(LangGraph or otherwise) calls a tool on your MCP server, and you get two
disconnected traces — the agent's own trace dies at the tool boundary,
and the server's trace for what the tool actually did starts fresh, with
no edge between them. Debugging a slow or failing agent run means
manually correlating timestamps across two separate traces (or two
separate services in the same backend) instead of looking at one.

opentel-mcp closes the server-side half of this: when a `tools/call`
request carries a valid [W3C `traceparent`](https://www.w3.org/TR/trace-context/)
in `params._meta`, the tool-call span becomes a **child of the calling
agent's own span** — the same trace, not two. `tracestate` is propagated
too, when present.

### Zero-config — nothing to opt into

There's no `traceContext: { enabled: false }` option, deliberately: this
is unconditional, because there's nothing for an operator to want to turn
off. Any client that already emits `traceparent` via a standard OTel
SDK's `propagation.inject()` — in any language, this isn't Node-specific
on the client side — gets linked traces the moment it copies that string
into `_meta.traceparent` on its outgoing `tools/call` request:

```json
{
  "method": "tools/call",
  "params": {
    "name": "search_docs",
    "arguments": { "query": "..." },
    "_meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "tracestate": "vendorname=opaquevalue"
    }
  }
}
```

A client that doesn't set `_meta.traceparent` (today's overwhelming
majority, until client-side shims exist — see "What's not built yet"
below) sees **zero change of any kind** — confirmed byte-identical to
pre-v0.11.0 behavior, not merely "should behave the same."

### The upstream sampling decision is honored automatically

If the calling agent's own trace wasn't sampled (the `traceparent`'s
flags byte has the sampled bit unset), this tool-call span isn't recorded
or exported either — matching the agent's own choice, via the OTel SDK's
own default `ParentBasedSampler`, which already inspects a remote
parent's `traceFlags` for exactly this. opentel-mcp writes no sampling
logic of its own for this — see ADR 017's "Sampling" section
(`docs/adr/017-trace-context-propagation.md`) for why forcing sampling
regardless was considered and rejected.

### Conflicting or pre-existing context

If your transport's own auto-instrumentation (e.g.
`@opentelemetry/instrumentation-http` on a Streamable HTTP server) has
already put some other span active by the time this package's handler
runs, a valid `_meta.traceparent` **replaces it outright** — it is never
merged. The `_meta`-carried context is message-scoped (this one logical
agent operation); the transport-level span is connection/request-scoped
and isn't the right parent for it. Full reasoning: ADR 017's
"Conflicting `_meta.traceparent`" section.

### What's not built yet

**Server-side extraction only.** There is no client-side shim in this
package (yet) for a Node or Python agent framework to *set*
`_meta.traceparent` on its own outgoing calls — you need a client that
already does this itself (or does it via your own glue code:
`propagation.inject(context.active(), meta, ...)` from your OTel SDK,
writing into `_meta` before the call). Extraction is independently
useful today, for free, to any client that already sets `_meta` in this
shape; the client-side half is tracked as future work, not implied as
solved by this release.

## What this library records — read this before routing spans anywhere sensitive data isn't already allowed

This is a description of what happens today, not a claim about a specific
threat model this library has verified it covers.

opentel-mcp forwards what your tools and their thrown exceptions actually
produce. It does not invent, infer, or independently verify tool-result
content — if a tool's handler throws `new Error('user ' + email + ' not
found')`, or a tool result puts a credential in a field this library
reads, that content is exactly what reaches your telemetry backend. Three
channels carry it:

- **`span.recordException(err)` / `span.setStatus({ message })`** on every
  thrown `tools/call`/`tools/list` error — `exception.message` and
  `exception.stacktrace` are set from `err.message`/`err.stack` verbatim
  by default. `errorRecording.mode` controls this; see "Error recording"
  above.
- **`mcp.tool.model` / `gen_ai.response.model`** — a tool result's own
  declared model field, admitted once it passes a length/character-shape
  check (v0.13.0). The check bounds shape, not content: a well-formed but
  still arbitrary string from a tool result reaches the span. See "Cost &
  Token Attribution" → "Model identifier validation" above.
- **`mcp.failure.error_class`** (length-capped at 128 characters, not
  pattern-scrubbed) and **`mcp.failure.validation_paths`** (a schema's
  dynamic/record keys replaced with the placeholder `<KEY>`) — both
  already hardened; see `docs/known-gaps.md` entry 10.

**This isn't unique to opentel-mcp.** OpenTelemetry's own semantic
conventions mark `exception.message` as an attribute that "may contain
sensitive information" and still specify recording it by default —
every other OTel-instrumented library sharing the same trace (an HTTP
client, a DB driver, a queue consumer) records `err.message`/`err.stack`
the same way, unscrubbed, through the same `recordException()` call.
opentel-mcp matches that ecosystem default rather than silently diverging
from it. What it adds on top: `errorRecording.mode` lets you choose
`'normalized'` (targeted scrubbing — the same structured patterns
fingerprinting matches: UUIDs, emails, URLs, IPs, timestamps, paths,
quoted ids; **not** a general-purpose PII filter, so freeform sensitive
text — a customer's name in prose, an API key in a format none of those
patterns match — still reaches the span unchanged, see "Error recording"
above) or `'none'` (record neither) instead of `'full'` — a level of
operator control most peer instrumentations don't offer for this path.
Full reasoning, including why the default doesn't change in this
release: ADR 019 (`docs/adr/019-raw-content-on-spans.md`).

This is a data-handling property of an observability library, not a
security control opentel-mcp is claiming to provide — it doesn't
authenticate, encrypt, or restrict who can read your traces; that's your
tracing backend's job.

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
| `costTracking` | object | see below | Controls cost/token attribution[^9] — see "Cost & Token Attribution" above |
| `thrashDetection` | object | see below | Controls Agent Thrash Detection[^10] — see "Agent Thrash Detection" above. Requires `fingerprinting: true` |
| `schemaDrift` | object | see below | Controls tool schema drift detection[^11] — see "Tool schema drift detection" above. `enabled: true` by default changes `instrumentMcpServer()`'s throw behavior on upgrade — see that section's "Behavior change on upgrade" |
| `errorRecording` | object | see below | Controls what raw exception content reaches `recordException()`/`setStatus()`[^12] — see "Error recording" above |

[^10]: `{ enabled?, threshold?, windowMs?, maxTrackedKeys?, entryTtlMs?, reEmitAfter?, assumeSingleSession? }`, all fields optional, individually defaulted, and individually overridable via an `OTEL_MCP_THRASH_*` env var — see "Agent Thrash Detection" → "Configuration" above for the full table.
[^11]: `{ enabled?, maxTrackedTools? }`, all fields optional, individually defaulted, and individually overridable via an `OTEL_MCP_SCHEMA_DRIFT_*` env var — see "Tool schema drift detection" → "Configuration" above for the full table.
[^12]: `{ mode?: 'full' | 'normalized' | 'none' }`, defaulted to `'full'`, individually overridable via `OTEL_MCP_ERROR_RECORDING_MODE` — see "Error recording" → "Configuration" above for the full table.

[^9]: `{ enabled?: boolean; pricingTable?: PricingTable; extractor?: UsageExtractor; budget?: { perSessionUsd?: number; perToolUsd?: number } }`, all fields optional and individually defaulted — `{ enabled: true, pricingTable: DEFAULT_PRICING, extractor: defaultExtractor }` with budget tracking off.
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

**Since v0.8.0, this also applies to `tools/list`** — i.e. before
`server.setRequestHandler(ListToolsRequestSchema, ...)` — whenever
`schemaDrift.enabled` is `true` (the default). `McpServer` users are
unaffected, since it registers both together atomically; low-level
`Server` users who register `tools/list` independently should read "Tool
schema drift detection" → "Behavior change on upgrade" above before
upgrading from a pre-v0.8.0 version.

## In-memory tracker state is scoped to one instrumentMcpServer() call

Four features in this README keep their own in-memory state across tool
calls: Agent Thrash Detection's consecutive-failure tracking, Cost & Token
Attribution's budget totals, Tool schema drift detection's per-tool schema
history, and the Two-axis observation contract's `toolOutcome` counts.
**All four live inside the object `instrumentMcpServer()` constructs for
one call — they do not survive past it, and nothing shares state between
two separate calls, unless you set `instanceKey` (v0.9.0+ — see the
section immediately below).**

This is invisible, and correct, for the deployment shape every one of
these features was designed against: one `Server`/`McpServer` instance,
instrumented once, kept alive for the life of the process — stdio's single
persistent connection, or an HTTP server that keeps one instrumented
instance around across many sessions. It becomes a real problem under a
different, also-common shape: **"stateless" Streamable HTTP, where a fresh
`Server` is constructed — and re-instrumented — on every incoming POST.**
Under that topology, every one of these four trackers is discarded and
rebuilt from empty before it ever sees a second data point, unless
`instanceKey` is set — and, for Agent Thrash Detection specifically, a
real session id is also available on every call. MCP spec 2025-11-25 and
earlier transports give you this automatically; **`@modelcontextprotocol/server`
(v2, protocol revision 2026-07-28) still has a real, optional `sessionId`
field on every call — it isn't removed — but its default,
`createMcpHandler`-driven stateless deployment shape usually doesn't
populate it, the same "no session id" shape stdio has always had for v1**
— see "MCP spec 2026-07-28..." below for exactly what this does and
doesn't mean. Without both a shared tracker and a real session id on every
call, nothing accumulates, nothing crosses a threshold, and nothing warns
that this is happening — the affected feature is silently inert.

**Confirmed, not a hypothetical, and now has a partial fix.** Reproduced
directly in `test/integration/thrash-stateless-http-lifecycle.test.js`:
without `instanceKey`, it still drives 5 identical tool failures across 5
separate `instrumentMcpServer()` calls and confirms `mcp.tool.loop.detected`
never fires, even past the default `threshold: 3` — that remains the
default, unchanged behavior when you don't opt in. With a shared
`instanceKey` *and* a real session id on every call, the same file's other
test confirms it now does. Full investigation, root cause across all four
trackers, and the `instanceKey` design: ADR 012
(`docs/adr/012-tracker-lifecycle-and-shared-state.md`). Tracked in
`docs/known-gaps.md`.

**If you instrument a fresh `Server`/`McpServer` per request — including
every `@modelcontextprotocol/server` (v2) deployment via `createMcpHandler`/
`serveStdio`, whose factory pattern makes this the default, not an edge
case — set `instanceKey`.** Read the section immediately below in full
before relying on it — it has one required companion for thrash detection
specifically (a real session id, not the generated fallback — under v2's
default stateless posture this companion usually isn't met, not because
it's structurally impossible but because nothing provides one; see "MCP
spec 2026-07-28..." below), and it does not help at all across multiple
processes or containers (Lambda, Cloud Run, or any horizontally-scaled
deployment). All three are easy to miss and produce the exact same
silent-inertness symptom as this section describes.

## instanceKey: sharing tracker state across instrumentMcpServer() calls (v0.9.0+)

`instanceKey` (a string option on `instrumentMcpServer()`, or the
`OTEL_MCP_INSTANCE_KEY` environment variable) lets repeated
`instrumentMcpServer()` calls that pass the same key share the four
trackers described above instead of each one resetting to empty. Full
design: ADR 012 (`docs/adr/012-tracker-lifecycle-and-shared-state.md`).

### When to set it

Set it when `instrumentMcpServer()` runs more than once per process for
what is logically **one** service — the case the previous section
describes: a fresh `Server`/`McpServer` constructed and re-instrumented on
every incoming request, on an otherwise long-lived process. "Stateless"
Streamable HTTP — a fresh `McpServer` per POST, the process itself kept
alive — is the common real example. Pick one stable string per logical
service and pass the same one on every call:

```js
instrumentMcpServer(server, { instanceKey: 'my-mcp-server' });
```

(`serviceName` deliberately omitted here — it only has an effect when
`setupNodeSdk: true`, see "Two modes" below; passing it without that logs
a one-time `diag.warn` and is unrelated to `instanceKey`, which is
orthogonal to how spans/metrics get exported.)

Omit it (the default) for the normal case — one `Server`/`McpServer`
instrumented once and kept alive for the process's life (stdio, or an
HTTP server that keeps one instrumented instance around across many
sessions). Behavior is byte-identical to every version before v0.9.0:
trackers are constructed fresh on every call, and the internal registry is
never looked up or written to.

### ⚠️ instanceKey alone does not fix thrash detection — read this before relying on it

> **`instanceKey` shares the tracker OBJECT. Agent Thrash Detection also
> needs a real, transport-provided session id on every call — without
> both, thrash detection stays silently inert even with `instanceKey`
> set.** This is the exact same silent-inertness shape as the original
> gap, now hiding behind what looks like a fix. It was found writing this
> feature's own regression test, not anticipated in the original design.

Why: `ThrashDetector` — the tracker `instanceKey` shares — looks up
episodes by `(sessionId, toolName, fingerprint)`, not just fingerprint
alone (see "Session id resolution" above). Without a real
`extra.sessionId`, `instrumentMcpServer()` generates its own random
per-connection fallback session id — and it does this **fresh, on every
single call**, regardless of `instanceKey`. Sharing the tracker instance
doesn't change that: five stateless-HTTP requests sharing one
`instanceKey` still each get recorded under a different, unrelated
fallback id, so the same shared `ThrashDetector` sees five separate
one-off episodes instead of one five-long loop. Nothing ever accumulates
past 1, and nothing warns you.

**Both of these are required together, not either/or:**

1. `instanceKey`, so the tracker itself is shared across calls, **and**
2. a real `extra.sessionId` on every call, so the lookup key inside that
   shared tracker is stable across calls too.

Real Streamable HTTP transports built against **MCP spec 2025-11-25 or
earlier** give you (2) automatically — the SDK threads a real client
session id through `extra.sessionId` on every request regardless of
whether the `Server` object handling it was just constructed, so the
common "stateless Streamable HTTP" case works with `instanceKey` alone,
no extra effort, **for every spec version through 2025-11-25**. That
version qualifier is load-bearing, not throat-clearing — see the
subsection immediately below. **You will NOT get (2) for free — and
thrash detection will stay silently inert despite `instanceKey` being set
— if:** you're using a custom `Transport` implementation that never
exposes a `sessionId`, you've set `assumeSingleSession: true` (which
exists specifically to opt into the generated fallback), anything else
lands on the fallback path described in "Session id resolution" above,
**or your transport is built against MCP spec 2026-07-28 or later — see
below, this is a different problem `instanceKey` cannot solve at all,
not a configuration gap.** If you're in one of the first three cases, you
need your own mechanism for threading a stable, real session identity
into each call — `instanceKey` cannot manufacture one for you, and there
is no configuration of it that will.

This composition requirement is specific to Agent Thrash Detection's
per-session lookup key. Schema drift detection and the `ToolOutcome`
counter have no session-id dependency at all — `instanceKey` alone is
sufficient for both. Budget tracking's `perToolUsd` scope is also
session-independent; its `perSessionUsd` scope inherits the identical
requirement, for the identical reason.

### MCP spec 2026-07-28 / `@modelcontextprotocol/server` (v2) — session identity and `instanceKey`

**Correcting an earlier version of this section:** MCP spec 2026-07-28
does NOT remove session identity from this library's reach entirely —
`@modelcontextprotocol/server` (v2)'s `ctx.sessionId` is still a real,
optional field this library reads (ADR 015 Finding 3).

[MCP spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
removes protocol-level sessions and the `Mcp-Session-Id` header from the
Streamable HTTP transport's WIRE format — not deprecated, removed — along
with the `initialize`/`notifications/initialized` handshake that used to
mint one. That's a real, confirmed spec fact. But it's a statement about
the wire protocol, not about the SDK's object model: v2's `ctx.sessionId`
(the direct equivalent of v1's `extra.sessionId`) is still there in the
type, and this library reads it the same way for both SDKs. The practical
effect is that `createMcpHandler`'s default, stateless deployment shape
usually just doesn't populate it — the same "no session id" shape stdio
has always had for v1, not a new, structurally-impossible-to-meet
requirement. A v2 deployment that does provide a real session id (a
custom transport, or a future v2 transport with its own session concept)
gets ordinary, working thrash detection, no different from v1.

**For the common case where v2 genuinely provides no real session id**
(the `createMcpHandler` stateless default): as of this release, two
fixes together make thrash detection work correctly here, the same way
it does for v1's equivalent stdio case.

1. `isSingleConnectionTransport()` no longer auto-detects
   `PerRequestHTTPServerTransport` (the transport `createMcpHandler`
   builds internally) as single-connection at all — see "Known
   limitations" above and `docs/known-gaps.md` entry 8. So the fallback
   path below is no longer reached automatically for a typical v2 HTTP
   deployment; it requires an explicit, informed `assumeSingleSession: true`
   opt-in (or a genuinely single-connection v2 `serveStdio` deployment,
   which is positively confirmed the same way stdio always has been).
2. **For whichever deployments do legitimately reach the fallback path**
   (that explicit opt-in, or v2 stdio): the generated fallback session id
   is now shared across repeated `instrumentMcpServer()` calls when
   `instanceKey` is set — the same registry the four ADR-012 trackers
   already use, one more namespaced entry, no new bound/eviction policy.
   Previously this id was regenerated fresh on every call regardless of
   `instanceKey` (per "instanceKey alone does not fix thrash detection"
   above), so v2's factory pattern (a fresh instance, and a fresh
   `instrumentMcpServer()` call, per request) meant nothing ever
   accumulated even for an intentional, correctly-configured
   single-connection deployment. Fixed: `test/integration/thrash-v2-transport-detection.test.js`
   drives 5 separate `instrumentMcpServer()` calls sharing one
   `instanceKey`, each a fresh v2 `Server` with no real session id, and
   confirms `mcp.tool.loop.detected` now fires by the 5th.

**One narrower thing still open**, tracked in `docs/known-gaps.md` entry
6's own update: `thrashSessionState` — the flag tracking "has this server
ever proven itself session-aware" (used by `resolveThrashSessionId()`'s
rule 2, which skips a later no-session call rather than merging it, once
a server has shown it hands out real ids) — is still a plain per-call
object, not registry-backed. This only matters for a deployment mixing
real-session-id calls with occasional no-session-id ones under a shared
`instanceKey`; rule 1 (a real session id always wins) is unaffected
either way.

**This package's actual v2 support status:** `@modelcontextprotocol/server`
is a supported, optional peer dependency as of v0.10.0 (ADR 015) — see
the "MCP v2 support" section above.

### Registry bounds, and what eviction means

The internal registry `instanceKey` looks trackers up in is bounded, not
unbounded (ADR 012's proposed defaults):

- **Cap:** 1000 distinct `instanceKey` values per process. Normal usage —
  one stable key per logical service, reused across arbitrarily many
  calls — should never approach this.
- **TTL:** 24 hours, renewed on every use. Every `instrumentMcpServer()`
  call under a given key resets that key's 24-hour clock, so a busy
  service's entry never expires from age alone as long as it keeps being
  used.

**Eviction mid-use silently resets that key's accumulated state.** Cap
pressure (more than 1000 distinct keys in active use) or a key genuinely
going quiet for the full 24-hour TTL both mean the *next* call under that
key finds nothing and builds fresh trackers — exactly the original bug's
own behavior, just now gated behind a much narrower condition than "the
next request arrived." Nothing warns when this happens.

### Does NOT help across process boundaries — Lambda, Cloud Run, or any recycled/horizontally-scaled deployment

**Counters are instance-local and best-effort. The registry is an
optimization for one process fielding many `instrumentMcpServer()` calls
— it is not, and will not become, a distributed-counting mechanism.**
`instanceKey`'s registry lives in one process's memory. On Lambda, Cloud
Run, or any horizontally-scaled container fleet, concurrent requests are
routed across concurrently-running instances, and instances themselves get
recycled — passing the identical `instanceKey` string everywhere does
**not** change this: each process loads its own copy of the registry and
only ever sees the calls actually routed to it. A retry loop of N requests
landing on N different instances still resets to empty on every one of
them — the same silent inertness this whole feature exists to fix,
reached through a different door. There is no `instanceKey` configuration
that closes this gap; it is a structural limitation of an in-process
registry, not a tuning problem. Full reasoning — including why this
library deliberately does not add an external store (Redis, DynamoDB, or
similar) to solve it, consistent with its dependency-free posture
elsewhere — is in ADR 012's Update section.

### Configuration

`instanceKey?: string` on `instrumentMcpServer()`'s options. Also settable
via the `OTEL_MCP_INSTANCE_KEY` environment variable (lower precedence
than the option itself). An empty or whitespace-only value from either
source is treated the same as omitting it entirely.

## Fleet-wide fingerprint frequency (a Tempo recipe, not a library feature)

Under stateless MCP — no real session id at all, the exact gap the
`instanceKey` section above documents in full — Agent Thrash Detection's
in-process tracker has nothing to key episodes on, and stays silently
inert. That doesn't mean there's nothing to query downstream:
`mcp.failure.fingerprint` (see "Failure Fingerprinting" above) is already
a plain span attribute on every failed `tools/call` span whenever
fingerprinting is enabled, unconditional on session id or any in-process
accumulation. A trace backend that can aggregate by an arbitrary span
attribute can group by it directly, today, with zero new opentel-mcp
emission. Full investigation: ADR 012's third update
(`docs/adr/012-tracker-lifecycle-and-shared-state.md`).

**⚠️ Read this before treating the query below as "thrash detection for
stateless deployments" — it is not that.** Agent Thrash Detection's whole
premise is *one agent* retrying *one broken call*. Grouping by
`mcp.failure.fingerprint` alone has no dimension to separate callers by —
it counts occurrences of a bug, full stop. **One agent hitting the same
bug 3 times in a row, and three unrelated users each hitting it once, are
indistinguishable by this query — both produce a count of 3 for the same
fingerprint.** That's a real, useful signal (fleet-wide bug-frequency
monitoring) but it is a different question from "is this agent stuck in a
loop," and presenting it as the latter would be dishonest. There is
currently no supported way to add a caller-identity dimension to this
query — see ADR 012's third update for why that would require the library
to read an application-chosen tool argument (the MCP spec's own answer
for session continuity under 2026-07-28 is a server-minted handle passed
back as an ordinary tool argument) and put it on the span, which is a new
kind of attribute this library doesn't emit today and a separate design
decision, not a small addition.

### Why Tempo, and not the other two backends ADR 013 investigated

ADR 013 investigated attribute/event queryability across SigNoz, Tempo,
and Jaeger, but for a different need (rendering panels over single spans
or traces). This recipe needs a capability that investigation didn't
cover: aggregating — counting, grouping — across many separate traces by
an attribute value, not just filtering by one.

- **Tempo** — TraceQL metrics queries support `by(<attribute>)` grouping
  over arbitrary span attributes at query time, including high-cardinality
  ones like `mcp.failure.fingerprint`. The query below is real, pasteable
  TraceQL, not pseudo-syntax.
- **SigNoz** — can express the equivalent, but only as a ClickHouse SQL
  panel inside a Dashboard, per ADR 013's finding that raw ClickHouse
  querying is Dashboard-only, not reachable from the ad-hoc query API a
  live "what's failing right now" view would use.
- **Jaeger** — cannot. Its documented `api_v3.QueryService` (`FindTraces`)
  has no aggregation or grouping parameter of any kind — confirmed
  against the proto directly, per ADR 013.

### A working Tempo query

```traceql
{ span.mcp.failure.fingerprint != "" && status = error }
  | count_over_time() by (span.mcp.failure.fingerprint)
```

Run this as a TraceQL metrics query (Grafana Explore, Tempo data source)
over your evaluation window. To alert on it, wrap it in a Grafana alert
rule with a threshold condition — e.g. fire when any series' value is
`>= 3` over a 5-minute window. Tune the threshold and window to your own
traffic; `3` matches this library's own default thrash
`thrashDetection.threshold` purely for familiarity, not because it's
derived for fleet-wide monitoring.

**Narrow this to one tool or one deployment by adding more attributes to
the filter** — e.g. `&& span.gen_ai.tool.name = "lookup_customer"` — the
same way you'd narrow any other TraceQL query. This doesn't change the
identity-dimension caveat above: narrowing by tool name still can't tell
one looping agent apart from several unrelated callers of that same tool.

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
conventions are now deprecated) for everything they define, and adds
namespaces of its own where they don't yet: `mcp.tool.*` (call-count and
duration metrics, and — as of v0.5.0 — token/cost attribution and budget
attributes), `mcp.failure.*` (failure fingerprinting), `mcp.tool.loop.*` /
`mcp.loop.*` (v0.6.0, Agent Thrash Detection), and — as of v0.8.0 —
`mcp.tool.schema_drift.*` (tool schema drift detection). All are
documented as non-spec at every attribute (`src/attributes.js`,
`src/fingerprint/attributes.js`, `src/thrash/attributes.js`,
`src/schema-drift/attributes.js`), and are candidates to fold into the
spec's own metrics/error vocabulary if it grows an equivalent. Full
reasoning: ADR 004 in `docs/adr/`.

One exception, also in `src/attributes.js`: `gen_ai.response.model` *is*
a real spec attribute, co-emitted alongside the custom `mcp.tool.model`
purely for compatibility with GenAI dashboards that already query it —
see the "Cost & Token Attribution" section above for why that's a
pragmatic choice rather than a spec-pure one.

## Compatibility

- Node.js 20+
- Windows, macOS, Linux (CI matrix tested)
- Pure JavaScript, zero native dependencies
- Supports both low-level `Server` and high-level `McpServer` APIs, from
  either of two SDKs — see "Both server APIs" and "MCP v2 support" above
- @modelcontextprotocol/sdk ^1.0.0 (optional peer — v1, protocol revisions
  through 2025-11-25)
- @modelcontextprotocol/server ^2.0.0 (optional peer — v2, protocol
  revision 2026-07-28, v0.10.0+; see "MCP v2 support" above for what's
  covered and `docs/known-gaps.md` entries 6 and 8 for what isn't yet)
- @opentelemetry/api ^1.9.0
- 948 tests, 944 passing + 4 intentionally skipped (`npm test`) — see `test/`
- `npm run typecheck` (`tsc --noEmit`) type-checks the public `.d.ts`
  surface (`src/index.d.ts` and friends) — see CONTRIBUTING.md

## Roadmap

- v0.4: Deep Failure Fingerprinting ✓ — see "Failure Fingerprinting" above
  and ADR 006.
- v0.5: Cost & Token Attribution ✓ — see "Cost & Token Attribution" above.
- v0.6: Agent Thrash Detection ✓ — see "Agent Thrash Detection" above.
- v0.7: Channel-aware thrash detection ✓ — fixes a real false positive
  (output-validation failures counted as thrash) present since v0.6.0; adds
  `mcp.failure.channel` and per-channel thresholds. See "Agent Thrash
  Detection" above and ADR 007. Also confirms (ADR 009) that field-level
  discrimination for `protocol.input` failures already worked as a side
  effect of fingerprinting — now regression-tested and surfaced via
  `mcp.failure.validation_paths` (see "Failure Fingerprinting" above). Five
  gaps this release didn't fully close — field-level convergence tracking,
  partial convergence within it, an observation-liveness contract, the
  pre-handler parse-failure gap, and client-side retry caps — are tracked
  in `docs/known-gaps.md`, not silently dropped.
- v0.8: Tool schema drift detection ✓ — see "Tool schema drift detection"
  above and ADR 010. Detects a tool's `inputSchema` changing between two
  observed `tools/list` responses, classified into `field_added` /
  `field_removed` / `type_changed` / `required_changed` / `multiple` /
  `unknown`. **Behavior change on upgrade**: the instrument-first ordering
  requirement now also covers `tools/list` for low-level `Server` users,
  since `schemaDrift.enabled` defaults to `true` — see that section's
  "Behavior change on upgrade" and the CHANGELOG.
- v0.8: Two-axis observation contract ✓ — see "Two-axis observation
  contract" above and ADR 008's "Update (2026-08-05)" section. Prompted
  by external review (Massimiliano Brighindi), who raised the original
  observation-liveness gap and then supplied the reframe that shaped what
  shipped: not "detect a broken pipeline," but "stop implying health by
  omission." `getObservationState()` returns `toolOutcome` (cumulative
  success/failure/unknown counts, from a counter independent of
  `fingerprinting`/`thrashDetection`/`enableMetrics`) and
  `observationIntegrity` (`'DEGRADED' | 'UNKNOWN'` — `HEALTHY` was
  investigated and found structurally unreachable in every
  configuration, so it isn't part of the type at all).
- v0.8: Cost-aware trace sampling — marker attribute + Collector recipe,
  **not** an in-process sampler ✓ — see "Cost-aware trace sampling" above
  and ADR 011. In-process tail sampling was investigated and found not
  achievable by design: this package doesn't own the
  `Sampler`/`SpanProcessor` chain in its default configuration (no public
  API to inject either into a host-owned `TracerProvider`), and even
  where a custom processor could theoretically be installed, an
  in-process decision can only ever rescue the one span this package
  itself creates, never a whole trace. What *is* shipped: a new boolean
  `mcp.tool.thrash_detected` span attribute (alongside the pre-existing
  `mcp.loop.detected` span event), joining the already-sufficient
  `mcp.tool.cost.usd` / `mcp.tool.cost.budget_exceeded` attributes, plus
  a documented, pasteable OpenTelemetry Collector `tailsamplingprocessor`
  config that keeps expensive/budget-exceeded/thrashing traces alongside
  a normal probabilistic sample for everything else. **Update (v0.12.0):**
  the recipe YAML moved to `docs/recipes/tail-sampling.yaml` (README
  references it rather than duplicating it), gained two more policies —
  `mcp.tool.schema_drift_detected` (a new attribute, the same event/attribute
  fix applied to schema drift) and `mcp.tool.pricing_status = "unknown"`
  (closes a v0.11.0-adjacent gap: an unpriced call has real cost but no
  `mcp.tool.cost.usd`, which a numeric-threshold policy can't tell apart
  from a genuinely free one) — and is now cross-checked by a test
  (`test/recipes/tail-sampling-attributes.test.js`) that fixes a real bug
  this section previously had: it recommended the schema-drift span
  *event* name as a `boolean_attribute` policy target, which could never
  have matched anything. See "Cost-aware trace sampling" above for the
  full detail, including what is and isn't verified.
- v0.10.0: `@modelcontextprotocol/server` (MCP v2, protocol revision
  2026-07-28) support ✓ — see "MCP v2 support" above and ADR 015
  (`docs/adr/015-mcp-v2-support.md`). Spans, standard attributes, failure
  fingerprinting, `mcp.failure.channel`/`validation_paths` classification,
  and Agent Thrash Detection (including the transport auto-detection
  heuristic and the fallback session id under `instanceKey`) all work the
  same as v1. Also hardened `detectServerKind()` to fail loudly instead of
  silently instrumenting nothing for an unrecognized/unwrappable server
  object — a behavior change (an object that previously silently no-op'd
  now throws), separate from v2 support itself; see the CHANGELOG. One
  narrower thing still open, tracked in `docs/known-gaps.md` entry 6:
  `thrashSessionState`'s session-awareness memory isn't shared across v2's
  per-request calls yet, only the fallback id itself.
- Future: failure clustering + regression detection; recovery hints;
  root-cause chaining across parent spans; alignment with the OTel GenAI
  SIG's MCP semantic conventions when published
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
