# Changelog

## 0.3.0

### Added

- OTel metrics, via `@opentelemetry/api`'s Metrics API only (no bundled
  SDK/exporter — same host-app-provides-the-SDK pattern tracing already
  uses):
  - `mcp.tool.calls` (counter) — every tool call; `gen_ai.tool.name`,
    `mcp.method.name`
  - `mcp.tool.errors` (counter) — thrown/rejected handler; `gen_ai.tool.name`,
    `error.type`
  - `mcp.tool.silent_failures` (counter) — JSON-RPC succeeded but
    `CallToolResult.isError === true`; `gen_ai.tool.name`
  - `mcp.tool.duration` (histogram, unit `ms`) — call latency;
    `gen_ai.tool.name`, `mcp.tool.outcome` (`success` | `error` |
    `silent_failure`)
  - `mcp.tool.silent_failures` fires from the same `isError` check that
    marks the span ERROR — extracted into one shared `isToolResultError()`
    helper in `src/instrument.js` so the detection logic isn't duplicated
    between traces and metrics.
  - Metrics are a zero-overhead no-op until the host application registers
    a `MeterProvider` (default `@opentelemetry/api` behavior — not
    special-cased here).
- `enableMetrics` option (default `true`) to opt out of metric emission
  without affecting tracing.

### Naming note (no attribute rename)

The tool-name attribute on all four new metrics is `gen_ai.tool.name`, not
`mcp.tool.name` — the same spec-aligned name spans have used since v0.2's
semantic-conventions pass (ADR 004). Traces and metrics were already
consistent going into this release, so nothing was renamed here; this is
called out because a naive read of the MCP semantic conventions might
suggest a `mcp.tool.name` attribute, but the spec's actual server-span/
metric attribute for this is `gen_ai.tool.name` (MCP tool calls are
GenAI `execute_tool` calls under the hood — see `docs/adr/004-semantic-conventions-alignment.md`
and `.spec-reference/mcp-semconv.md`). `mcp.method.name`, `error.type`,
and `mcp.tool.argument_count` are unchanged. `mcp.tool.outcome` is a new
custom (non-spec) attribute, documented in `src/attributes.js` alongside
the other custom attribute.

### Docs

- README: new "Metrics" section (instrument table, `enableMetrics`, and a
  `PeriodicExportingMetricReader` + OTLP/HTTP wiring example targeting
  SigNoz's default local endpoint).
- Roadmap updated to reflect metrics shipping in this release.

## 0.2.0

See git history — TypeScript declarations (`.d.ts`), workspace stripping
for publish, and README documentation improvements.

## 0.1.0

Initial release: OTel tracing for MCP tool calls, including detection of
`CallToolResult.isError: true` "silent failures" as `error.type: tool_error`
span status.
