# ADR 005: Metrics via the API only, custom `mcp.tool.*` instrument names, and setup ordering

## Context

v0.3 adds OTel metrics alongside the existing tracing. Three separate
design questions came up that ADR 004 (semantic-conventions alignment for
spans) didn't have to answer:

1. **SDK vs. API-only.** `setupTracer()` in `instrument.js` optionally
   stands up an owned `NodeTracerProvider` when `setupNodeSdk: true`, for
   the dev-friendly one-line mode. Should metrics get the same treatment,
   or a bundled `MeterProvider`/OTLP metric exporter?
2. **Instrument names.** The MCP semantic conventions (`.spec-reference/mcp-semconv.md`)
   define `mcp.server.operation.duration`, a generic per-JSON-RPC-method
   duration histogram with `error.type` as its only failure signal. That
   metric doesn't have anywhere to put this package's core
   differentiator — the isError:true "silent failure" distinct from a
   thrown/protocol error — without overloading `error.type` with a value
   the spec doesn't define for it. Do we implement the spec metric now, or
   ship purpose-built instruments first?
3. **Setup ordering.** `setupTracer()` calls `trace.getTracer()` once, at
   `instrumentMcpServer()` time, and this works even if the host
   application registers its `TracerProvider` *after* that call, because
   `@opentelemetry/api`'s tracing API returns a `ProxyTracer` that
   delegates lazily. Does the metrics API behave the same way?

## Decision

1. **API-only**, same pattern as tracing: `src/metrics.js`'s `setupMeter()`
   calls `metrics.getMeter()` and creates instruments against whatever
   `MeterProvider` is globally registered (or the API's no-op
   implementation if none is). No `MeterProvider`, no metric exporter, and
   no new runtime dependency was added — `@opentelemetry/sdk-metrics` is a
   **devDependency only**, used exclusively by `test/metrics.test.js`'s
   in-memory reader. `setupNodeSdk: true` continues to affect tracing only.
2. **Custom instrument names**, not the spec's `mcp.server.operation.duration`:
   `mcp.tool.calls` (counter), `mcp.tool.errors` (counter),
   `mcp.tool.silent_failures` (counter), `mcp.tool.duration` (histogram,
   `ms`). The tool-name attribute on all four is `gen_ai.tool.name` —
   already the spec-aligned name spans use (ADR 004) — and `mcp.tool.calls`
   /`mcp.tool.errors` also carry `mcp.method.name`/`error.type`, the same
   spec attributes spans carry. Only the instrument *names* and the new
   `mcp.tool.outcome` attribute are custom; the attribute *vocabulary*
   stays spec-aligned throughout, per ADR 004's stance. `mcp.tool.silent_failures`
   increments from the exact same `isError?.() === true` check that sets
   the span's `error.type: tool_error` — extracted into one
   `isToolResultError()` helper in `instrument.js` — so detection logic
   isn't duplicated between traces and metrics.
3. **Same ordering constraint as tracing, made explicit**: `setupMeter()`
   must run after the host registers its `MeterProvider`. Verified against
   `@opentelemetry/api`'s installed source
   (`node_modules/@opentelemetry/api/build/src/api/metrics.js`): unlike
   `trace.getTracer()`, `metrics.getMeter()` has no `ProxyMeterProvider` —
   it resolves `getGlobal('metrics')` synchronously on every call and hands
   back whatever `Meter` (real or no-op) is currently registered. An
   instrument created before the host registers its `MeterProvider` stays
   bound to the no-op `Meter` forever; there is no later delegate switch.
   `setupMeter()` is called once per `instrumentMcpServer()` call, exactly
   like `setupTracer()`, so the existing documented ordering ("whatever
   provider the host application has already registered globally") already
   covers this — it just happens to be load-bearing for metrics in a way
   it wasn't for tracing.

## Constraints accepted

- `mcp.tool.*` is **not** the spec's metric name or shape.
  `mcp.server.operation.duration` remains unimplemented and is tracked in
  the README roadmap, not silently dropped — a future release may add it
  alongside `mcp.tool.duration` (they serve different purposes: one is
  spec-interoperable, the other carries the silent-failure signal this
  package exists for) or fold the distinction into `mcp.server.operation.duration`
  if/when the spec grows an equivalent attribute.
- If a host application calls `instrumentMcpServer()` before registering
  its `MeterProvider` — a mistake the tracing path tolerates silently by
  design — metrics silently stay no-op for that server's lifetime, with no
  runtime warning. This mirrors `setupTracer()`'s existing behavior for
  `serviceName`-less bring-your-own-SDK setups (also silent), but is a
  sharper edge here because there's no proxy layer underneath to paper
  over a wrong call order. Not addressed in this pass; a `diag.warn` when
  `metrics.getMeter()` returns the API's `NoopMeter` (detectable by
  identity, since `@opentelemetry/api` exports a stable singleton) is a
  candidate for a follow-up if this turns out to bite real users.

## Alternatives rejected

- **Implement `mcp.server.operation.duration` instead of/alongside custom
  names, now.** Rejected for this pass on scope grounds: it requires a
  design for reconciling per-method (not just per-tool) recording — the
  metric covers all JSON-RPC methods, not just `tools/call` — plus a
  decision on whether/how `isError:true` gets a place in it without
  redefining `error.type`'s spec semantics for the metric. Tracked in the
  roadmap rather than rushed.
- **Bundle a default `MeterProvider` + OTLP metric exporter**, mirroring
  `setupNodeSdk: true` for tracing. Rejected: it would add
  `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http`
  as real (non-dev) dependencies, and CONTRIBUTING.md's "no new
  dependencies without discussion first" applies to the published package,
  not just tests. The API-only path needs zero new runtime dependencies.
  Revisit if there's demand for a metrics equivalent of the dev-friendly
  `setupNodeSdk` mode.

## Consequences

- README's "Metrics" section documents the instrument table and shows
  wiring a `PeriodicExportingMetricReader` + OTLP/HTTP exporter by hand
  (host-app-owned, same as the "Bring-your-own-SDK (prod)" tracing mode).
- `@opentelemetry/sdk-metrics` was added as a **devDependency**, not a
  dependency — flagged explicitly per the PR checklist's "no new
  dependencies without discussion first," since it's still a new entry in
  `package.json` even though it never ships to consumers.
- `enableMetrics: false` exists as an explicit opt-out (default `true`),
  separate from and in addition to the API's own no-op-when-unregistered
  default — for hosts that register a `MeterProvider` for other
  instrumentation but don't want this package's metrics specifically.
