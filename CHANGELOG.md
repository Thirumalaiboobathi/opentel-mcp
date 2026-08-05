# Changelog

## 0.8.0

Tool schema drift detection: a server that silently changes a tool's
`inputSchema` between deployments — a parameter renamed, a type tightened, a
`required` field added — currently breaks agents with no signal pointing at
the actual cause. Full investigation and design: ADR 010
(`docs/adr/010-schema-drift.md`).

### Added

- **Tool schema drift detection.** Every `tools/list` response is captured,
  canonicalized, and hashed per tool (`inputSchema` only — `description` is
  a deliberately separate, not-yet-built dimension; see ADR 010). When a
  previously-observed tool's schema hash changes, this emits:
  - An `mcp.tool.schema_drift.detected` counter, labeled `gen_ai.tool.name`
    and `mcp.tool.schema_drift.type` (both bounded — see
    `METRIC_SAFE_ATTRIBUTES`, `src/schema-drift/attributes.js`).
  - An `mcp.tool.schema_drift.detected` span event on the new `tools/list`
    span (see Changed, below), carrying the drift `type`, the previous/
    current schema hash, and — only when non-empty, never set to `[]` —
    which field names were added/removed/changed. Field names are
    span-only, never a metric label (unbounded across tools/deployments,
    same reasoning as `mcp.failure.validation_paths`, ADR 009).
  - `type` is one of `field_added` \| `field_removed` \| `type_changed` \|
    `required_changed` \| `multiple` (more than one at once, never guessed
    down to a single answer) \| `unknown` (a change this differ can't
    confidently characterize — e.g. a top-level `oneOf`/`anyOf`/`allOf`
    composition, or a change hidden behind a `$ref`/`$defs` indirection
    that doesn't touch the referencing property's own value — still
    reported as drift, just not attributable to a specific field).
  - The **first** observation of any given tool is never reported as
    drift (nothing to compare against yet — cold start). A tool that
    stops appearing in `tools/list` responses for a while and later
    reappears is compared against its last-seen schema, not treated as a
    fresh cold start — see the README's "Tool schema drift detection"
    section for why this is the correct, and possibly counter-intuitive,
    behavior.
  - State is scoped **per instrumented server instance, not per session**
    (ADR 010, Q4) — every client session sees the same tool registry, so
    session-keyed state would produce false cold-starts per new session
    and could silently swallow drift that happened between sessions.
  - New `schemaDrift` option on `instrumentMcpServer()`, following the
    exact `thrashDetection`/`costTracking` partial-overrides-individual-
    defaults pattern: `enabled` (default `true`) and `maxTrackedTools`
    (default `1000`, an LRU cap — defense-in-depth, not a response to an
    expected failure mode; a server's own tool count is normally small).
    Each independently overridable via `OTEL_MCP_SCHEMA_DRIFT_ENABLED` /
    `OTEL_MCP_SCHEMA_DRIFT_MAX_TRACKED_TOOLS`, following the existing
    `OTEL_MCP_THRASH_*` env-var convention.
    **Unlike** `thrashDetection`/`costTracking`, `schemaDrift.enabled: false`
    is a true no-op: `tools/list` is not wrapped at all (no span, no
    capture, no detector/emitter construction) — the `tools/list` span
    this feature introduces exists purely for schema drift, unlike the
    `tools/call` span, which already serves other purposes regardless of
    sub-feature flags.
  - `SchemaDriftConfig`, `SchemaDriftKind`, `SchemaDriftEvent` types,
    exported from the package root.

### Changed — behavior change on upgrade, read before updating

- **The instrument-first ordering requirement now also covers `tools/list`,
  for low-level `Server` users specifically, because `schemaDrift.enabled`
  defaults to `true`.** `instrumentMcpServer()` has always required being
  called before any `tools/call` handler is registered; as of this release,
  with schema drift enabled (the default), it also requires being called
  before any `tools/list` handler is registered. If your low-level `Server`
  code registers `server.setRequestHandler(ListToolsRequestSchema, ...)`
  before calling `instrumentMcpServer()` — never previously an error, since
  this library was blind to `tools/list` entirely before this release —
  upgrading will make that throw `INSTRUMENT_FIRST_ERROR` where it didn't
  before, with no other code changes on your part.
  - **`McpServer` users are unaffected.** `McpServer` registers `tools/list`
    and `tools/call` together, atomically, the first time `.tool()` or
    `.registerTool()` is called — so anyone already following the
    documented instrument-before-registration rule for `tools/call`
    automatically satisfies it for `tools/list` too.
  - **Migration**: either reorder your `tools/list` registration to after
    `instrumentMcpServer()`, or pass `schemaDrift: { enabled: false }` to
    opt out and keep your existing registration order — both fully
    restore v0.7.0 behavior. There is no change if you don't use a
    low-level `Server` with an independently-registered `tools/list`
    handler.

## 0.7.0

Origin-aware failure classification for Agent Thrash Detection. Prompted by
external review (Reddit) pointing out that failure detection only read the
`isError` channel, missing JSON-RPC protocol-level failures. Verifying that
report surfaced a separate, more consequential finding: a real false
positive already live in every published version — output-validation
failures (a server-side bug) being counted as agent thrash. Full
investigation and design: ADR 007 (`docs/adr/007-protocol-error-channel.md`).

Also investigates a second external report (u/Pleasant-Ad192): whether a
different schema field failing validation each attempt (an agent
converging) can be told apart from the same field failing repeatedly (an
ambiguous tool schema). Finding: it mostly already can be, as a side
effect of how failures are fingerprinted — see ADR 009
(`docs/adr/009-field-level-convergence.md`) — now pinned down by
regression tests and a diagnostic span attribute, with one real gap
(partial convergence) still open pending a design decision.

Known gaps and open questions this release didn't close: `docs/known-gaps.md`.

### Fixed

- **Output-validation failures were miscategorized and incorrectly counted
  toward Agent Thrash Detection.** When a tool's own handler returned output
  that didn't match its declared output schema, the resulting failure
  (surfaced as `isError: true`, whether thrown directly or converted by the
  high-level `McpServer`) landed in fingerprint category `validation` or
  `internal` depending on the exact wording, and — since Agent Thrash
  Detection shipped in v0.6.0 — was tracked exactly like a normal
  business-logic failure. An agent retrying such a tool would eventually
  cross the default threshold and get flagged as "thrashing," even though
  the failure is entirely the tool author's bug: no argument the agent
  supplies can ever fix a server that never returns valid structured
  content. **Affected range: the miscategorization itself has been present
  since v0.4.0 (deep-failure fingerprinting); the false-positive thrash
  count has been present since v0.6.0 (Agent Thrash Detection), through the
  last published release, v0.6.1.** Fixed by classifying which *channel* a
  failure arrived on (see Added, below) and excluding the `protocol.output`
  channel from thrash detection entirely — not merely relabeling it.

### Added

- **`mcp.failure.channel` span attribute** — one of `execution` |
  `protocol.not_found` | `protocol.input` | `protocol.output` |
  `protocol.other` | `unknown`, classifying which channel a tools/call
  failure arrived on (`classifyFailureChannel()`,
  `src/fingerprint/classify/channel.js`). Additive: never part of
  `computeFingerprint()`'s hash input (see Unchanged, below) — deliberately
  a separate attribute from the pre-existing `mcp.failure.origin`, which
  means something different (`tool_error` \| `thrown` \| `transport`) and
  has been hashed since v0.4.0.
- **Per-channel Agent Thrash Detection thresholds**: `inputThreshold`
  (default `5`, higher than the base `threshold`) for the `protocol.input`
  channel — an agent retrying with different arguments after an
  input-validation failure may be genuinely converging, not thrashing —
  and `notFoundThreshold` (default `1`, an immediate flag) for
  `protocol.not_found` — retrying a tool name that doesn't exist is never
  convergence. Each independently overridable via its own env var
  (`OTEL_MCP_THRASH_INPUT_THRESHOLD` / `OTEL_MCP_THRASH_NOT_FOUND_THRESHOLD`),
  following the exact existing `OTEL_MCP_THRASH_*` pattern.
- `FailureChannel` type, exported from the package root alongside the
  existing `FailureCategory` / `FailureOrigin` types.
- For high-level `McpServer` users specifically: since `McpServer` converts
  most protocol-shaped failures (tool not found, disabled, input/output
  validation) to `isError: true` before this library ever sees a thrown
  error, `classifyFailureChannel()` also recovers the real channel from
  that disguised form by reading the `MCP error {code}: ` wrapper
  `McpError`'s constructor always applies, which `McpServer` preserves
  verbatim. Without this, `protocol.output`'s exclusion (the fix above)
  would only have applied to hand-rolled low-level `Server` apps, not to
  `McpServer` — see the README's "Agent Thrash Detection" section and ADR
  007's addendum for the full reachability picture and its limits.
- **`mcp.failure.validation_paths` span attribute** — which schema
  field(s) a Zod validation failure named, one dot-joined path per
  failing issue (e.g. `["email", "user.profile.age"]`), best-effort
  extracted from the same message text `classifyFailureChannel()` already
  reads (`extractValidationPaths()`,
  `src/fingerprint/classify/validation-paths.js`). Omitted entirely —
  never set to an empty array — when nothing confidently parseable was
  found. Span-only, permanently excluded from
  `METRIC_SAFE_ATTRIBUTES`: field/path names are bounded per tool but
  unbounded across every tool anyone registers, the same reasoning that
  already keeps `mcp.failure.fingerprint`/`signature`/`error_class` off
  metric labels. Full investigation and design: ADR 009
  (`docs/adr/009-field-level-convergence.md`).

### Unchanged

- **Fingerprints (`mcp.failure.fingerprint` and every other
  `FingerprintInputs` field) are byte-identical to v0.6.1 for the same
  inputs.** The new `channel` dimension is deliberately kept out of
  `computeFingerprint()`'s hash input (ADR 007) specifically so this
  release cannot change any consumer's existing `mcp.failure.fingerprint`
  values — a change there would silently break any alert or dashboard
  built on fingerprint identity. Verified, not just asserted: by extracting
  the actual, published `v0.6.1` git tag's `src/fingerprint/` tree via `git
  archive` into an isolated directory and running its `computeFingerprint()`
  directly, independent of this working tree, against six fixture inputs —
  see `test/fingerprint/compose.fixtures.test.js`. If you have alerts or
  dashboards keyed on `mcp.failure.fingerprint`, they keep working exactly
  as they did on v0.6.1, with no changes required on your end.
- **Field-level discrimination in Agent Thrash Detection is not a new
  capability — it already worked, as a side effect of fingerprinting the
  full Zod issues JSON, and was simply incidental until now.** A
  validation failure repeating on the *same* schema field across attempts
  already hashed to the *same* fingerprint (accumulating correctly toward
  `inputThreshold`), and a *different* field failing each attempt already
  hashed to a *different* fingerprint each time (never accumulating,
  matching a converging agent). Investigated and confirmed in ADR 009; now
  pinned down by regression tests
  (`test/fingerprint/field-level-convergence.test.js`) so a future Zod or
  SDK change that silently breaks it gets caught, rather than discovered
  as a production regression. One real gap remains open and is *not*
  fixed by this: partial convergence (fixing one of several failing
  fields changes the issues array's shape and breaks fingerprint
  continuity) — tracked in `docs/known-gaps.md`, pending a design ADR 009
  did not settle on.

### Documentation

- `docs/known-gaps.md` (new): five tracked gaps this release didn't close,
  each written as a ready-to-paste GitHub issue — field-level convergence
  tracking, partial convergence in field-level validation, the
  observation-liveness contract, the pre-handler parse-failure gap, and
  how client-side retry caps interact with
  detection thresholds.
- README's "Agent Thrash Detection" section now covers channel-aware
  thresholds, the `McpServer`-vs-low-level-`Server` reachability
  difference (with ADR 007's full table), the pre-handler parse-failure
  gap (deferred, not solved — closing it means revisiting ADR 001), and
  the forwarded-error collision risk as a named known limitation.
- README's "Failure Fingerprinting" section now documents
  `mcp.failure.validation_paths` and states plainly that field-level
  discrimination is a property of the fingerprint, not a separate
  detector — see ADR 009.

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
