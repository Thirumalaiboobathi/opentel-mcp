# ADR 017: Trace context propagation over MCP `_meta`

**Status:** Accepted — implemented in v0.11.0 (Phase 2 of 2). Server-side
extraction only; the client-side shim that would let a Node/Python agent
framework *set* `_meta.traceparent` in the first place is explicitly out
of scope for this phase — see "Forward-compat" below.

## Context

The most-complained-about gap in agent observability, restated precisely:
a LangGraph (or any other framework's) agent calls a tool on a Node MCP
server; the agent's own trace — showing its reasoning, retries, and this
tool call as one step among several — and the server's trace — showing
what the tool actually did — are two disconnected traces with no edge
between them. An operator debugging a slow or failing agent run has to
manually correlate timestamps across two separate trace backends (or two
separate services in the same backend) instead of seeing one trace.

The MCP spec's `_meta` field (present on every request's `params`, both
SDKs' schemas confirmed as `z.looseObject`/`z.record` — arbitrary keys
pass through unvalidated-but-unstripped) is the only spec-sanctioned
extension point available on a `tools/call` request. Nothing about MCP
itself carries trace context; this ADR is about using `_meta` to carry
one specific, already-standardized format through it.

## Decision

### Why W3C `traceparent`, not a custom key

Three reasons, in order of how much they actually mattered to the
decision:

1. **It's the format every serious client-side agent framework already
   emits internally.** OpenTelemetry's own auto-instrumentation for
   Python/Node HTTP clients, and every OTel-instrumented agent framework
   (LangGraph included, via `opentelemetry-instrumentation-langchain` and
   similar), already produces a `traceparent` string the moment a span is
   active — `propagation.inject()` in whatever language, same wire
   format, same two header names (`traceparent`, `tracestate`). A custom
   key would mean asking every client author to translate from the
   format their own OTel SDK already produces into opentel-mcp's
   bespoke shape — friction with no offsetting benefit.
2. **It's a real IETF/W3C Recommendation
   ([w3.org/TR/trace-context](https://www.w3.org/TR/trace-context/)),
   not an OpenTelemetry-specific convention** — so this works for a
   Python agent on any OTel-compatible SDK, not just a Node one, and
   continues to work if the ecosystem's tracing backend of choice
   changes. Using a spec artifact instead of inventing one matches this
   codebase's own established preference (see ADR 004: aligning to the
   OTel GenAI MCP semantic conventions even at Development status,
   rather than shipping opentel-mcp-only attribute names, wherever a
   real spec already exists to align to).
3. **The parsing/validation rules are already correctly solved, publicly
   specified, and — per the "no new dependency" decision below —
   available for free from `@opentelemetry/api`, a package this library
   already depends on as a peer.** A custom key would mean inventing
   *and documenting* a new wire format with no existing implementation
   anywhere to lean on.

### `_meta.traceparent` / `_meta.tracestate` — flat keys, not namespaced

MCP's `_meta` convention (see the spec's guidance on reverse-DNS-prefixed
keys, e.g. `io.modelcontextprotocol/related-task`) exists to avoid
collisions between unrelated extensions sharing one flat namespace.
Deliberately not followed here: `traceparent`/`tracestate` are the W3C
spec's own header names, already globally namespaced by the spec that
owns them (nobody else standardizes a field with that exact name for an
unrelated purpose), and using them unprefixed means a client bridging
"I already have a `traceparent` string from my own OTel SDK" to "put it
in MCP `_meta`" is a **direct copy**, not a translation. A prefixed key
(e.g. `io.opentelemetry/traceparent`) would need documenting on both the
client and server side for zero collision-avoidance benefit, since the
underlying string is already a namespaced W3C artifact by construction.

### No new dependency — `@opentelemetry/core`'s `W3CTraceContextPropagator`
considered and not taken

`@opentelemetry/core` ships `W3CTraceContextPropagator`, the obvious
reference implementation, and is *already* resolvable today (a transitive
dependency of `@opentelemetry/sdk-trace-node`/`@opentelemetry/resources`,
both already direct dependencies, same `2.9.x` line). Promoting it to a
direct dependency was seriously considered — it would mean zero
duplicated logic and automatic pickup of any future spec fixes. **Not
taken**, per `CONTRIBUTING.md`'s explicit "No new dependencies without
discussion first — this project targets zero native dependencies and a
minimal, audited dependency tree" — and this ADR *is* that discussion,
recorded for whoever revisits this decision later, not a decision made
silently.

What actually made this an easy call, not just a rule followed
mechanically: everything needed except the traceparent regex itself is
**already exported from `@opentelemetry/api`**, a peer dependency this
package already requires:

- `isValidTraceId`/`isValidSpanId`/`isSpanContextValid` — validity checks.
- `TraceFlags`, `trace.setSpanContext()` — building/attaching the
  extracted `SpanContext`.
- `createTraceState(rawString): TraceState` — a **fully spec-validated
  tracestate parser**, confirmed by reading its implementation
  (`@opentelemetry/api`'s `trace/internal/tracestate-impl.js`): enforces
  the 512-char total length cap and the 32-entry cap, validates each
  `key=value` pair, silently drops malformed entries rather than
  throwing. This is the one piece that would have been genuinely
  error-prone to hand-roll (vendor-key format rules, the `@`-scoped
  tenant-key syntax, the "duplicate keys" rule) — and it's already free.

The only piece actually written for this feature is the `traceparent`
regex/parse function — ~10 lines, matching `@opentelemetry/core`'s own
`parseTraceParent()` field-for-field (confirmed by reading its source
directly, not from memory): version/trace-id/parent-id/flags as
2/32/16/2 lowercase hex chars, trace-id and parent-id each rejected if
all-zero, version `ff` rejected, and — the one genuinely non-obvious rule
— a version-`00` traceparent with trailing dash-separated garbage is
rejected, but a **higher version number** tolerates and ignores trailing
fields, per the spec's own forward-compatibility clause. Getting this
exactly right by copying the reference implementation's validated regex,
rather than approximating it, is a correctness requirement (getting it
subtly wrong either silently drops valid context from a real, spec-
compliant client, or accepts something a real backend would consider
malformed), not a style preference.

**Net effect: this feature ships with zero new dependencies.**

### Conflicting `_meta.traceparent` and an already-active local context

Two related questions, same answer: **the extracted `_meta` context
always wins — it replaces whatever `SpanContext` was already active, it
is never merged with it.**

- **If `_meta` carries a valid `traceparent` and there is *also* an
  ambient active context** (most plausibly: the host has HTTP-layer
  auto-instrumentation — e.g. `@opentelemetry/instrumentation-http` —
  producing a server span for the incoming POST *before* this package's
  JSON-RPC handler runs, under a Streamable HTTP transport), the tool
  span's parent becomes the `_meta`-derived remote context, full stop.
  The ambient HTTP-request span becomes an unrelated sibling/cousin in
  whatever trace it belongs to, not an ancestor of the tool span.
- **This is correct, not merely convenient**, once the actual semantics
  are considered: an HTTP POST to a Streamable HTTP MCP endpoint is a
  *transport-level* unit (one HTTP request can, in principle, carry more
  than one JSON-RPC message), while `_meta.traceparent` is a
  *message-level* declaration of which logical agent operation this
  specific tool call belongs to. The message-level context is the
  semantically correct parent for "this one tool call finished," not the
  transport envelope it happened to arrive in.
- **No code decides this "which wins" question explicitly — it falls out
  of how context propagation already works.** `Context` holds exactly one
  current `SpanContext`; `W3CTraceContextPropagator`-equivalent
  extraction (this feature's `extractTraceContext()`) either overwrites
  it (valid `traceparent` found) or returns the input `Context` completely
  unchanged (nothing valid found). There is no third state to build for
  "found something, but merge it somehow with what was already there" —
  a span has exactly one parent.
- **Different trace family (different `trace-id`) is the identical case,
  not a separate one.** "Different trace-id" and "any active local
  context at all" are the same scenario from this code's point of view:
  extraction either replaces the whole `SpanContext` (trace-id, span-id,
  flags, state together) or it doesn't touch anything. There is no
  partial-replace where the trace-id changes but the local context's
  flags or state survive.

### Sampling: the upstream `sampled` flag is honored, and no code makes
that decision

Confirmed directly against the installed `@opentelemetry/sdk-trace-base`/
`@opentelemetry/sdk-trace`, not assumed: the default `Sampler` — used
whenever `OTEL_TRACES_SAMPLER` is unset, which includes this package's
own `setupNodeSdk: true` path (`NodeTracerProvider` is constructed there
with no `sampler` option, so it falls back to `buildSamplerFromEnv()`'s
default) — is `ParentBasedSampler({ root: AlwaysOnSampler })`.
`ParentBasedSampler.shouldSample()`'s own logic:

```js
if (parentContext.isRemote) {
  if (parentContext.traceFlags & TraceFlags.SAMPLED) {
    return this._remoteParentSampled.shouldSample(...);   // default: AlwaysOnSampler
  }
  return this._remoteParentNotSampled.shouldSample(...);  // default: AlwaysOffSampler
}
```

Setting `isRemote: true` and the real `traceFlags` parsed from the
incoming `traceparent`'s flags byte on the extracted `SpanContext` — which
this feature does, unconditionally, whenever a valid `traceparent` is
found — is **already sufficient** for the upstream sampling decision to
be honored by the SDK's own default Sampler. No sampling logic is written
in this feature; there is nothing to write.

**Deliberately not forcing "always sample," considered and rejected:** an
alternative would force-sample every tool-call span regardless of the
upstream flag, on the theory that server-side visibility into which
tools ran is independently valuable even when the calling agent doesn't
want its own trace kept. Rejected for two reasons: (1) it would produce
partial, orphaned-looking trace fragments — spans on the server side with
no matching upstream spans in whatever backend the agent's trace lives
in, since the agent's own SDK genuinely dropped its side — arguably worse
for the "one connected trace" goal than not linking at all; (2)
overriding the Sampler's decision would mean this package installing or
mutating a `Sampler`, which ADR 011 already investigated and rejected as
outside what a library instrumenting one function call can or should do
to a host-owned `TracerProvider` — this ADR doesn't reopen that
question, it reapplies the same conclusion to a new case.

This also mirrors, deliberately, the exact trust model every OTel HTTP
server auto-instrumentation already uses: an internet-facing HTTP server
extracts `traceparent` from a fully untrusted client header,
unconditionally, by default, today — a client asserting an arbitrary
trace-id or an arbitrary sampling preference is an accepted, well-
understood characteristic of distributed tracing, not a vulnerability
specific to MCP. No additional server-side trust check is added here
beyond what every other OTel-instrumented server already omits.

### Untrusted input handling

`_meta` arrives as JSON-RPC request data — validated by each SDK's own
`RequestMetaSchema` (`z.looseObject`/`z.record`) *before* this package's
wrapped handler ever runs, meaning by the time `extractTraceContext()`
sees it, it is already guaranteed to be `undefined` or a genuine plain
object, never a string/array/number that slipped through. **This code
does not rely on that guarantee holding** — per the explicit constraint
to treat `_meta` as untrusted input, `extractTraceContext()` re-validates
independently (a `typeof`/`Array.isArray` plain-object check on `meta`
itself, then a `typeof` check on `meta.traceparent`/`meta.tracestate`
before ever handing them to the parser), the same two-layer discipline
(validate-before-parsing, plus a catch-all try/catch) already established
by `cost/extractor.js`'s `defaultExtractor()` and `cost/budget.js`'s
`accumulate()` for the identical class of "don't trust another layer's
guarantee to hold forever" reasoning. The whole function body is one
try/catch, for the same reason `applyCostAttribution()`'s already is:
the parsing itself (a plain regex match plus `createTraceState()`, both
already defensive) is not expected to throw, but `trace.setSpanContext()`
and this package's own bugs are outside that guarantee, and a cost/
tracecontext bug must never be why a tool call fails.

**Absent, malformed, or unparseable `_meta`/`traceparent` → the function
returns its `baseContext` argument completely unchanged.** Passed as the
4-arg `startActiveSpan(name, options, context, fn)` context parameter,
this is **not merely equivalent to, but literally byte-identical to**
today's 3-arg call: confirmed by reading both `NoopTracer` and the real
SDK `Tracer`'s `startActiveSpan()` — the 3-arg form's own internal
fallback is `ctx ?? context.active()`. No new code path exists for the
"nothing to extract" case; it's the same code path as before this
feature existed.

### Scope: `tools/call` only, not `tools/list`

`_meta` extraction is wired into `wrapToolCallHandler()` only. Schema
drift's `wrapToolsListHandler()` (ADR 010) is untouched — `tools/list` is
a capability-discovery call, not a unit of agent work an upstream trace
would meaningfully want to claim as a child; there's no `_meta` in a
`tools/list` request's params shape to extract from in any client this
investigation is aware of, and no motivating gap (unlike `tools/call`,
`tools/list` was never named in the "disconnected traces" complaint this
ADR addresses).

## Constraints accepted

- **Never-throw holds.** `extractTraceContext()`'s only observable
  failure mode, for any malformed/hostile input, is returning
  `baseContext` unchanged — the same value it would have returned for
  genuinely absent `_meta`.
- **No `diag.warn()` spam for malformed `_meta`** — silence is the
  correct signal here, not a diagnostic: an MCP client that doesn't send
  `_meta.traceparent` at all (the overwhelming common case until client
  shims exist) is not a misconfiguration, it's the expected default.
  Warning on every call would be exactly the "warn spam" the constraint
  explicitly rules out. (Contrast the Phase-1 pricing-staleness warning,
  which fires for a genuine, actionable misconfiguration signal, not
  merely "a feature wasn't used.") A `diag.debug()` fires on the
  actually-unexpected path — an exception during extraction — mirroring
  `defaultExtractor()`'s identical choice for the identical reason.
- **Works under both MCP v1 and v2 peer deps, unconditionally — no
  `kind`-specific branching needed.** Confirmed directly against both
  installed SDKs' schemas: `_meta` lives at `request.params._meta` in
  both, unlike `sessionId`/`requestId` (ADR 015 Finding 3/7), which
  genuinely differ in shape between the two and do need `kind`-aware
  extraction.
- **No new dependency, no new config option.** This feature is
  unconditional — there is no `traceContext: { enabled: false }`
  escape hatch, deliberately: with the "absent/malformed → identical to
  today" guarantee holding, there is no behavior for an operator to want
  to turn off. A client that never sets `_meta.traceparent` sees zero
  change of any kind.

## Alternatives rejected

- **A custom `opentel-mcp`-specific `_meta` key** (e.g. `mcpTraceContext:
  { traceId, spanId, sampled }`). Rejected — see "Why W3C traceparent"
  above; would require every client author to translate from the format
  their own OTel SDK already emits, for a library-specific format with no
  ecosystem reach beyond this one package.
- **Depending on `@opentelemetry/core` for `W3CTraceContextPropagator`.**
  Seriously considered, not taken — see "No new dependency" above.
  Revisit if a second, independent need for `@opentelemetry/core` ever
  arises elsewhere in this codebase (none exists today), at which point
  the "already effectively free" argument would strengthen further.
- **Forcing `RECORD_AND_SAMPLED` regardless of the upstream flag.**
  Rejected — see "Sampling" above; produces orphaned trace fragments and
  requires overriding Sampler behavior this package has already,
  separately (ADR 011), decided it does not own.
- **Merging the extracted remote context with an already-active local
  one** (e.g., keeping the local trace-id but attaching the remote
  span-id as a link instead of a parent). Rejected — a `Span` has exactly
  one parent `SpanContext`; "merge" isn't a real state to build toward,
  only a link (a separate, additive OTel primitive `startActiveSpan`'s
  `options.links` could carry) — and adding a link for the discarded
  local context wasn't asked for by this phase's scope and would be a
  separate, later decision if a real gap motivates it.
- **Wiring extraction into `tools/list` too, for symmetry.** Rejected —
  see "Scope" above; no `_meta` convention exists there in practice and
  no gap motivates it.

## Forward-compat: OTel semconv for MCP, and the deferred client shim

The OTel GenAI SIG's MCP semantic conventions (ADR 004's subject) are
still Development status and, as of this writing, take no position on
trace-context-over-`_meta` at all — there is no competing or
complementary spec-defined attribute/key this ADR needs to reconcile
with today. If upstream lands a differently-named `_meta` key, or a
different propagation mechanism (e.g. a dedicated MCP transport-level
header instead of an application-level `_meta` field) before this
package's next relevant release, the piece that changes is narrow and
already isolated: `extractTraceContext()`'s carrier-key names
(`traceparent`/`tracestate`) and where it's called from
(`request.params._meta`) — the actual W3C-parsing logic and the
sampling/conflict-resolution decisions recorded in this ADR would carry
over unchanged, since those are properties of the W3C spec and of OTel's
own `Sampler`/`Context` model, not of MCP's specific carrying mechanism.

**Deliberately not built this phase: the client-side shim** — a small
helper a Python/Node agent framework would call to *inject* its own
active span's `traceparent`/`tracestate` into outgoing `tools/call`
params before this server-side extraction has anything to read. Explicit
scope boundary from the brief, restated here for the record: server-side
extraction is independently useful *today*, for free, to any client whose
own tooling already happens to set `_meta` in this shape (a growing but
not yet universal population) — shipping that value now, rather than
gating it behind a client shim that would itself need its own design
pass (Node vs. Python API surface, which agent frameworks to
target first, whether it ships in this package or a companion one) is
the reason this is Phase 2 of 2 and not a single combined release.

## Consequences

- Any MCP client that already sets `_meta.traceparent` — including any
  client instrumented via `propagation.inject()` from a standard OTel SDK
  in any language — gets its tool-call spans joined into its own trace
  the moment it upgrades to a server running this version, with zero
  server-side configuration.
- A client that doesn't set `_meta.traceparent` (today's overwhelming
  majority) sees no change of any kind — confirmed byte-identical, not
  merely "should behave the same."
- The next piece of this gap — giving Node/Python agent clients an easy
  way to actually *set* `_meta.traceparent` — remains open, tracked as
  future work, not silently implied as "solved" by this ADR's server-side
  half.
