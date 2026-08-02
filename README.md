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

### Advanced: custom pricing, a custom extractor, and a budget guardrail

```js
import { instrumentMcpServer, DEFAULT_PRICING } from 'opentel-mcp';

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  costTracking: {
    // Extend or override DEFAULT_PRICING — e.g. price an internal model
    // it doesn't know about, or correct stale numbers.
    pricingTable: {
      ...DEFAULT_PRICING,
      'my-internal-model': { inputPer1M: 1.0, outputPer1M: 2.0, currency: 'USD' },
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

### Span attributes

| Attribute | Standard OTel? | Description | Example |
|---|---|---|---|
| `mcp.tool.tokens.input` | Custom | Input tokens consumed | 1000 |
| `mcp.tool.tokens.output` | Custom | Output tokens produced | 500 |
| `mcp.tool.tokens.total` | Custom | input + output | 1500 |
| `mcp.tool.model` | Custom | Detected model name | "claude-sonnet-5" |
| `gen_ai.response.model` | Standard (GenAI semconv)[^5] | Same value as `mcp.tool.model`, co-emitted for dashboard compatibility | "claude-sonnet-5" |
| `mcp.tool.cost.usd` | Custom | Estimated cost, from `calculateCost()` | 0.0105 |
| `mcp.tool.cost.currency` | Custom | Always `"USD"` today | "USD" |
| `mcp.tool.cost.budget_exceeded` | Custom | `true` once a configured `costTracking.budget` limit is crossed | true |
| `mcp.tool.cost.budget_scope` | Custom | Which budget scope tripped: `"session"` \| `"tool"` (session wins if both did) | "session" |

[^5]: `gen_ai.response.model` is a real OTel GenAI semantic convention attribute ("the name of the model that generated the response") — but this span is an MCP tool-call span (`gen_ai.operation.name: execute_tool`), not a dedicated LLM request/response span, so co-emitting it here is a **pragmatic dashboard-compatibility choice, not a spec-pure emission**. It's set purely so off-the-shelf GenAI dashboards (Grafana, SigNoz, Honeycomb) that filter/group by `gen_ai.response.model` pick these spans up without any opentel-mcp-specific configuration. Full reasoning in `src/attributes.js`'s `ATTR_GEN_AI_RESPONSE_MODEL` docblock.

The four token/model attributes are set together or not at all; the two
cost attributes only appear when a model was detected *and* it resolves
in the configured `pricingTable`; the two budget attributes only appear
when a cost was calculated *and* a configured limit was crossed. Source
of truth: `src/attributes.js` and `src/instrument.js`'s
`applyCostAttribution()`.

### Metrics

Two more `mcp.tool.*` metrics, via the same API-only pattern as the four
in "Metrics" above — nothing recorded until a `MeterProvider` is
registered, `enableMetrics: false` opts out of these too.

| Metric | Type | Unit | Attributes | Emitted when |
|---|---|---|---|---|
| `mcp.tool.tokens.total` | Counter | tokens | `gen_ai.tool.name`, `mcp.tool.model`[^6] | Usage detected in the tool result |
| `mcp.tool.cost.total` | Counter | USD | `gen_ai.tool.name`, `mcp.tool.model`[^6] | Cost calculated (model resolved in `pricingTable`) |

[^6]: `mcp.tool.model` is only added when a model was detected — the same optional-attribute cardinality pattern `mcp.failure.category` already uses on the other four metrics.

### Pricing accuracy

> **Pricing table last verified 2026-07-29.** Users **MUST** override
> `pricingTable` for production accuracy — provider pricing changes
> frequently and opentel-mcp does not guarantee `DEFAULT_PRICING` stays
> current.

`DEFAULT_PRICING` (`src/cost/pricing.js`) covers 15+ models across five
providers — Anthropic, OpenAI, Google, AWS Bedrock, and DeepSeek — as a
convenience default, not a maintained price list.

### Extending it

- `defaultExtractor` (also exported) recognizes the five conventions
  listed under "Zero-config quick-start" above; pass your own
  `costTracking.extractor` (a `UsageExtractor`: `(toolResult) =>
  TokenUsage | null`, never throwing) to recognize anything else.
- `calculateCost(inputTokens, outputTokens, model, pricingTable)` is also
  exported directly, for recomputing cost outside the instrumentation
  hot path (e.g. over historical spans).
- Disable everything in this section with `costTracking: { enabled:
  false }`; tracing, metrics, and fingerprinting are all unaffected.
- Budget tracking (`costTracking.budget`) is in-memory and per
  `instrumentMcpServer()` call — it resets on process restart, and
  session-scoped limits are skipped gracefully (not enforced against a
  fallback key) for transports with no session id, like stdio.

## Agent Thrash Detection (v0.6.0)

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
3. **Before any real session id has ever been observed**, a generated
   per-connection fallback id is used only when:
   - the transport is **structurally confirmed single-connection** — no
     `sessionId` property on `server.transport` at all (e.g. stdio's
     `StdioServerTransport`, which has no session concept whatsoever), or
   - **you set `assumeSingleSession: true`** — an explicit opt-in for
     transports the auto-detection can't see (e.g. a custom `Transport`
     implementation), where you already know every connection is 1:1.

   Otherwise — an undetermined, potentially multi-client transport, with
   `assumeSingleSession` left at its default `false` — detection is
   **skipped silently** for that call rather than guessing.

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

[^10]: `{ enabled?, threshold?, windowMs?, maxTrackedKeys?, entryTtlMs?, reEmitAfter?, assumeSingleSession? }`, all fields optional, individually defaulted, and individually overridable via an `OTEL_MCP_THRASH_*` env var — see "Agent Thrash Detection" → "Configuration" above for the full table.

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
attributes), `mcp.failure.*` (failure fingerprinting), and — as of
v0.6.0 — `mcp.tool.loop.*` / `mcp.loop.*` (Agent Thrash Detection). All
are documented as non-spec at every attribute (`src/attributes.js`,
`src/fingerprint/attributes.js`, `src/thrash/attributes.js`), and are
candidates to fold into the spec's own metrics/error vocabulary if it
grows an equivalent. Full reasoning: ADR 004 in `docs/adr/`.

One exception, also in `src/attributes.js`: `gen_ai.response.model` *is*
a real spec attribute, co-emitted alongside the custom `mcp.tool.model`
purely for compatibility with GenAI dashboards that already query it —
see the "Cost & Token Attribution" section above for why that's a
pragmatic choice rather than a spec-pure one.

## Compatibility

- Node.js 20+
- Windows, macOS, Linux (CI matrix tested)
- Pure JavaScript, zero native dependencies
- Supports both low-level `Server` and high-level `McpServer` APIs
- @modelcontextprotocol/sdk ^1.0.0
- @opentelemetry/api ^1.9.0
- 369 tests (`npm test`) — see `test/`
- `npm run typecheck` (`tsc --noEmit`) type-checks the public `.d.ts`
  surface (`src/index.d.ts` and friends) — see CONTRIBUTING.md

## Roadmap

- v0.4: Deep Failure Fingerprinting ✓ — see "Failure Fingerprinting" above
  and ADR 006.
- v0.5: Cost & Token Attribution ✓ — see "Cost & Token Attribution" above.
- v0.6: Agent Thrash Detection ✓ — see "Agent Thrash Detection" above.
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
