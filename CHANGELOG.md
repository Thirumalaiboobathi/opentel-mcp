# Changelog

## 0.6.1

### Fixed

- `src/index.d.ts` re-exported values (`computeFingerprint`,
  `toSpanAttributes`, `ATTRIBUTE_KEYS`, `METRIC_SAFE_ATTRIBUTES`,
  `DEFAULT_CLASSIFIERS`, `DEFAULT_PRICING`, `defaultExtractor`,
  `calculateCost`) from six `.js` modules that had no corresponding `.d.ts`
  file, so any consumer with `strict`/`noImplicitAny` got a TS7016 error
  just from importing the package. Added `src/fingerprint/compose.d.ts`,
  `src/fingerprint/attributes.d.ts`, `src/fingerprint/classify/index.d.ts`,
  `src/cost/pricing.d.ts`, `src/cost/extractor.d.ts`, and
  `src/cost/calculator.d.ts`. Pre-existing since v0.4.0 (fingerprinting) and
  v0.5.0 (cost tracking) — first caught verifying the v0.6.0 published
  tarball.

## 0.6.0

### Added — Agent Thrash Detection

Detects when an agent retries the same tool with the same v0.4 failure
fingerprint repeatedly, and attributes the wasted v0.5 tokens/cost to that
loop — see the README's new "Agent Thrash Detection" section for the full
picture, including the sessionId resolution rules below (the one thing
most likely to be misconfigured).

- Metrics, via the same `@opentelemetry/api`-only pattern as the existing
  `mcp.tool.*` instruments: `mcp.tool.loop.detected` (counter),
  `mcp.tool.loop.length` (histogram), `mcp.tool.loop.wasted_tokens`
  (histogram, unit `tokens`), `mcp.tool.loop.wasted_cost_usd` (histogram,
  unit `USD`), `mcp.tool.loop.duration` (histogram, unit `ms`). All five
  carry only `gen_ai.tool.name` as a metric label — `mcp.failure.fingerprint`
  and the new `mcp.loop.session_id` are deliberately excluded from every
  metric (both are unbounded, per-caller values; see
  `METRIC_SAFE_ATTRIBUTES`'s docblock in `src/fingerprint/attributes.js`).
- One `mcp.loop.detected` span event on the currently active span (never a
  new span), carrying full detail including `mcp.failure.fingerprint` and
  `mcp.loop.session_id` — span events can carry unbounded attributes
  safely, unlike metric labels.
- `thrashDetection` option on `instrumentMcpServer()` (see `src/config.js`
  and `src/thrash/config.js`): `{ enabled?, threshold?, windowMs?,
  maxTrackedKeys?, entryTtlMs?, reEmitAfter?, assumeSingleSession? }`.
  Every field independently overridable via an `OTEL_MCP_THRASH_*` env var
  (first documented env-var-driven config pattern in this codebase).
  Defaults: enabled, 3 consecutive same-fingerprint failures within 60s,
  1000 max tracked keys (bounded LRU+TTL — see `src/thrash/store.js`), a
  15-minute idle TTL, re-emit every 3 further failures past threshold,
  `assumeSingleSession: false`.
- **Requires `fingerprinting: true`** (the default): thrash detection keys
  off the same `mcp.failure.fingerprint` fingerprinting computes, so with
  fingerprinting disabled, detection silently never fires regardless of
  `thrashDetection`'s own settings.
- Safe-by-default session resolution. A generated per-connection fallback
  session id is used only when a transport is structurally confirmed
  single-connection (no `sessionId` property on `server.transport` — e.g.
  stdio) or explicitly opted into via `thrashDetection.assumeSingleSession`
  — **never** merging concurrent HTTP/SSE clients into one shared key,
  which would otherwise fabricate false-positive loops out of unrelated
  clients' failures. Once a server has been observed handing out a real
  session id, a later call with none is skipped entirely rather than
  falling back. A one-time `diag.warn` fires the first time the fallback
  is actually used, naming which of the three conditions triggered it.
- `bench/thrash-data-benchmark.js`: a runnable data benchmark (distinct
  from the CPU/memory performance benchmark in
  `test/thrash/benchmark.test.js`) measuring detection rate and wasted
  cost against a real in-process MCP `Client`/`Server` pair, with a
  `--sweep` mode across configured broken-tool rates and a closed-form
  sanity check that aborts rather than shipping a row that deviates
  beyond sampling noise. Two published, reproducible runs committed under
  `bench/results/` — see the README for how to read them (they model
  sensitivity to a reader-supplied failure rate, not a measurement of any
  real deployment).
- In-process summary: `instrumentMcpServer()`'s returned object gets a
  `getThrashSummary()` method (`ThrashDetector.getSummary()` underneath)
  — a zero-infrastructure way to check "is anything thrashing right now"
  without a metrics backend or trace viewer. Returns `activeLoops` (loops
  currently in the bounded store that have crossed `threshold` — bounded
  by `maxTrackedKeys`, not a complete history) and `topOffenders` (up to 5
  by default, configurable via `getThrashSummary({ topOffendersLimit })`,
  sorted by `wastedCostUsd` descending), alongside `totalLoopsDetected` /
  `totalWastedCostUsd` / `totalWastedTokensIn` / `totalWastedTokensOut` —
  cumulative counters that, unlike the two above, survive LRU eviction
  and TTL expiry (incremented at emit time, with delta-based accounting
  so a loop that re-emits multiple times doesn't have its earlier calls'
  cost double-counted). Never throws; an all-zero summary if
  `thrashDetection` is disabled. Pure read — no effect on the hot path.
  `src/thrash/store.js`'s `BoundedTtlMap` gained an `entries()` iterator
  to support this (a minimal, necessary extension of its Phase 2 surface,
  which was previously get/set/delete/size only).

### Public API additions

- Re-exported from the package root (`src/index.d.ts`, types only —
  `ThrashDetector`/`createThrashEmitter` stay internal): `ThrashConfig`,
  `ThrashDetectedEvent`, `ThrashSummary`, `ThrashOffender` (new
  `src/thrash/types.d.ts`, mirrors the `src/cost/types.d.ts` /
  `src/fingerprint/types.d.ts` pattern).
- `instrumentMcpServer()`'s return type gained `getThrashSummary?: (options?: { topOffendersLimit?: number }) => ThrashSummary`,
  alongside the existing `shutdown?`.
- `fingerprinting` and `thrashDetection` (with all of `ThrashConfig`,
  including `assumeSingleSession`) are now declared on `InstrumentOptions`
  in `src/index.d.ts` — both worked at runtime since introduction but were
  missing from the public type declarations until now. Also added:
  `FingerprintContext`, `Classifier`, `ComputeFingerprintOptions` (the
  types needed to type a custom `computeFingerprint()` classifier per the
  README's "Extending it" section — same kind of gap, found in the same
  audit).
- `npm run typecheck` (`tsc --noEmit`, new `tsconfig.json`): type-checks
  `src/index.d.ts` and the sibling `src/*/types.d.ts` files, plus a new
  type-level test (`test/index.exports.test-d.ts`, using `expectTypeOf`)
  asserting a consumer can construct `InstrumentOptions` with a partial
  `thrashDetection` and a partial `fingerprinting` config. Does not
  type-check the `.js` source itself (`checkJs: false`) — still no build
  step, this only guards the hand-written public type declarations.

### Changed (additive, non-breaking)

- `applyCostAttribution()` (internal, `src/instrument.js`) now returns
  `{ tokensIn, tokensOut, costUsd } | null` instead of `void`, so thrash
  detection can reuse one call's already-computed cost figures instead of
  re-running the extractor. Not part of the public API and not observable
  from outside `instrument.js`; nothing in v0.5.0 read the previous
  `undefined` return value.

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
