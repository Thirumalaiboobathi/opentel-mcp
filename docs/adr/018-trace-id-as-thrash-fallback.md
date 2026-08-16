# ADR 018: Trace id as a thrash-detection fallback identity source

**Status:** Proposed — design only, no implementation. Supersedes ADR 012's
"Trace id. Dead end." rejection (`docs/adr/012-tracker-lifecycle-and-shared-state.md`,
"Other identity sources checked, and rejected or deferred" — that ADR now
carries an appended note pointing here rather than being edited in place,
matching this repo's own convention of appending corrections rather than
rewriting history).

**Found by:** a direct reassessment requested after ADR 017 shipped,
checking whether ADR 012's original two-sided rejection still held now
that one side had changed — not an external report.

## Context

ADR 012's original finding, quoted exactly rather than paraphrased:

> **Trace id.** Dead end. The v2 SDK defines `traceparent`/`tracestate`/
> `baggage` `_meta` keys (SEP-414) as a documented convention, but nothing
> in the compiled client or server implementation reads or writes them —
> and this library extracts nothing from incoming context today either.
> Two independent gaps, neither closable by fixing only one side.

Phase 2 (ADR 017, `docs/adr/017-trace-context-propagation.md`) closed one
of those two gaps: `instrumentMcpServer()` now extracts a valid W3C
`traceparent` from `request.params._meta` and parents the tool-call span
to it. That leaves exactly the question ADR 012's own wording anticipated
without answering: is the *other* side — a real client actually writing
`traceparent` into `_meta` — still hypothetical, or has that changed too?
This ADR is the direct reassessment, checked against the ecosystem rather
than assumed either way, and — since the answer turned out to be "real,
but narrower than a first glance suggests" — a design (not yet an
implementation) for what using it would actually look like.

## Findings: what changed since the rejection, and why it's now viable

**Nothing changed inside the MCP SDKs themselves.** Re-checked directly
against the currently installed `@modelcontextprotocol/server@2.0.0` /
`@modelcontextprotocol/core@2.0.0`, the same way ADR 012 did: `TRACEPARENT_META_KEY`
/ `TRACESTATE_META_KEY` / `BAGGAGE_META_KEY` are now re-exported from the
*public* entrypoint (previously only reachable via `/internal`), but
grepping the compiled runtime for actual use of those constants — not
just their export — found zero matches. The SDK still only *names* the
convention. ADR 012's finding on the SDK's own behavior stands, unchanged.

**What changed is the ecosystem around the SDKs, checked directly, not
inferred from the spec alone:**

- **SEP-414 itself reached Final status** (it was presumably still
  in-flight or newer at ADR 012's 2026-08-11 writing). Its reference
  implementation list, read from the spec page directly: C# SDK, Python
  SDK (a PR — see the caveat below, this one does *not* hold up), **OpenInference
  MCP instrumentation for both Python and TypeScript**, Envoy AI Gateway,
  Logfire, ToolHive.
- **A real, working TypeScript implementation**, read from source, not
  summarized: `@arizeai/openinference-instrumentation-mcp` patches
  `Transport.send()`/`start()` on `@modelcontextprotocol/sdk`'s
  `client/{sse,stdio,streamableHttp}.js`:
  ```ts
  propagation.inject(context.active(), message.params._meta);
  ```
  on every outgoing JSON-RPC *request* (checked for `method` + `id`,
  which excludes notifications but includes every `tools/call`), and the
  structural mirror — `propagation.extract()` + `context.with()` — on the
  server transport's receive path.
- **The same pattern, independently, in Python**, also read from source:
  ```python
  meta = request.params.setdefault("_meta", {})
  propagate.get_global_textmap().inject(meta)
  ```
- **A third, independent confirmation of the specific granularity
  question this ADR needs answered** — see below — in a real, maintained
  example repository (`langfuse/langfuse-examples`, `applications/mcp-tracing`),
  not a library that merely *could* be used this way.

**The server-side half this library owns is done (ADR 017).** The
client-side half is real, shipping, and spec-referenced — but, per the
Adoption caveat below, concentrated entirely in the v1 SDK ecosystem, not
built into either SDK's own default behavior, and not yet present for v2
at all. "Viable" in this ADR means viable for that scope specifically,
not "the client-side gap is closed" in the unqualified sense ADR 012
originally posed the question.

## Decision

Introduce trace id as a **new, narrower fallback tier** for Agent Thrash
Detection's session-identity resolution (`resolveThrashSessionId()`,
`src/instrument.js`) — used only when no real session id is available,
sitting between today's step 2 (session-aware skip) and step 3 (the
generated per-connection UUID fallback / skip). Design only: the shape
below is precise enough to implement directly once accepted, but no code
changes accompany this ADR.

### Granularity: one trace ≈ one agent turn — the common shape, not a guarantee

Confirmed against a real, concrete example rather than assumed from how
W3C trace context is *supposed* to work. `langfuse/langfuse-examples`'
`mcp-tracing` app:

```python
@observe(name="agent-run")
async def run_agent(message: str):
    result = await Runner.run(starting_agent=agent, input=message)
    return result.final_output
```

`Runner.run(...)` drives the whole think/act/observe loop — including any
tool-call retries — entirely inside the one `@observe` span.
`TracedMCPServer.call_tool()` injects `context.get_current()` fresh on
*every* `call_tool()` invocation, so every tool call and every retry
within that one turn inherits the same trace id: trace id is fixed at a
trace's root, and nesting further spans under it (however many, however
they retry) never changes it. A new trace begins each time the outer
`while True: message = input(...)` loop reads a new question — i.e.
**per user turn**, not per session and not per single tool-call attempt.

This is **coarser than the ideal ("one retry loop") and finer than "one
whole session/connection"** — but it is not a protocol guarantee. Trace
id granularity is determined entirely by whatever span boundary the
*calling agent framework* happens to have active at the moment it invokes
the tool; the MCP-layer propagation mechanism (whether SEP-414's
convention or opentel-mcp's own extraction) has no opinion on it and
cannot enforce one. The evidence above establishes this as the **common,
default shape** for the reference implementations actually found — not
something this design can rely on unconditionally holding for every
client that ever propagates `traceparent`.

### The comparison that actually matters

The question this ADR needs to answer is **not** "is trace id a good
substitute for a real session id" — it isn't, and it doesn't need to be,
since a real session id already wins outright whenever one exists (see
Precedence below, unchanged from today). The question is: **for a call
that has no real session id at all — the population that reaches today's
coarse fallback — is trace id, when available, better than what it would
sit beside?**

Argued on exactly that comparison, not the session comparison:

- **Today's fallback** (`thrashConnectionFallbackSessionId`,
  `instrument.js`) is generated **once per instrumented-server-instance /
  connection**, and — when `instanceKey` is set — shared via the registry
  for that key's whole TTL. Every session-less call on that connection,
  for its entire lifetime, collapses into one shared bucket: many
  unrelated turns, potentially many unrelated end users routed through
  one long-lived process, merged with no bound at all beyond the
  connection's own lifetime.
- **Trace id, per the granularity finding above, is fresh per agent
  turn.** Concurrent or sequential unrelated turns on the same connection
  get *different* trace ids automatically, the moment the calling client
  starts a new one — which, per the evidence above, real clients do once
  per top-level invocation.

On this comparison — the one that actually determines what replaces what
— trace id is a strictly finer-grained identity than the fallback it
would sit beside, not merely "different." That is the basis for treating
it as viable, not a claim that it approaches session-id quality.

### Precedence: a new tier between step 2 and step 3, nothing above it touched

`resolveThrashSessionId()`'s existing priority order, unchanged by this
ADR:

1. A real `extra.sessionId` always wins, and marks the server permanently
   session-aware.
2. Once session-aware, a later call with no session id is skipped
   outright — never merged into a fallback, even an accurate one.
3. *(today)* Before any real session id has been observed: the generated
   per-connection UUID, gated on `assumeSingleSession` or a positively
   confirmed single-connection transport. Otherwise, skip.

This ADR's design inserts a **step 2.5**, reached only when step 2 has
*not* skipped (i.e. no real session id has ever been observed on this
server) and evaluated *before* step 3's UUID/skip logic: if this call's
span has a validly extracted remote parent (see the trap below for
exactly what "validly extracted" must mean), use that parent's trace id
as the session-id candidate for this call. Steps 1 and 2 are untouched,
byte for byte — a real session id still wins unconditionally, every time,
regardless of whether a trace id is also available. `ThrashDetector`
itself needs no change: it already treats `sessionId` as an opaque
string in its composite key (`${sessionId}|${toolName}|${channel}|${fingerprint}`,
`thrash/detector.js`).

### THE TRAP: gate on `isRemote`, never read `span.spanContext().traceId` unconditionally

**This is the single most important constraint in this design, and the
one most likely to be gotten wrong by a future implementer working from
this ADR's summary rather than its detail.**

`resolveThrashSessionId()` already runs *inside* `startActiveSpan()`'s
callback (confirmed by reading the current call site in
`wrapToolCallHandler`), so `span.spanContext().traceId` is available
there today, for every call, unconditionally. **It must not be read
unconditionally.** Every span — root or child — has a `traceId`. For a
**root span** (no `_meta.traceparent` was ever extracted, or extraction
failed per ADR 017's degrade-to-`baseContext` behavior), that trace id is
a **freshly, randomly generated value, different on every single call**.
Using it as a session-id candidate without distinguishing this case from
a genuine extracted-parent case would silently convert today's correct
"skip — undetermined" behavior into "always produce a session id that
never matches the previous call's" — which is *worse* than skipping,
because it looks configured and working (a bucket key is always
populated) while never actually accumulating anything, ever, for any
call that lacks both a real session id and a real upstream trace parent.
That failure mode is quieter and harder to notice than today's honest
`null` — nothing signals it, since `ThrashDetector.record()` has no way
to know the key it was handed was manufactured fresh every time.

**The required gate:** only trust the resulting trace id as a session-id
candidate when the span's parent context actually carried a validly
extracted remote `SpanContext` — concretely, checking
`trace.getSpanContext(parentContext)?.isRemote === true` on the context
`extractTraceContext()` returned (`src/tracecontext/extract.js` already
sets `isRemote: true` deliberately and only when a valid `traceparent`
was found — ADR 017's own extraction always does this, so the signal
already exists and needs no new code in that module). Equivalently: check
that `extractTraceContext()`'s return value is not reference-identical to
the `baseContext` it was passed (ADR 017's own "absent/malformed →
returns `baseContext` unchanged" contract makes this an already-available
signal too) before ever treating the resulting span's trace id as usable.
Either check is sufficient; a future implementation should pick one and
document why, not check the *span's* `traceId` field in isolation without
first knowing whether it was inherited or freshly minted.

### Residual merge risk, bounded and compared honestly

Checked against `ThrashDetector`'s actual behavior, not assumed away. The
only way this fallback tier over-merges: the **same tool** fails with the
**exact same fingerprint** twice, for genuinely unrelated reasons, within
`windowMs` (default 60,000ms — `thrash/config.js`), inside **one agent
turn**, with no intervening success of that same tool in between
(`clearOnSuccess(sessionId, toolName)` wipes the active episode the
moment that tool next succeeds, regardless of what else happened for
other tools in the meantime).

That is a real, narrow edge case — and it is **no worse than what real
session ids already tolerate today.** A long-lived stdio connection's
session id can span days of unrelated turns; if ADR 012's own design (and
every release since) already accepts "same tool, same fingerprint,
non-consecutively, within one session" as a tolerable characteristic of
session-scoped grouping, a fallback that is *strictly finer-grained* than
a session (one turn, not a whole connection) cannot be held to a
stricter standard than the thing it's a fallback for.

## Constraints accepted

- **The `isRemote` gate above is not optional** — any implementation of
  this ADR that skips it does not implement this ADR; it implements the
  bug this ADR exists partly to warn against.
- **Real session id wins unconditionally, in all cases, with no
  exception** — steps 1 and 2 of `resolveThrashSessionId()` are not
  reordered, weakened, or made conditional on anything this ADR
  introduces.
- **`thrashSessionState.hasSeenRealSessionId` must not be set by a trace-id-sourced
  candidate.** That flag's existing meaning is "this *transport* has
  proven, via a real `extra.sessionId`, that it hands out session
  identity" — a permanent, per-server fact about the deployment. A trace
  id being available on one call is a per-call fact about *that
  particular client's* behavior, not a proof about the transport itself;
  conflating the two would let one trace-id-carrying call permanently
  change how every *subsequent, unrelated* session-less call on the same
  server is treated, which is not something this ADR's evidence supports.
- **No changes to `ThrashDetector`/`thrash/detector.js`.** The composite
  key already treats `sessionId` as opaque; this ADR only changes what
  value gets computed and passed in for one specific case.
- **Whether the new tier fires a `diag.warn()`, and at what frequency, is
  left open for the implementation ADR/PR, not settled here.** Today's
  UUID fallback warns once because it is a *guess* the library is making
  about the transport's shape. A trace-id-sourced candidate is not a
  guess in that sense — it is real, client-supplied data, just narrower
  in scope than a real session id — so the same warning posture may not
  transfer directly. Flagged as an open question rather than decided, to
  avoid this design ADR silently making a UX decision it hasn't actually
  argued for.

## Alternatives rejected

- **Reading `span.spanContext().traceId` unconditionally, with no
  `isRemote` gate.** Rejected — see "THE TRAP" above. This is the
  single most tempting shortcut and the one this ADR exists specifically
  to rule out in writing, not just in an implementer's head.
- **Having a trace-id-sourced candidate outrank or replace a real session
  id.** Rejected — a real session id is a stronger, protocol-level
  identity signal; a trace id is inferred from optional, client-chosen
  observability behavior. Downgrading the stronger signal in favor of the
  weaker one has no motivating benefit and a real regression risk (a
  client that sends both a real session id and, coincidentally or
  deliberately, a trace id belonging to a *different* logical grouping).
- **Presenting this as closing v2's stateless thrash-detection gap.**
  Rejected outright — see the Adoption caveat below. This is a materially
  narrower claim than "stateless is solved," and conflating the two would
  misrepresent both this ADR and the state of `docs/known-gaps.md` entry 6.

## Adoption caveat — read this before treating "viable" as "solved"

**Every real propagating client found in this investigation targets v1**
(`@modelcontextprotocol/sdk`), confirmed by reading source, not inferred
from package names:

- `@arizeai/openinference-instrumentation-mcp`'s TypeScript package
  imports specifically from `@modelcontextprotocol/sdk/client/*` — v1's
  namespace, not v2's `@modelcontextprotocol/{server,client,core}`.
- The Langfuse example wraps the OpenAI Agents SDK's `MCPServerStdio`,
  which itself sits on the Python MCP SDK's v1-shaped client API.
- No third-party instrumentation targeting v2's client package was found
  anywhere in this investigation.
- **v2 itself still does not read or write these keys anywhere in its own
  implementation** — reconfirmed directly against the installed
  `@modelcontextprotocol/server@2.0.0`/`@modelcontextprotocol/core@2.0.0`
  packages in this same investigation, the same way ADR 012 originally
  checked it. Only the key-name constants are exported; nothing consumes
  them.
- **The Python MCP SDK's own first-party attempt at this — PR #1693,
  the one SEP-414 itself cites — is closed, unmerged.** Even within the
  v1-adjacent ecosystem, real propagation today happens through
  third-party instrumentation wrapping the official clients, not through
  either official SDK's own built-in behavior.

**This ADR closes the gap for the currently-deployed, v1-based
ecosystem — specifically, for whichever fraction of it has opted into
one of the third-party instrumentation packages above. It does not, and
must not be read to, close `docs/known-gaps.md` entry 6's structural
finding**: that MCP spec 2026-07-28 removes protocol-level sessions
entirely, so a v2/2026-07-28-native deployment has no session id
available *at all*, by construction, regardless of any configuration
this library exposes. This ADR's fallback tier only fires when a client
*chooses* to propagate trace context — a fact about client-side
opt-in behavior that is completely orthogonal to whether the protocol
itself carries session identity. A v2 stateless deployment whose client
does not propagate `_meta.traceparent` — the default, unconfigured case
for essentially every v2 client today, since no v2-targeting
instrumentation exists yet — gets nothing new from this ADR: the exact
same `null`/skip behavior as before it. **"Stateless thrash detection is
now solved" is not a conclusion this ADR supports, and any future
document summarizing it should not imply otherwise.**

## Versioning: not v0.11.0

v0.11.0's scope was already fixed and shipped before this investigation
began — ADR 016 (pricing override and staleness) as Phase 1, ADR 017
(trace context propagation, server-side) as Phase 2. This ADR was
discovered as a direct follow-on question *after* Phase 2 landed, not as
part of either phase's original scope. Folding it into v0.11.0
retroactively would blur what that release actually shipped against what
it enabled a later release to build on top of — the same reasoning ADR
012 itself was written under (`Status: Proposed — design only, no
implementation`) before its `instanceKey` mechanism shipped, deliberately,
two minor versions later. This ADR carries the same status marker for the
same reason: it is a candidate for a future minor release (v0.12.0 or
whichever comes next once accepted), not a retroactive addition to one
already defined and shipped.

## Consequences

- No code changes from this ADR. `resolveThrashSessionId()`,
  `wrapToolCallHandler`, and `thrash/detector.js` are all unchanged today.
- Sets up a small, well-scoped, precisely-specified follow-up
  implementation whenever prioritized: one new tier in
  `resolveThrashSessionId()`, gated on `isRemote`, with no changes needed
  to `ThrashDetector`'s own key structure.
- ADR 012's own text is not rewritten — a note is appended there (see
  that ADR's own tail) pointing here, consistent with how that document
  already handles every other correction to its own earlier findings
  (its "Update" sections throughout).
- `docs/known-gaps.md` entry 6 is not edited by this ADR — a future PR
  that actually implements this design would be the right place to add a
  cross-reference there, scoped exactly as narrowly as the Adoption
  caveat above states, not before.
