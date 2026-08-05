# ADR 011: Cost-aware sampling

**Status:** Proposed — investigation only, no implementation. Second of
three features scoped for v0.8.0. Same discipline as ADR 010: findings
checked against the installed `@opentelemetry/sdk-trace` (`2.9.0`, the
real package `@opentelemetry/sdk-trace-base@2.9.0` re-exports from —
confirmed by reading `sdk-trace-base`'s own `index-shim.js`, not assumed)
and `@modelcontextprotocol/sdk@1.29.0`, ending in a recommendation rather
than shipped code.

## Context

Goal as stated: keep traces that exceed a cost threshold or contain a
thrash event, *regardless of the sampler's decision*. The premise to
settle first: OTel's `Sampler` decides at span **start**; cost
(`mcp.tool.cost.usd`) and thrash (`mcp.loop.detected`) are only known at
span **end**, after the tool handler has actually run. A head-based
`Sampler`, by construction, cannot see either.

## Findings

### 1. The core constraint, confirmed against the installed SDK

`Sampler.shouldSample(context, traceId, spanName, spanKind, attributes,
links)` (`Sampler.d.ts:51-69`) receives only pre-call inputs — parent
context, trace/span identifiers, the span's initial attributes, links.
No result, no duration, no cost, no thrash state is passed or passable;
none of it exists yet.

`Tracer.startSpan()` calls this synchronously, before the `Span` object
is constructed:

```
const samplingResult = this._sampler.shouldSample(context, traceId, name, spanKind, attributes, links);
...
const traceFlags = samplingResult.decision === api.SamplingDecision.RECORD_AND_SAMPLED
    ? api.TraceFlags.SAMPLED
    : api.TraceFlags.NONE;
const spanContext = { traceId, spanId, traceFlags, traceState };
```

(`Tracer.js:75-81`). `traceFlags` is captured into `spanContext` once,
here, and this exact object is what `SpanImpl` stores and returns from
every later `span.spanContext()` call (`Span.js:48,74-75`) — there is no
mutation path afterward. If the decision was `NOT_RECORD`,
`Tracer.startSpan()` returns a lightweight non-recording span wrapper
directly (`Tracer.js:82-86`) and **never touches the configured
`SpanProcessor` at all** — no `onStart`, no `onEnd`, ever, for that span.
The constraint as stated in the brief is confirmed exactly: a head
`Sampler` cannot express "keep this if it turns out to be expensive,"
because the entire concept of "turns out" happens after this method has
already returned and already produced an immutable decision.

### 2. Is tail sampling achievable in-process, or Collector-only?

**A closely related but sharper finding settles this before the buffering
question even needs to be asked: this package does not, in its default
configuration, own the two components (`Sampler`, `SpanProcessor` chain)
that any in-process tail-sampling design would need to control.**

`setupTracer()`'s final line, reached whenever `options.setupNodeSdk` is
false (the default, and the configuration ADR 001/003/008 all treat as
the primary supported mode — "never override the host application's own
OpenTelemetry setup"), is:

```
return trace.getTracer('opentel-mcp', PACKAGE_VERSION);
```

(`instrument.js:287`) — this asks whatever `TracerProvider` the host has
already globally registered for a `Tracer`. The `Sampler` and the
`SpanProcessor` pipeline are both properties of *that* provider, fixed at
its construction, entirely outside `instrumentMcpServer()`'s reach.
Confirmed directly against the installed SDK's public surface:

```
export declare class TracerProvider implements ApiTracerProvider {
    private readonly _resource;
    private readonly _activeSpanProcessor;
    ...
    getTracer(...): ApiTracer;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
}
```

(`TracerProvider.d.ts` — the full public method list). No
`addSpanProcessor`, no sampler-replacement hook, nothing past
construction time. `_activeSpanProcessor` is assigned exactly once, in
the constructor (`TracerProvider.js:33`,
`this._activeSpanProcessor = new MultiSpanProcessor(spanProcessors)`),
from an options object passed in at `new NodeTracerProvider({...})`
time — not something any later caller, including this library, can
append to or swap out.

Even the `setupNodeSdk: true` path — where opentel-mcp *does* construct
its own provider (`instrument.js:274-278`) — doesn't change this
ownership finding's relevance, since that path already runs with the
SDK's default sampler (no `sampler` option is passed at all,
`instrument.js:274-277`), which already records and samples everything;
it isn't the path that would need a new tail-decision mechanism, and it
covers the minority of real deployments by this package's own documented
default.

**Consequence:** even setting the head/tail timing problem aside
entirely, there is today no way for `instrumentMcpServer()` — a function
that receives an already-constructed MCP `Server`, not a `TracerProvider`
— to install a custom `Sampler` or a custom `SpanProcessor` onto a
host-owned, already-registered `TracerProvider`. Building this in-process
in the general case would require asking every host application to
change how *they* construct their OTel SDK (pass a specific `Sampler`,
register a specific `SpanProcessor`) — a fundamentally bigger, more
invasive ask than `instrumentMcpServer(server, options)`, and precisely
the class of intervention ADR 001 and ADR 008 both already ruled out for
much smaller asks (ADR 008 rejected claiming `setGlobalErrorHandler()` on
exactly this "don't touch the host's global OTel state" principle).

**Genuine tail sampling — buffering a whole trace across a wait window,
scoring it, then keeping or dropping the complete set — is what the
Collector's `tailsamplingprocessor` exists to do, out-of-process, with
policies (`numeric_attribute`, `boolean_attribute`, `latency`,
`status_code`, `probabilistic`, and composites of these — from public
OTel Collector Contrib documentation; not verified against installed
code in this repo, since that processor is a separate Go binary/config
artifact with no npm package here to inspect).** If this feature needs
real cross-span, cross-process trace buffering, that already exists,
already handles the hard parts (wait-window sizing, per-trace span
accumulation, decision policies), and is the correct place for it — not
something to partially reimplement inside an npm package that doesn't
even control the SDK components the reimplementation would need.

### 3. Any in-process path? SpanProcessor buffering, deferred sampling, and trace integrity

Setting the ownership problem aside for a moment, to answer the question
on its own terms: **for the one span this package itself creates**, a
custom-`SpanProcessor`-at-`onEnd` design is structurally sound, if it
could be installed at all.

- Both stock processors already show the shape needed: `onEnd(span:
  ReadableSpan)` receives the fully populated span — attributes, events,
  status, duration all set — *before* checking whether to export it.
  Confirmed in this exact installed version: `SimpleSpanProcessor.onEnd`
  and `BatchSpanProcessorBase.onEnd` both do
  `if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;`
  as their very first check (`SimpleSpanProcessor.js:38-44`, same
  pattern at `BatchSpanProcessorBase.js:56` — the constructor comment at
  `SimpleSpanProcessor.js:13` states this plainly: "Only spans that are
  sampled are converted"). **A `RECORD`-but-not-`SAMPLED` span is
  therefore silently dropped by both of this SDK's own built-in
  processors before ever reaching an exporter** — a custom processor,
  without that traceFlags check, is required to see it at all.
- This package's own attribute-setting order makes the data available in
  time, when it does apply: `applyCostAttribution()` sets
  `ATTR_MCP_TOOL_COST_USD` on the span (`instrument.js:368`) and
  `createThrashEmitter().emit()` adds the `mcp.loop.detected` event
  (`thrash/emitter.js:106`) — both calls happen inside
  `wrapToolCallHandler`'s try block, well before `finally { span.end();
  }` (`instrument.js:838-839`). By the time a hypothetical custom
  processor's `onEnd` ran, the `ReadableSpan` it received would already
  carry both signals. This is the one piece of this investigation that
  comes back genuinely favorable — *if* the processor could be installed.
- **What happens to parent/child consistency if a child is kept but its
  parent was dropped — investigated honestly, not glossed over:**
  `wrapToolCallHandler` creates exactly one span per `tools/call`
  (`instrument.js:678`, a single `tracer.startActiveSpan` call, no
  further nested spans anywhere in this function) — so there is no
  *internal* parent/child relationship this package itself could break.
  But the feature's stated goal is "keep **traces**," not "keep this one
  span," and two real cases exist where that one span is not the whole
  story:
  - A tool handler's own business logic can call out to something else
    auto-instrumented (an HTTP client, a DB driver) — producing a genuine
    child span of the `tools/call` span, created and ended *before* the
    parent's own cost/thrash signal is known (children finish before
    their parent in normal control flow). If the head `Sampler` already
    decided `NOT_RECORD` for the parent, the child's own sampling
    decision (under the standard `ParentBasedSampler` essentially every
    real deployment uses) inherits that "not sampled" parent context and
    is dropped too, independently, before the parent's cost is ever
    computed. There is nothing to retroactively "un-drop."
  - The `tools/call` span may itself be a **child of an upstream, cross-
    process span** — an inbound HTTP request already carrying a
    `traceparent` from whatever called the MCP server. That upstream
    span's own export-or-drop decision was made, and acted on, by a
    different process entirely, one this library has no handle to, no
    visibility into, and — even with unlimited engineering effort inside
    this package — no way to retroactively resurrect.

  **Honest answer: trace integrity does not survive an in-process "decide
  at my own onEnd" design, for anything beyond the single span this
  package directly controls.** A design that only ever rescues that one
  span (never its ancestors, never its already-finished descendants) is
  achievable in principle; a design that rescues "the trace" as the goal
  actually states is not, without either (a) force-recording every span
  in every in-flight trace regardless of sampler decision — which this
  package cannot even instruct the Sampler to do, per Q2 — or (b) real
  cross-span buffering, which is Q4 below and which still cannot reach
  spans in other processes.

### 4. Buffering bounds, if attempted anyway

**The specific goal — flag a call whose own cost exceeds a threshold, or
whose own thrash event fired — needs no cross-span buffering at all**,
because both signals are self-contained on the one span that carries
them (Q3 above). This is a materially easier problem than a real tail
sampler's, and it's worth being precise about why: a Collector's
`tailsamplingprocessor` must buffer *because* the spans making up one
trace arrive asynchronously, out of order, from multiple independent
services over the network, and it can't know a trace is "complete"
without a wait-window heuristic. Nothing about that applies to "is this
one already-finished span's own cost attribute over a threshold" — that
question is answerable the instant the span ends, using only the span
itself.

**Whole-trace rescue (the goal as literally stated) is the different,
harder problem**, and *that* would need real buffering: every span
belonging to an open trace held in memory, keyed by `traceId`, until
some decisive span in that trace ends and a keep/drop verdict can be
reached, then the whole buffered set flushed or discarded together. Sized
against what this package already has precedent for:

- `BoundedTtlMap` (`thrash/store.js`) bounds a **count of sessions**
  (`maxSize` entries, each a small fixed-shape thrash-tracking record)
  with lazy TTL eviction, explicitly designed around "a long-lived stdio
  server runs for weeks, so anything keyed by session id needs a hard cap
  and no live timer" (`store.js:1-12`).
- A trace buffer would need to bound **(open traces) × (spans per
  trace)**, where each buffered item is a **full `ReadableSpan`** — name,
  attributes, events, links, status, timings — not a small fixed record
  like a thrash entry. It would also need a fundamentally different
  eviction trigger than TTL-since-last-access: a trace's "done" signal is
  "the decisive span ended," not "nobody touched this key in N minutes,"
  so `BoundedTtlMap`'s existing eviction model doesn't transfer cleanly —
  this would need new machinery, not a reuse of the existing store.
- For a long-running stdio server specifically (one process, unbounded
  lifetime, per ADR 010's Q4 framing of the same constraint), an
  unbounded or loosely-bounded per-trace span buffer is exactly the
  failure mode `BoundedTtlMap` was built to prevent for thrash
  state — except here the per-entry cost is an entire span's worth of
  data, not a handful of counters, making the memory-pressure math
  considerably worse per buffered unit.

This is before even reaching the Q2 ownership problem (nowhere to install
the processor that would hold this buffer) or the Q3 finding (it still
can't rescue other processes' spans). Buffering is achievable as an
engineering exercise; it is not a small one, and it would end up
re-deriving a narrower, less battle-tested version of what the
Collector's `tailsamplingprocessor` already does correctly.

### 5. THE LIKELY MIDDLE PATH — marking, assessed against what's already emitted

**Checked directly against the current codebase: most of what this needs
is already emitted, today, with zero new code.**

- `mcp.tool.cost.usd` is already a plain numeric span attribute
  (`ATTR_MCP_TOOL_COST_USD`, set at `instrument.js:368`) — a Collector
  `numeric_attribute` policy can threshold on it exactly as-is.
- `mcp.tool.cost.budget_exceeded` is already a boolean span attribute
  (`instrument.js:374`, set when `budgetTracker.recordAndCheck()`
  reports a configured cumulative budget was crossed) — a
  `boolean_attribute` policy target, also as-is.
- The one gap: agent-thrash detection is currently a **span event**, not
  a span attribute — `mcp.loop.detected`
  (`SPAN_EVENT_NAME_LOOP_DETECTED`, `thrash/attributes.js:20`), added via
  `span.addEvent(...)` in `thrash/emitter.js:106`, gated on
  `span.isRecording()` at `emitter.js:104`. Whether Collector tail-
  sampling policies can match on span-event data (as opposed to span-
  level attributes) is genuinely not something this investigation can
  confirm — the `tailsamplingprocessor` is Go source in a separate
  repository, not installed here, and the honest answer is "unverified,"
  not a guess in either direction.

**Given that uncertainty, the safe, additive fix is small and has direct
precedent in this codebase**: add one new boolean span attribute (e.g.
`mcp.tool.loop.detected`, set alongside — not instead of — the existing
`mcp.loop.detected` event, the same call site in `thrash/emitter.js`'s
`emit()`) so a thrash-carrying span is matchable by *any* attribute-based
mechanism — a Collector `boolean_attribute` policy, or, for the
`setupNodeSdk: true` path specifically, a simple custom in-process
`onEnd` filter that only needs to exist within a provider this package
already owns. This mirrors the exact pattern ADR 007 (`mcp.failure.channel`,
additive alongside `origin`) and ADR 009 (`mcp.failure.validation_paths`,
additive alongside the fingerprint) already established: add a new,
independently-checkable signal rather than overload or replace an
existing one.

**Is marking, on its own, sufficient?** For the stated goal — give a
downstream tail-sampling policy something to key on — yes, and two of the
three signals needed already exist; the third is a one-attribute
addition with a clear, precedented shape. What marking does *not* do,
and cannot do from inside this package, is the actual buffering/decision
logic — that remains the Collector's `tailsamplingprocessor`'s job (or,
narrowly, a host-installed custom processor in the `setupNodeSdk: true`
path). Marking is the correct scope of what a library can responsibly own
here; the decision logic belongs to whatever owns the `Sampler`/
`SpanProcessor` chain, which, per Q2, is essentially never this package.

## Decision

**Do not build in-process tail sampling.** Two independent findings each
individually rule it out, and together leave no path:

1. **Ownership (Q2):** in this package's own default, documented,
   ADR-001-aligned configuration, it does not control the `Sampler` or
   the `SpanProcessor` chain at all — both belong to the host's
   `TracerProvider`, with no public API (confirmed against the installed
   SDK's `.d.ts`) to inject either after construction.
2. **Trace integrity (Q3):** even where a custom processor could
   theoretically be installed, an in-process decision can only ever
   rescue the one span this package itself creates — never an already-
   finished child from other instrumentation, never an upstream span in
   a different process. "Keep the trace" is not achievable; at best,
   "keep this one span" is.

Buffering (Q4) is a real, non-trivial memory/design cost that would only
be worth paying if 1 and 2 weren't already disqualifying — it isn't
separately why this is rejected, it's additional evidence for the same
conclusion.

**Ship the marking half (Q5) as a small, additive library change**, and
**document Collector-based tail sampling as a recipe, not a feature**:

- Add `mcp.tool.loop.detected` (boolean span attribute) alongside the
  existing `mcp.loop.detected` span event, in `thrash/emitter.js`'s
  `emit()`, following the exact additive-attribute precedent ADR 007/009
  already set.
- `mcp.tool.cost.usd` and `mcp.tool.cost.budget_exceeded` need no changes
  — already present, already sufficient for a Collector policy.
- Document a `tailsamplingprocessor` config recipe (README or a
  `docs/recipes/` entry) showing `numeric_attribute` on
  `mcp.tool.cost.usd`, `boolean_attribute` on
  `mcp.tool.cost.budget_exceeded`, and `boolean_attribute` on the new
  `mcp.tool.loop.detected`, composed with `and`/`or` per the operator's
  needs — explicitly labeled as an external Collector configuration this
  package enables but does not implement or ship.

## Constraints accepted

- The new `mcp.tool.loop.detected` attribute is set only when
  `thrashConfig.enabled` and a loop was actually detected on this call —
  same reachability as the existing span event, no new failure mode.
- This ADR cannot verify Collector `tailsamplingprocessor` policy
  compatibility with span-event data from this repository (no Go source
  installed here) — stated as an open, unverified question rather than
  answered either way. The additive-attribute fix is recommended
  specifically because it doesn't depend on that answer.
- The `setupNodeSdk: true` path is technically capable of a custom-
  processor, single-span, in-process filter (this package does own that
  provider), but this ADR does not recommend building one: it would cover
  a minority configuration, duplicate what the attribute-marking + a
  Collector recipe already achieves for the common case, and reintroduce
  exactly the "keep this one span, not the trace" scope limit from Q3
  with no offsetting benefit over the Collector-recipe path.
- "Cost threshold" as used here covers both readings available today: a
  single call's raw cost (`mcp.tool.cost.usd`, threshold applied by
  whatever policy reads it) and the existing cumulative,
  session/tool-scoped budget concept (`mcp.tool.cost.budget_exceeded`,
  ADR-preceding v0.5.0 feature). Neither needed a new decision in this
  ADR; both were already-shipped, sufficient signals once identified.

## Alternatives rejected

- **A custom `SpanProcessor` installed by `instrumentMcpServer()` onto
  the host's `TracerProvider`.** Rejected — no public API exists to do
  this post-construction (Q2); would require asking every host
  application to change their own OTel SDK setup to accommodate this
  package, which is the exact class of intervention ADR 001 and ADR 008
  already ruled out for smaller asks.
- **Requiring `setupNodeSdk: true` (this package's own provider) as a
  precondition for cost-aware sampling.** Rejected as the general
  solution — it would make a documented-as-optional configuration knob
  a hard requirement for this feature, silently degrading to nothing for
  the majority, default-configured deployments this package's own README
  treats as primary.
- **Re-implementing per-trace span buffering in-process** (a lightweight
  `tailsamplingprocessor` equivalent). Rejected — Q4 shows this is a
  materially heavier mechanism than anything this package has needed so
  far, disqualified anyway by Q2's ownership finding and Q3's
  cross-process integrity limit, and would duplicate a tool
  (`tailsamplingprocessor`) that already exists, is already
  battle-tested, and already runs where it can actually see every span
  in a trace regardless of which process produced it.
- **Folding `mcp.tool.loop.detected` into the existing span event instead
  of adding a parallel attribute.** Rejected — span events are not
  guaranteed to be inspectable by every downstream consumer (Collector
  policies, third-party backends) the same way top-level span attributes
  are; the additive attribute costs one line and removes the ambiguity
  entirely, the same reasoning ADR 009 used for
  `mcp.failure.validation_paths`.

## Consequences

- This package gains one new, small, additive span attribute
  (`mcp.tool.loop.detected`) and a documented Collector recipe; it does
  not gain a sampling feature of its own, and should not claim one in the
  README beyond "here's how to wire up cost/thrash-aware tail sampling in
  your Collector."
- Operators who want cost-aware trace retention must run a Collector
  with `tailsamplingprocessor` (or an equivalent backend-side mechanism)
  in front of their trace backend — this is a deployment-topology
  requirement this ADR surfaces plainly rather than implies is optional.
- If a future SDK version adds a public, stable
  `TracerProvider.addSpanProcessor()`-equivalent, or a documented way to
  layer a `Sampler` decorator onto an already-registered provider, the
  ownership finding in Q2 would need re-checking — this ADR's "do not
  build in-process" conclusion is conditional on the installed SDK's
  current public surface, stated as such, not a permanent architectural
  ruling independent of upstream changes.
