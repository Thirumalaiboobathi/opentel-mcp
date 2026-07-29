# Changelog

## 0.5.0

### Added — Cost & Token Attribution

- Span attributes, added on any tool call whose result carries recognizable
  usage data: `mcp.tool.tokens.input`, `mcp.tool.tokens.output`,
  `mcp.tool.tokens.total`, `mcp.tool.model`, `gen_ai.response.model`
  (co-emitted alongside `mcp.tool.model` for GenAI-dashboard compatibility —
  see README's "Cost & Token Attribution" section and the
  `ATTR_GEN_AI_RESPONSE_MODEL` docblock in `src/attributes.js` for why this
  is a pragmatic compatibility choice, not a spec-pure emission),
  `mcp.tool.cost.usd`, and `mcp.tool.cost.currency`. All added by
  `applyCostAttribution()` in `src/instrument.js`, wrapped in its own
  try/catch — cost tracking can never break a span.
- Two new metric instruments, via the same `@opentelemetry/api`-only
  pattern as the four existing `mcp.tool.*` metrics: `mcp.tool.tokens.total`
  (counter, unit `tokens`) and `mcp.tool.cost.total` (counter, unit `USD`),
  both attributed by `gen_ai.tool.name` + `mcp.tool.model` (model only
  added when detected, same optional-attribute pattern
  `mcp.failure.category` already uses).
- Per-session and per-tool budget guardrails (`costTracking.budget`,
  `src/cost/budget.js`): in-memory cumulative-cost tracking, flags
  `mcp.tool.cost.budget_exceeded` / `mcp.tool.cost.budget_scope`
  (`"session"` | `"tool"`, session wins if both trip on the same call) on
  the span once a configured `perSessionUsd`/`perToolUsd` limit is
  crossed. **Observability only — never blocks or throws.** Calls with no
  MCP session id (e.g. stdio transport) are skipped for session tracking
  rather than lumped under a fallback key.
- `DEFAULT_PRICING` (`src/cost/pricing.js`): a default pricing table
  covering 15+ models across five providers — Anthropic, OpenAI, Google,
  AWS Bedrock, and DeepSeek. **Last verified 2026-07-29 — provider pricing
  changes frequently and this table is not guaranteed to stay current;
  override `costTracking.pricingTable` for production accuracy.**
- `defaultExtractor` (`src/cost/extractor.js`): recognizes Anthropic
  (`usage.input_tokens`/`usage.output_tokens`), OpenAI
  (`usage.prompt_tokens`/`usage.completion_tokens`), and Bedrock
  (`usage.inputTokens`/`usage.outputTokens`) usage shapes, the MCP
  `_meta.usage` extension point, and JSON-in-text inside
  `content[0].text`. Never throws — unrecognized shapes resolve to `null`.
  Pluggable via `costTracking.extractor` (type `UsageExtractor`) for
  custom tool result formats.
- `calculateCost()` (`src/cost/calculator.js`): normalizes a model name
  (lowercase, strips a `provider/` prefix) and prices it against a
  `PricingTable`. Returns `null` — never throws — for an unrecognized
  model or invalid token counts.
- `costTracking` option on `instrumentMcpServer()` (see `src/config.js`):
  `{ enabled?: boolean; pricingTable?: PricingTable; extractor?:
  UsageExtractor; budget?: { perSessionUsd?: number; perToolUsd?: number
  } }`. Defaults to enabled, `DEFAULT_PRICING`, `defaultExtractor`, budget
  tracking off. Any field can be overridden independently.

### Public API additions

Re-exported from the package root (`src/index.js` / `src/index.d.ts`):
`DEFAULT_PRICING`, `defaultExtractor`, `calculateCost` (values), and
`ModelPricing`, `PricingTable`, `UsageExtractor`, `TokenUsage`,
`CostTrackingOptions` (types, from the new `src/cost/types.d.ts` —
mirrors the `src/fingerprint/types.d.ts` pattern).

### Docs

- `gen_ai.tool.name`'s comment in `src/attributes.js` now explicitly notes
  it's sourced from the OTel GenAI semantic conventions, not a custom
  addition — the file already documented this at the module/section level,
  but not on the constant itself, which read ambiguously next to the
  custom attributes below it that do say so explicitly.
- README: new "Cost & Token Attribution (v0.5.0)" section (motivation,
  zero-config quick-start, advanced config example, span-attribute and
  metric tables, pricing-accuracy note, extension points); intro tagline
  and "Configuration"/"Semantic conventions"/"Roadmap"/"Compatibility"
  sections updated to match.

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
