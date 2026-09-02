# Changelog

## 0.14.0

Adds `errorRecording.redactor`: a host-supplied hook for content
`normalizeMessage()`/`parseAndNormalizeStack()` don't recognize — a
proprietary API key format, an internal account id shape, a customer name
in prose or in a multi-tenant stack frame path. Full design: ADR 020
(`docs/adr/020-redactor-hook.md`). Ships in the same release as the
0.13.1 fix/docs items below (0.13.1 itself was never tagged/published —
see that section's own note), but is a logically separate, purely
additive change from both of them; kept in its own section here rather
than folded into 0.13.1's for that reason.

### Added — `errorRecording.redactor` hook (ADR 020)

- New optional `errorRecording.redactor` field: a synchronous
  `(input: { message, stack }) => { message, stack }` function, consulted
  only under `mode: 'normalized'`, that runs on the raw, uncoerced
  `message`/`stack` — via the same coercion this library's own pipeline
  already uses — **before** `normalizeMessage()`/`parseAndNormalizeStack()`
  ever see them, never the reverse. This library's own scrubbing still
  runs second, over your redactor's output, as a defense-in-depth
  backstop.
- Configuring a redactor alongside `mode: 'full'` or `'none'` is accepted
  but never invoked — those two modes' entire meaning is "byte-identical,
  regardless of what else is configured" — and produces a one-time
  `diag.warn()` at `instrumentMcpServer()` setup naming the no-op, since
  forgetting to also flip `mode` is an easy, otherwise-silent
  misconfiguration.
- A redactor that throws, returns a non-string `message`, or returns a
  `stack` that's neither a string nor `undefined` falls back to
  `'none'`-equivalent span output for that one event — status set, no
  `exception` event — **never** to raw/unredacted content, plus a
  one-time, content-free `diag.warn()` naming the failure shape (never
  the message/stack content itself). The returned `message`/`stack` are
  also length-capped defensively before use (reusing
  `normalizeMessage()`'s existing 2048-character limit).
- **Never reaches `computeFingerprint()`'s hash input, in any
  configuration.** `mcp.failure.fingerprint`/`signature` are computed
  from the real, unmodified thrown error, identically whether or not a
  redactor is configured — a deliberate, non-negotiable design decision
  (ADR 020 Decision 3): the fingerprint is a SHA-256 hash, never a
  plaintext channel, so redacting it would buy no privacy while tying
  fingerprint stability to unversioned host code. Any existing dashboard
  filter or alert keyed on `mcp.failure.fingerprint` keeps working
  unchanged after adding a redactor.
- **Timing caveat, not just a telemetry one:** the redactor runs
  synchronously, inline, on the error path, before the span ends — there
  is no timeout, and JavaScript's single-threaded execution model means
  one can't be added without a `worker_threads`/`vm.Script` boundary this
  feature deliberately doesn't pay for. A slow redactor (catastrophic
  regex backtracking, an accidental blocking call) adds directly to that
  tool call's own response latency, not just to what shows up in traces.
  See the README's "The redactor hook" section, "Timing," for the full
  writeup, and ADR 020's own "Timing" section for why this is an accepted
  risk rather than a solved one.
- No environment-variable equivalent — a function can't be expressed as
  an `OTEL_MCP_*` string, same as `costTracking.extractor`/
  `thrashDetection`'s classifier-shaped options already are.
- New exported types `ErrorRecordingRedactor` and
  `ErrorRecordingRedactorFields` (`src/error-recording/types.d.ts`,
  re-exported from the package root) — a consumer can type a redactor
  function on its own, the same way `UsageExtractor`/`Classifier` already
  let a consumer type an extractor/classifier independently of the option
  object that carries it.
- Purely additive and default-off: a deployment that never sets
  `errorRecording.redactor` observes zero behavior change.

## 0.13.1

Never tagged or published as its own release — ships bundled into
0.14.0 above instead, since the redactor work started before this patch
went out the door. Kept as its own section here (rather than merged into
0.14.0's) because both items below are logically independent of the
redactor: one's a bug fix to existing `'normalized'`-mode behavior, the
other's a documentation-only correction, and neither has anything to do
with the new hook.

### Fixed — `'normalized'` mode dropped `exception.message`/status message for non-`Error` throws

- Before this fix, `recordThrownException()`'s `'normalized'` branch
  independently re-derived `message`/`stack` via a plain `err?.message`/
  `err?.stack` read — which silently returned `undefined` for a thrown
  **string** or a plain non-`Error` object (neither has a `.message`
  property the way a real `Error` instance does), while
  `computeFingerprint()`'s own, richer `coerceError()` correctly
  recognized those same shapes and still produced a real
  `mcp.failure.fingerprint`. Net effect: a thrown string or non-`Error`
  throw got real fingerprinting but a completely empty `exception.message`
  / status message on the span under `'normalized'` mode — same `err`,
  two independent readers, two different answers, silently.
- Fixed by extracting the shared `normalizeException()`/`coerceError()`
  pair into their own module (`src/fingerprint/normalize/exception.js`)
  and routing **both** `computeFingerprint()` and `recordThrownException()`
  through the same one computation for the same `err` — the span's
  exception content and the fingerprint's hashed inputs can no longer
  independently drift apart, by construction, not by convention. This is
  the same consolidation ADR 020 (the redactor's own design doc, above)
  repeatedly cites as precedent for keeping the fingerprint path
  structurally isolated from the span-writing path going forward.
- `'full'` and `'none'` modes were never affected — this bug was specific
  to `'normalized'` mode's own inline coercion.

### Documentation — `errorRecording.mode` scoping correction

- Clarified that `errorRecording.mode` controls only the span this
  library creates for the current `tools/call`/`tools/list` — it has no
  effect on exception content any other instrumentation in the same
  process (an APM agent, HTTP or framework auto-instrumentation, anything
  else wrapping the handler) independently records onto its own span for
  the same rethrown error. Since no mode mutates the original `err`, that
  raw content can still land in the same trace, one span up, regardless
  of mode — including `'none'`, which was previously worded in a way that
  could read as a trace-wide guarantee rather than a span-scoped one.
  Confirmed empirically (a real ambient context manager, an outer span
  recording the rethrown error, `InMemorySpanExporter`) — see
  `docs/known-gaps.md` entry 10's 2026-09-01 update for the full
  reproduction and reasoning. README's "Error recording" and "What this
  library records" sections updated accordingly. No code changed — the
  underlying behavior (and the exposure at the default `'full'` mode) was
  already accurate and unchanged; only the description of what
  `errorRecording.mode` scopes to was incomplete.

## 0.13.0

Closes the two open items from `docs/known-gaps.md` entry 10 (a
raw-content audit of every attribute/span event this package emits) that
needed a design decision before a fix — raw exception content on
`recordException`/`setStatus`, and an unvalidated tool-result model field
reaching `mcp.tool.model`/`gen_ai.response.model` — plus the two
lower-risk fixes from the same entry that didn't need one. Full design:
ADR 019 (`docs/adr/019-raw-content-on-spans.md`). See the README's new
"What this library records" and "Error recording" sections for the
operator-facing consequence of each.

### Added — `errorRecording.mode` config (ADR 019 Part 1)

- New top-level `errorRecording` option, sibling to `fingerprinting` /
  `costTracking` / `thrashDetection` / `schemaDrift`: `'full'` (default,
  byte-for-byte unchanged from every prior release —
  `recordException(err)` + `setStatus({ message: err.message })` with the
  raw error), `'normalized'` (reuses the existing
  `normalizeMessage()`/`parseAndNormalizeStack()` fingerprinting pipeline
  — no new scrubbing logic — to strip known-sensitive-shaped substrings
  from the message and the local `cwd` prefix from the stack, without
  mutating the original `err`, which both call sites still rethrow), or
  `'none'` (records neither — the same `setStatus({ code: ERROR })`
  no-message pattern already used for tool-level `isError: true`
  failures). Applies to both thrown-exception paths, `tools/call` and
  `tools/list`.
- New `OTEL_MCP_ERROR_RECORDING_MODE` env var — same
  option-then-env-then-default precedence, and the same silent fallback
  to the default on an unrecognized value, as every other `OTEL_MCP_*`
  config.
- `error.type`/`exception.type` (both read from `err.name`) are now
  capped at 128 characters unconditionally, in every mode — the same cap
  `mcp.failure.error_class` uses below, reusing its exported constant
  rather than a second, possibly-drifting copy.
- Default stays `'full'` for all of `0.x`; ADR 019 Part 1 records the
  intent to flip it to `'normalized'` at `1.0`, not before — not decided
  in this release.

### Added — `mcp.tool.model` / `gen_ai.response.model` validation (ADR 019 Part 2)

**This is new behavior that can change what a call reports, not just a
new diagnostic.** Before this release, a tool result's `model` field
reached the span completely unvalidated, whatever it was. If you have a
provider/deployment whose model identifiers use a character outside
`[A-Za-z0-9._:/@-]`, or that (implausibly, but possibly) exceed 256
characters, upgrading will make `mcp.tool.model`/`gen_ai.response.model`
disappear from those calls' spans and `mcp.tool.pricing_status` flip from
whatever it was to `"unknown"` — even for an otherwise-legitimate, real
model id. The allowlist was deliberately built generous (see below) and
verified against known provider conventions, but it's still new, and a
one-time `diag.warn()` names when this happens (shape only, never the
value) so it's discoverable rather than a silent metric/span change.

- A tool result's declared model field is now checked against a 256-
  character length cap and a `[A-Za-z0-9._:/@-]` allowlist — verified
  against every `DEFAULT_PRICING` key and `normalizeModelName()`'s
  documented `provider/model` input contract, deliberately generous —
  before it can reach `mcp.tool.model`, `gen_ai.response.model`,
  `calculateCost()`, or either metric label
  (`mcp.tool.tokens.total`/`mcp.tool.cost.total`).
- A rejected value is never a silent drop: `mcp.tool.pricing_status` is
  set to `"unknown"` (the same status a legitimately unrecognized model
  already produces), and a one-time `diag.warn()` fires per
  `instrumentMcpServer()` call, reporting shape only — length, and which
  check failed — never the rejected value itself.
- `budgetTracker.recordUnpriced()` now receives the validated (possibly
  `undefined`) model rather than the raw tool-result value, closing a
  second leak path through its own pre-existing warning that would
  otherwise have echoed a rejected value verbatim.
- `costTracking.pricing`/`pricingTable` override keys are unaffected —
  operator-authored config, never subject to this gate.

### Fixed — `mcp.failure.error_class` uncapped length, `mcp.failure.validation_paths` dynamic-key leak (known-gaps entry 10)

- `mcp.failure.error_class` is now capped at 128 characters
  (`fingerprint/compose.js`'s new `MAX_ERROR_CLASS_LENGTH`) — length-
  bounded only, not pattern-scrubbed; a non-string `.name` is coerced to
  a string before capping rather than thrown. ADR 004's note calling the
  underlying value "low-cardinality" is updated to flag that as an
  assumption, not an enforced property.
- `mcp.failure.validation_paths` format 1 (the raw Zod issues array, SDK
  ≤1.29.0) now redacts a non-identifier-shaped path segment — a
  `z.record()` schema's runtime key — to the placeholder `<KEY>` instead
  of surfacing it verbatim, matching the identifier-only gate formats 2/3
  already applied. Numeric (array-index) segments are never redacted.

## 0.12.0

Agent Thrash Detection gains a new, narrower session-identity fallback for
calls that carry no real session id but do carry a client-propagated W3C
trace context. This release also fixes two real bugs in the tail-sampling
recipe v0.8.0 introduced, and adds visibility for a silent budget-tracking
gap found during that same investigation. Full design for the fallback
tier: ADR 018 (`docs/adr/018-trace-id-as-thrash-fallback.md`).

### Added — trace id as a thrash-detection session-id fallback (ADR 018)

- **New tier in `resolveThrashSessionId()`** (`src/instrument.js`), reached
  only when no real session id has ever been observed on this server, and
  evaluated before the existing generated-UUID/skip fallback: if a
  `tools/call` request's span has a validly-extracted REMOTE parent — i.e.
  `request.params._meta` carried a valid W3C `traceparent` that
  `extractTraceContext()` (ADR 017) turned into a remote `SpanContext` —
  that parent's trace id is used as the session-id candidate for
  thrash-detection grouping. Gated on
  `trace.getSpanContext(parentContext)?.isRemote === true`, never on a
  span's own `traceId` read unconditionally — a root span's trace id is
  freshly, randomly generated on every call, and reading it unconditionally
  would have silently turned today's honest "skip, undetermined" into
  "always produce a session id that never matches the previous call's,"
  which is worse than skipping. See the ADR's "THE TRAP" for the full
  argument.
- Real `extra.sessionId` still wins unconditionally in every case
  (steps 1–2 of the resolution order untouched, byte for byte) — a trace
  id is only ever consulted for a call that has no real session id at all.
- Does **not** set `thrashSessionState.hasSeenRealSessionId` — that flag
  means "this transport hands out real session identity," a permanent
  per-server fact; a trace id being present on one call is a per-call fact
  about that one client's behavior, not proof about the transport.
- No new `diag.warn()` for this tier, deliberately — unlike the
  generated-UUID fallback (which warns because it's this library guessing
  an unproven assumption about transport topology), a trace-id candidate
  is real, client-supplied data with no operator action item to flag, and
  warning on every occurrence — potentially far more often than the
  once-per-server UUID warning — would just train operators to ignore this
  library's warnings generally.
- No changes to `ThrashDetector`/`thrash/detector.js` — its composite key
  already treats `sessionId` as opaque.

  **Read the constraint before assuming this closes stateless MCP's
  session gap.** This tier only fires when the calling *client* chooses to
  propagate trace context into `_meta.traceparent` — today, per ADR 018's
  investigation, that means third-party OTel instrumentation
  (`@arizeai/openinference-instrumentation-mcp` and equivalents) wrapping
  **v1-based** SDK clients, not either MCP SDK's own built-in behavior, and
  **no v2-targeting instrumentation was found to exist anywhere**. **This
  does NOT close `docs/known-gaps.md` entry 6's structural finding** — a
  v2/2026-07-28-native deployment whose client doesn't propagate
  `_meta.traceparent` (the default, unconfigured case for essentially
  every v2 client today) gets nothing new from this release: the exact
  same `null`/skip behavior as before. See the README's "Session id
  resolution" section and ADR 018's "Adoption caveat" for the full scope.

### Added — `mcp.tool.schema_drift_detected` span attribute

- New boolean span attribute, set alongside (never instead of) the
  existing `mcp.tool.schema_drift.detected` span event
  (`schema-drift/emitter.js`) — the same resolution ADR 011 already
  applied to thrash detection (`mcp.tool.thrash_detected`) for the
  identical event-vs-attribute ambiguity: whether a Collector
  `tailsamplingprocessor`'s `boolean_attribute` policy can match
  span-*event* data (as opposed to top-level span attributes) could not be
  confirmed either way (Go source, not installed in this repository). Only
  ever set to `true`, and only when drift was actually detected — never
  explicitly set `false`.

### Fixed — tail-sampling recipe referenced a non-existent span attribute

- The README's `tailsamplingprocessor` recipe recommended keying a
  `boolean_attribute` policy on `mcp.tool.schema_drift.detected` — but
  that string was only ever a span *event* name and a metric counter name
  (`schema-drift/attributes.js`), never passed to `span.setAttribute()`
  anywhere in this package. As documented, that policy could never have
  matched anything. Fixed by the new `mcp.tool.schema_drift_detected`
  attribute above.
- Also added a `string_attribute` policy on `mcp.tool.pricing_status =
  "unknown"` — v0.11.0's "confidently wrong zero" problem reappearing at
  the sampling layer: an unpriced call has real extracted token usage but
  no `mcp.tool.cost.usd`, indistinguishable from a genuinely free call to
  a numeric-threshold policy.
- Recipe YAML extracted to `docs/recipes/tail-sampling.yaml` (repo-only,
  not published — the same carve-out `dashboards/` already has), with a
  new cross-check test (`test/recipes/tail-sampling-attributes.test.js`)
  asserting every attribute a policy references is a real, exported
  constant AND actually passed to `span.setAttribute()` — the check that
  would have caught this bug automatically. The README now references the
  file instead of duplicating it, and states plainly that attribute
  *names* are cross-checked but Collector policy *behavior* itself has not
  been run end to end (no Docker/Collector available in this project's dev
  environment).
- `docs/known-gaps.md` entry 9 (new): an unpriced call never reaches
  `budgetTracker.recordAndCheck()`, so budget guardrails cannot trip on
  unpriced spend regardless of amount. The visibility half is fixed in
  this same release — see "Added" below — but the underlying accounting
  behavior is not; what should happen to an unpriced call's budget
  accounting is a real design question, deliberately left open.

### Added — visibility for unpriced spend against a configured budget (known-gaps entry 9)

- **Two new one-time `diag.warn()` diagnostics in `createBudgetTracker()`**
  (`src/cost/budget.js`), no behavior change and no new public surface:
  one fires at construction whenever `perSessionUsd`/`perToolUsd` is
  configured at all, stating plainly that unpriced calls won't count
  toward it; the other — a new `recordUnpriced(model)` method, called from
  `applyCostAttribution()`'s existing `costUsd === null` branch
  (`src/instrument.js`), the same branch that already sets
  `mcp.tool.pricing_status: "unknown"` — fires the first time an unpriced
  call under an active budget is actually observed, naming the model and
  which scope(s) are configured. Both no-op when no budget is configured;
  neither changes `BudgetCheckResult`'s shape or adds a span attribute.
- **Deliberately diagnostics only — no fallback pricing was added.**
  Making an unpriced call actually count toward a USD budget means
  inventing a number for it, and a wrong invented price is a *different*
  confidently-wrong number, not a fix — the same disease this warning
  exists to flag, one layer up. See `docs/known-gaps.md` entry 9's
  "Status update (v0.12.0)" for the full argument against building that
  now, and why it stays open as a future, ADR-gated decision rather than
  folded into this patch.
- Both warnings share the budget tracker's own existing
  once-per-tracker-instance granularity (`createBudgetTracker()`'s own
  docblock) — under the default (no `instanceKey`), a fresh-server-per-request
  deployment re-warns on every request for both, the same inherited-caveat
  shape `docs/known-gaps.md` entry 6 documents for the thrash fallback
  warning; a stable `instanceKey` shares one tracker, and one already-armed
  warning, across calls, same as every other registry-backed tracker.

## 0.11.0

**⚠️ Type change, not a runtime behavior change — read this first.**
`ModelPricing` is now a discriminated union
(`{pricingKind: 'chat', inputPer1M, outputPer1M, currency} |
{pricingKind: 'embedding', inputPer1M, currency}`) instead of a single
shape with both token fields always present. A TypeScript consumer with
an existing custom `pricingTable`/`pricing` object typed against the old
shape will see a compile error requiring `pricingKind` on each entry.
**Runtime behavior for those same objects is unchanged**: `calculateCost()`
treats a missing or unrecognized `pricingKind` as `'chat'`, exactly the
behavior every pre-v0.11.0 entry already had. See ADR 016
(`docs/adr/016-pricing-override-and-staleness.md`) point 1.

### Added — Pricing table override and staleness signalling (Phase 1 of 2)

`DEFAULT_PRICING` had the same disease this whole library exists to fix
elsewhere: a hardcoded snapshot with no signal when it's wrong or stale.
This release closes that. Full design: ADR 016
(`docs/adr/016-pricing-override-and-staleness.md`).

- **Embedding model support.** `DEFAULT_PRICING` gains OpenAI
  `text-embedding-3-small`/`text-embedding-3-large`/`text-embedding-ada-002`,
  Cohere `cohere-embed-v3`, and Bedrock `amazon-titan-embed-v2`.
  Embeddings are input-token-only — rather than modeling that as
  `outputPer1M: 0` (indistinguishable from a data-entry bug), a new
  `pricingKind: 'chat' | 'embedding'` discriminator makes it explicit; an
  `'embedding'` entry has no `outputPer1M` field at all, and
  `calculateCost()` never reads `outputTokens` for one (still validated as
  a non-negative finite number, just never charged for).
- **`costTracking.pricing`: per-model merge over defaults.** New option,
  a *partial* pricing table merged per-model OVER `pricingTable ??
  DEFAULT_PRICING` — each key you supply replaces that model's entire
  pricing entry, every model you don't name is untouched. This is now the
  recommended way to correct a stale price or add a model
  `DEFAULT_PRICING` doesn't know about, without spreading the whole
  default table by hand (the old workaround the README used to teach).
  `costTracking.pricingTable` keeps its existing full-replace behavior,
  unchanged, for the narrower "I want only my own models" case — see ADR
  016 point 2 for why both exist.
- **`mcp.tool.pricing_status` span + metric attribute.** One of `"known"`
  | `"unknown"` | `"user_override"`, set whenever token usage was
  extracted at all — even with no model detected (`"unknown"` in that
  case), unlike the existing model/cost attributes. Added to the
  `mcp.tool.tokens.total` / `mcp.tool.cost.total` metrics too, so a
  dashboard can compute "% of tokens/spend unpriced" as a direct
  aggregation instead of inferring it from missing data. Provenance-based:
  `"user_override"` means the model's key came from your
  `pricing`/`pricingTable`, regardless of whether the numbers you supplied
  happen to match `DEFAULT_PRICING`'s own entry.
- **Staleness signalling.** `DEFAULT_PRICING_LAST_VERIFIED` (also
  exported) names the table's last-checked date; once it's more than 90
  days old, `instrumentMcpServer()` fires a one-time `diag.warn()`, and,
  when `setupNodeSdk: true`, also attaches an
  `mcp.pricing.default_table_last_verified` resource attribute. Both only
  fire when `DEFAULT_PRICING` is actually contributing to the effective
  table — a caller who fully replaced it via `pricingTable` isn't using
  our defaults, so a warning about them would be misleading.
  `isDefaultPricingStale(now?, thresholdDays?)` (also exported) is the
  pure function behind the warning, for callers who want to check it
  themselves.
- **Bedrock region caveat, documented not modeled.** Bedrock pricing
  varies by region; `DEFAULT_PRICING`'s Bedrock entries (Nova, and the new
  Titan embedding entry) assume us-east-1 list price and the table is not
  region-keyed — no tool-result usage shape this package recognizes
  carries a region signal to key a lookup on. Documented loudly in the
  README and in `pricing.js`; override via `costTracking.pricing` for a
  different region. See ADR 016 point 5.
- `calculateCost()` gained defensive validation for malformed pricing
  entries (missing/negative/non-numeric `inputPer1M`/`outputPer1M`),
  since `pricing`/`pricingTable` now make it reachable with
  caller-supplied shapes it previously never had to distrust — degrades
  to `null`, same as an unknown model, never throws.

### Added — W3C Trace Context propagation over MCP `_meta` (Phase 2 of 2, server-side only)

The most-complained-about gap in agent observability: an agent's own
trace (LangGraph or otherwise) and the MCP server's trace for the tool
call it made were always two disconnected traces, with no edge between
them. Full design, including the sampling and conflicting-context
decisions below: ADR 017 (`docs/adr/017-trace-context-propagation.md`).

- **`tools/call` requests carrying a valid W3C `traceparent` in
  `params._meta` now become a child of the calling agent's own span**,
  joining what were two disconnected traces into one — under both MCP v1
  and v2, with zero configuration and no new option. `tracestate` is
  propagated too, when present. Works for any client already emitting
  `traceparent` via a standard OTel SDK's `propagation.inject()` in any
  language — this isn't Node/JS-specific on the client side, only on
  which side of the wire this release implements.
- **The upstream sampling decision is honored automatically, by
  construction, with no sampling logic written for this feature**: the
  extracted `SpanContext` is marked `isRemote: true` with the real parsed
  `traceFlags`, which is exactly what the SDK's own default
  `ParentBasedSampler` already keys its remote-parent decision off of. A
  not-sampled upstream `traceparent` means this tool-call span is not
  recorded or exported, matching the calling agent's own choice — see the
  ADR's "Sampling" section for why forcing sampling regardless was
  considered and rejected.
- **A `_meta`-extracted context always replaces, never merges with, an
  already-active local context** (e.g. an ambient HTTP-server span from
  auto-instrumentation on a Streamable HTTP transport) — the message-level
  `_meta` context is the semantically correct parent for one tool call,
  full stop, regardless of what transport-level span it happened to
  arrive inside. See the ADR's "Conflicting `_meta.traceparent`" section.
- **Absent, malformed, or unparseable `_meta`/`traceparent` produces
  behavior that is byte-identical to pre-v0.11.0** — not merely
  equivalent to it: confirmed by reading both `NoopTracer` and the real
  SDK `Tracer`'s own `startActiveSpan()` fallback (`ctx ?? context.active()`),
  which is exactly what this feature's `extractTraceContext()` returns
  for every case that isn't a valid `traceparent`. No `diag.warn()` for
  the common "client doesn't send `_meta.traceparent`" case — see the
  ADR's "no warn spam" constraint.
- **Zero new dependencies.** `@opentelemetry/core`'s
  `W3CTraceContextPropagator` was the obvious reference implementation
  and was deliberately not taken as a dependency, per
  `CONTRIBUTING.md`'s "no new dependencies without discussion first" —
  everything needed except the traceparent regex itself (~10 lines,
  matching `@opentelemetry/core`'s own validation field-for-field) was
  already available from `@opentelemetry/api`, already a peer dependency
  — including `createTraceState()`, a fully spec-validated `tracestate`
  parser. Full reasoning: ADR 017's "No new dependency" section.
- **Server-side extraction only.** The client-side shim that would let a
  Node/Python agent framework *set* `_meta.traceparent` on outgoing calls
  is explicitly out of scope for this phase — extraction is independently
  useful today, for free, to any client whose own tooling already sets
  `_meta` in this shape. Tracked as future work, not implied as solved.

Also fixed in this release: two places (`index.d.ts`'s
`instrumentMcpServer()` docblock, and this file's own v0.10.0 entry
below) still described `docs/known-gaps.md` entries 6/7/8 using language
that read as still-open, or as scoped out of v0.10.0 — both were stale.
Entries 7 and 8 have been fully fixed since v0.10.0 with no open caveats;
entry 6's fallback-session-id half is fixed too, narrowed to a smaller,
genuinely-still-open remainder (see the corrected v0.10.0 entry below and
`index.d.ts`'s updated docblock for the accurate, current accounting).

## 0.10.0

**⚠️ Behavior change, unrelated to the feature below — read this first.**
`instrumentMcpServer()` now throws for a server object it cannot
confidently wrap, instead of silently instrumenting nothing.
`detectServerKind()` (`src/instrument.js`) previously accepted any
`McpServer`-shaped object whose `.server` merely *had* a
`setRequestHandler` method — it now additionally requires `.server
instanceof <Server>` for a real, recognized SDK class. An object that
satisfies the outer shape but fails that check now throws a new,
specific error (`UNWRAPPABLE_MCPSERVER_ERROR` — names what was detected
and the plausible causes: a duplicate/mismatched SDK install, an SDK not
resolvable from this package's own location, or an unsupported SDK) at
`instrumentMcpServer()` call time, rather than succeeding and producing
zero telemetry. This closes a confirmed gap (`docs/known-gaps.md` entry
7, now marked fixed): an `@modelcontextprotocol/server` (MCP v2) object
passed to a pre-0.10.0 `instrumentMcpServer()` satisfied the old, looser
check and appeared to instrument successfully — `getThrashSummary`/
`getObservationState` attached, no error — while producing zero spans,
zero metrics, and zero fingerprinting for every tool call. No escape
hatch was added; see ADR 015 (`docs/adr/015-mcp-v2-support.md`) for the
full argument against one. **If you're seeing this new error on upgrade**
and you believe your object genuinely is a real `Server`/`McpServer`
instance, check for a duplicate/mismatched install of whichever SDK it
came from (`npm dedupe`, or check for multiple installed copies) — a real
v1 or v2 `Server`/`McpServer` from a single, consistently-resolved SDK
install is unaffected by this change.

### Added — `@modelcontextprotocol/server` (MCP v2, protocol revision 2026-07-28) support

Both the original `@modelcontextprotocol/sdk` ("v1") and the new
`@modelcontextprotocol/server` ("v2") now work with `instrumentMcpServer()`
— two separate, OPTIONAL peer dependencies (install whichever one(s) you
actually use; `package.json`'s `peerDependenciesMeta` marks both
`optional: true`, verified against real, clean external installs with
only one, the other, or neither installed — not just `package.json`
syntax). Same `Server`/`McpServer` API shapes as v1; detection and
wrapping happen automatically, resolved once per `instrumentMcpServer()`
call by which SDK the object actually came from. Full design and
Phase-by-phase implementation notes: ADR 015
(`docs/adr/015-mcp-v2-support.md`).

What works the same as v1: spans, standard attributes (including
`jsonrpc.request.id`, now read from v2's `ctx.mcpReq.id`), deep failure
fingerprinting, and `mcp.failure.channel`/`mcp.failure.validation_paths`
classification (`channel.js`/`validation-paths.js` both gained a
v2-specific code path — the "MCP error N:" wrapper v1 disguises errors
with doesn't exist in v2, and v2's rendered validation-issue text uses a
third, distinct format from either of v1's two).

**v2's own `createMcpHandler`/`serveStdio` construct a fresh `Server`/
`McpServer` per request by default (a factory function you provide), not
once at process start.** `instrumentMcpServer()` needs to run *inside*
that factory, on every invocation — see the README's new "MCP v2 support"
section for a worked example. `instanceKey` (v0.9.0) is the existing
mechanism for sharing tracker state across those repeated calls; nothing
new was added for this, since ADR 012's original design already covers
this exact deployment shape, v2 just makes it the default instead of an
edge case.

**Correction (recorded here rather than silently edited): both gaps below
were actually closed in this same v0.10.0 release, not left open.** The
paragraph originally here said entries 6 and 8 (`docs/known-gaps.md`)
were scoped out of this round — true of the round that produced the text
above, not of what actually shipped. A follow-up investigation, completed
before v0.10.0 was cut, folded both fixes back in: `isSingleConnectionTransport()`
no longer misclassifies the transport `createMcpHandler` builds internally
(entry 8 — fully fixed: v2 now requires positive confirmation,
`transport.constructor.name === 'StdioServerTransport'`, instead of
inferring single-connection from an absent `sessionId` property), and
Agent Thrash Detection's fallback session id is now registry-backed via
`instanceKey` (entry 6's fallback-id gap — fixed: repeated
`instrumentMcpServer()` calls sharing an `instanceKey` now reuse the same
generated id instead of a fresh one per call). Both fixes shipped in the
same commit, in a specific order — fixing detection (entry 8) before
sharing the fallback id (entry 6) — since sharing it first would have made
entry 8's false positive worse, not better.

**What remains genuinely open, narrower than either original gap:**
`thrashSessionState` (whether a server has ever proven itself
session-aware) still isn't registry-backed, and — structurally, not a
bug this library can fix — MCP spec 2026-07-28 removes protocol-level
sessions entirely, so no configuration of this library can produce a
*real* session id for a spec-2026-07-28-native deployment in the first
place. See ADR 015's final "Update ... Findings 3 and 8 landed here too"
section and `docs/known-gaps.md` entries 6 and 8 for the full accounting.

## 0.9.0

**⚠️ Fixed, with a fingerprint behavior change — read this before the
feature below.** The `auth` failure classifier
(`src/fingerprint/classify/auth.js`) missed "permission denied" and
"access denied" — the standard phrasing from Unix, git, AWS IAM, and GCP
for a permission/authorization failure. It only recognized
HTTP-status-derived wording (`unauthorized`, `forbidden`,
`authenticat(e|ion)`) plus 401/403 status codes and a handful of known
auth-library error names. Messages using the OS/CLI phrasing above fell
through every classifier and landed in the `internal` catch-all instead.
Found by running realistic error text through this project's own UI demo
(`packages/ui/demo/populate.js`) and checking what `DEFAULT_CLASSIFIERS`
actually returned for it — not assumed. Now also matches "not authorized",
"permission(s) denied", "access denied", "insufficient permission(s)", and
Node's own `EACCES`/`EPERM` error codes; still does not match bare
"authorized" or "permission" alone (see the classifier's own docblock for
the false-positive cases this deliberately excludes, e.g. "user denied the
permission request").

**This changes fingerprints for affected messages.** `category` is one of
the hashed inputs `computeFingerprint()` combines into
`mcp.failure.fingerprint` (see ADR 006). A permission-denied failure that
previously classified as `internal` now classifies as `auth` — the fields
feeding the hash change, so the fingerprint itself changes for anyone whose
tool emits this wording. This does **not** amend the closed 8-category
taxonomy ADR 006 established (`validation | timeout | network | auth |
dependency | serialization | internal | unknown`) — `auth` already existed;
this is a pattern-coverage fix to when the existing category fires, not a
new category. If you alert or dashboard on a specific `mcp.failure.fingerprint`
value for a permission error, expect a new value after upgrading.

### Added — `instanceKey`: sharing tracker state across `instrumentMcpServer()` calls

`instanceKey` (a string option on `instrumentMcpServer()`, or the
`OTEL_MCP_INSTANCE_KEY` env var — lower precedence than the option) lets
repeated `instrumentMcpServer()` calls that pass the same key share Agent
Thrash Detection, budget tracking, schema drift detection, and the
`ToolOutcome` counter's state, instead of each call constructing all four
fresh and discarding them. Fixes the gap documented in the README's
"In-memory tracker state is scoped to one `instrumentMcpServer()` call"
section and `docs/known-gaps.md` entry 6, under a "stateless" Streamable
HTTP deployment shape (a fresh `Server`/`McpServer` re-instrumented on
every incoming request). Full design: ADR 012
(`docs/adr/012-tracker-lifecycle-and-shared-state.md`).

Backed by an internal, bounded, TTL-evicting registry (1000 distinct keys
per process, 24h TTL renewed on every use — both ADR 012's proposed
defaults) — fully internal, no new public type. Omit `instanceKey` (the
default) for behavior byte-identical to every prior version: trackers are
constructed fresh on every call, and the registry is never touched.

**⚠️ Composition requirement: `instanceKey` alone does not fix Agent
Thrash Detection.** `ThrashDetector` looks episodes up by `(sessionId,
toolName, fingerprint)` — `instanceKey` shares the tracker object, but
without a real, transport-provided `extra.sessionId` on every call, each
`instrumentMcpServer()` call still generates its own random per-connection
fallback session id, fresh, regardless of `instanceKey`. Sharing the
tracker doesn't help if the lookup key inside it differs every call —
each request lands as its own one-off episode instead of contributing to
one shared loop. Real Streamable HTTP transports provide a real session id
automatically, so the common case works with `instanceKey` alone — but a
custom `Transport`, `assumeSingleSession: true`, or anything else on the
generated-fallback path will set `instanceKey`, see nothing happen, and
have every reason to think the fix is broken. Same silent-inertness shape
as the original gap, one layer deeper. See the README's new "instanceKey"
section for the full explanation and what to do about it — this is not a
footnote there either.

**⚠️ Does not help across process boundaries.** `instanceKey`'s registry
is one process's in-memory state. On Lambda, Cloud Run, or any
horizontally-scaled deployment, concurrent/recycled instances each hold
their own independent registry — passing the identical `instanceKey`
string everywhere does not change that. Counters remain instance-local and
best-effort by design; this is a structural limitation, not a
configuration gap, and this library deliberately does not add an external
store (Redis/DynamoDB) to close it — see ADR 012's Update section for the
full reasoning.

**Documentation:** the "Metrics" section now covers wiring the Prometheus
exporter specifically (`@opentelemetry/exporter-prometheus`), not just the
OTLP example that was already there. Its pull-based text exposition format
does not attach resource attributes (including `service.name`) to
individual metric points by default — only to a separate `target_info`
series — which is invisible with one service but means every series looks
identical the moment you're scraping more than one instrumented server
into the same Prometheus. Documents the fix
(`withResourceConstantLabels: /^service\.name$/`) with a worked example.
No code change; this behavior was always there, just undocumented. Found
building `dashboards/grafana-mcp-health.json`'s verification harness.

## 0.8.0

Three features. **Tool schema drift detection**: a server that silently
changes a tool's `inputSchema` between deployments — a parameter renamed, a
type tightened, a `required` field added — currently breaks agents with no
signal pointing at the actual cause. Full investigation and design: ADR 010
(`docs/adr/010-schema-drift.md`). **Two-axis observation contract**:
prompted by external review (Massimiliano Brighindi), who first raised that
`instrumentMcpServer()` with no `TracerProvider`/`MeterProvider` registered
silently no-ops — a failed tool call in that state produces zero telemetry,
indistinguishable from one that never failed — and then supplied the reframe
that shaped what shipped: not "detect a broken pipeline," but "stop implying
health by omission." Full investigation and design: ADR 008
(`docs/adr/008-observation-liveness.md`, "Update (2026-08-05)" section).
**Cost-aware trace sampling**: investigated whether traces that were
expensive or thrashed could be kept regardless of the head sampler's
decision. Found that this cannot be an in-process library feature — a
`Sampler` decides at span start, cost/thrash are only known at span end, and
this package doesn't own the `Sampler`/`SpanProcessor` chain in its default
configuration anyway. Ships a marker attribute plus a documented Collector
recipe instead of a sampler. Full investigation and design: ADR 011
(`docs/adr/011-cost-aware-sampling.md`).

**⚠️ Read "Changed — behavior change on upgrade" immediately below before
updating.** One of the three features above changes when
`instrumentMcpServer()` throws, for a subset of low-level `Server` users,
purely from the new default-on config — no code change of your own
required to hit it.

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
  - Only `schemaDrift` (schema drift detection, below) causes this — the
    two-axis observation contract and cost-aware sampling features in this
    same release are purely additive, with no effect on when
    `instrumentMcpServer()` throws.

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

### Added — Two-axis observation contract

- **`getObservationState()`**, a new accessor attached to the object
  `instrumentMcpServer()` returns — unconditional (not gated behind
  `setupNodeSdk`), same additive pattern as `shutdown()`/`getThrashSummary()`,
  omitted entirely when `options.enabled` is `false`. Returns:
  ```
  {
    toolOutcome: { success, failure, unknown },
    observationIntegrity: 'DEGRADED' | 'UNKNOWN',
  }
  ```
  No OTel emission — purely in-process, nothing sent anywhere, safe to
  call from application code (a health-check endpoint, a periodic
  `console.log`, a debugger). See the README's "Two-axis observation
  contract" section for the full design rationale.
  - **`toolOutcome`**: cumulative tool-call outcome counts since
    instrumentation, from a **new counter that increments on every tool
    call unconditionally** — independent of `fingerprinting`,
    `thrashDetection`, and `enableMetrics`. Deliberately NOT read off
    `ThrashDetector`/`getThrashSummary()`: that bookkeeping only runs
    when a fingerprint was computed, so with `fingerprinting: false` (a
    fully supported configuration) it would silently report zero
    failures regardless of how many actually occurred — the exact
    silent-success failure mode this feature exists to close. A
    malformed, unrecognizable tool result (not a real `CallToolResult`
    shape) increments `unknown` rather than silently defaulting to
    `success`.
  - **`observationIntegrity`**: `'DEGRADED' | 'UNKNOWN'` — note there is
    no `'HEALTHY'` value, and this is not an oversight. Investigated and
    found structurally unreachable in every configuration: the one lead
    (OTel SDK self-observability metrics) is a write-only `Counter` with
    no synchronous read-back API in `@opentelemetry/api`, so this
    library's own code can never positively confirm telemetry is
    flowing, no matter how it's wired up. `HEALTHY` is therefore absent
    from the type entirely, not merely never returned — enforced by
    TypeScript, not just documentation (see the new type-level tests in
    `test/index.exports.test-d.ts`).
    - `DEGRADED` is detected via a fragile `ProxyTracerProvider`
      reference-equality check, and is reachable **only** under
      `setupNodeSdk: false` (the default) — when no `TracerProvider` has
      been registered globally at all.
    - Under `setupNodeSdk: true`, this library registers the provider
      itself, so absence can never be confirmed — `observationIntegrity`
      is **always** `'UNKNOWN'` in that configuration, without even
      attempting the check.
    - Recomputed fresh on **every call** to `getObservationState()`,
      never cached from instrument time — a host may register a
      `TracerProvider` asynchronously after `instrumentMcpServer()`
      already ran, and a value cached at startup would go stale the
      moment that happens.
  - `ToolOutcome`, `ToolOutcomeCounts`, `ObservationIntegrity`,
    `ObservationState` types, exported from the package root.

### Added — Cost-aware trace sampling (marker attribute + Collector recipe)

- **`mcp.tool.thrash_detected`, a new boolean span attribute**, set
  alongside (never instead of) the existing `mcp.loop.detected` span
  event, in the same `thrash/emitter.js` call site — set only when
  `thrashDetection` is enabled and a loop was actually detected on this
  call, same reachability as the existing event, no new failure mode.
  Exists specifically so an OpenTelemetry Collector's
  `tailsamplingprocessor` has an unambiguous, attribute-level signal to
  key on: whether a `boolean_attribute` policy can also match span-*event*
  data was investigated and left genuinely unverified (the processor is
  Go source in a separate repository, not installed here), so this
  attribute removes that uncertainty entirely rather than leaving tail
  sampling dependent on an unconfirmed answer. **Named deliberately
  differently** from the pre-existing `mcp.tool.loop.detected` **metric**
  counter, not reusing its string as ADR 011 originally specified — see
  that ADR's "Update" note. A metric name and a span attribute key are
  unrelated OTel namespaces with no technical conflict, but reusing the
  name left the one reader who most needs it to be unambiguous — someone
  writing a Collector tail-sampling policy — unable to tell, from the
  name alone, which of the two same-named signals they were keying on.
- **No new cost-threshold attribute or config.** `mcp.tool.cost.usd` and
  `mcp.tool.cost.budget_exceeded` (both already shipped, v0.5.0) already
  fully suffice for a Collector `numeric_attribute` / `boolean_attribute`
  policy — the numeric threshold itself lives entirely in the
  Collector's own policy config (the YAML), not in this package's
  `InstrumentOptions`. No new env var, no new `instrumentMcpServer()`
  option.
- **A documented, pasteable OpenTelemetry Collector `tailsamplingprocessor`
  config** (README's "Cost-aware trace sampling" section) keeping any
  trace with an expensive call, a budget-exceeded call, or a detected
  thrash loop, alongside an ordinary probabilistic sample for everything
  else.
- **No in-process sampler or buffering `SpanProcessor` was built, and none
  is planned** — investigated and rejected on two independent grounds
  (ADR 011): this package doesn't own the `Sampler`/`SpanProcessor` chain
  in its default configuration (no public API to inject either into a
  host-owned `TracerProvider`), and even where a custom processor could
  theoretically be installed, an in-process decision can only ever rescue
  the one span this package itself creates — never an already-finished
  child span from other instrumentation, never an upstream span in a
  different process. "Keep the trace" is not achievable in-process; at
  best, "keep this one span" is, which is a materially smaller guarantee
  than the stated goal. Real cross-span, cross-process trace buffering is
  what the Collector's `tailsamplingprocessor` already does correctly —
  not something to partially re-implement inside this package.

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
