# Known gaps

Tracked gaps and open questions that v0.7.0 (ADR 007,
`docs/adr/007-protocol-error-channel.md`, and ADR 009,
`docs/adr/009-field-level-convergence.md`) did not close. Each entry below
is written as a ready-to-paste GitHub issue — title, then body — for
whenever one of these gets prioritized. **These are not open GitHub
issues yet.** This file exists because filing them requires API access
this environment doesn't have; it's the staging area until someone with
repo access copies one in.

---

## 1. Field-level convergence tracking for `protocol.input` thrash detection

**Target:** v0.8.0
**Raised by:** u/Pleasant-Ad192 (external review)

**Status update (v0.7.0):** investigated in ADR 009
(`docs/adr/009-field-level-convergence.md`). Finding: most of this concern
is already handled by existing behavior — `computeFingerprint()` already
hashes the same field failing repeatedly to the same fingerprint, and a
different field failing each attempt to a different fingerprint, as a
side effect of hashing the full Zod issues JSON. This is now
regression-tested (`test/fingerprint/field-level-convergence.test.js`),
not incidental, and a diagnostic `mcp.failure.validation_paths` span
attribute now surfaces which field(s) failed. The body below is kept as
the original report for context. The one gap ADR 009 did *not* close —
partial convergence, where fixing one of several failing fields still
breaks fingerprint continuity — is tracked separately as entry 5 below,
since it needs a design decision this ADR didn't settle on.

### Body (original report)

`protocol.input` failures (an agent's arguments failed a tool's input
schema) currently use a single, higher threshold (`inputThreshold`,
default 5 — see README's "Agent Thrash Detection" → "Configuration") on
the theory that an agent retrying with different arguments may be
converging on a correct call, not thrashing.

That threshold can't distinguish two very different situations, because
`ThrashDetector` only counts consecutive same-fingerprint failures — it
has no visibility into *which* input field failed on each attempt:

- **The same schema property fails on every attempt** (e.g. the agent
  keeps getting `"date" must be ISO-8601` no matter what it sends for
  `date`). This is much more likely to mean the tool's input schema or
  its description is ambiguous or under-specified — a **server-side,
  fixable** problem, not agent confusion. Retrying past `inputThreshold`
  in this case is a real signal worth surfacing distinctly from ordinary
  thrash.
- **A different property fails each attempt** (e.g. first `date`, then
  `date` is fixed but `currency` fails, then `currency` is fixed but
  `limit` fails). This looks like genuine convergence — the agent is
  incrementally correcting its call — and arguably should NOT be flagged
  as thrash at all, or should reset/extend the threshold rather than
  count toward it.

Today both cases accumulate identically toward `inputThreshold` and are
indistinguishable in `getThrashSummary()` or the `mcp.tool.loop.*`
metrics.

**Open questions for implementation:**

- Where does the failing-field information come from? `mcp.failure.*`
  today only classifies the whole failure, not per-field detail from the
  input-validation error message. Extracting a field name would mean
  parsing a Zod (or other schema library's) error shape, which is a
  narrower, more library-coupled surface than the existing SDK-message
  parsing this ADR already does — worth scoping carefully.
- What's the right signal shape? A same-field-repeated case might warrant
  its own span attribute or event (distinct from `mcp.loop.detected`)
  rather than folding into the existing thrash counters, per this
  project's existing principle that misattributed failures shouldn't
  just be relabeled but should get correctly separated (see ADR 007's
  "Output validation is not thrash" decision, which this would extend).
- Interacts with the collision risk documented in ADR 007's addendum
  (forwarded/proxied error messages) — any field-extraction heuristic
  inherits the same SDK-message-coupling fragility.

---

## 2. Observation liveness contract

**Target:** v0.8.0
**Raised by:** Massimiliano Brighindi (external review)

**Status update (v0.8.0): investigated and shipped, but narrowed — not the
same contract as the one speculated below.** Massimiliano Brighindi, who
raised this gap, also supplied the reframe that shaped what shipped:
investigated in ADR 008's "Update (2026-08-05): The two-axis reframe"
section (`docs/adr/008-observation-liveness.md`), which found that the
single four-state field speculated below was itself already a mild
instance of the overclaiming this gap exists to guard against — one of
its three provisional values quietly implied health by the absence of
evidence to the contrary, exactly the pattern the original report was
worried about. The shipped design splits it into two independent fields
instead, both backing a new `getObservationState()` accessor (see the
README's "Two-axis observation contract" section):

- `toolOutcome` — `{ success, failure, unknown }`, from a new always-on
  counter independent of `fingerprinting`/`thrashDetection`/`enableMetrics`
  (not a read of `ThrashDetector`/`getThrashSummary()`, which would have
  inherited exactly the kind of config-flag-gated blind spot this gap
  exists to close).
- `observationIntegrity` — `'DEGRADED' | 'UNKNOWN'`.

**The gap narrowed; it did not close.** The three provisional values below
speculated a `HEALTHY`-equivalent state (`OBSERVED_CLEAN`) was reachable.
The actual investigation found `HEALTHY` is **structurally unreachable in
every configuration this library runs in** — the one lead, OTel SDK
self-observability metrics, is a write-only `Counter` with no synchronous
read-back API in `@opentelemetry/api`, so this library's own code can
never positively confirm telemetry is flowing, no matter how it's wired
up. `HEALTHY` was therefore dropped from the type entirely (enforced by
TypeScript, not just documentation — see `test/index.exports.test-d.ts`),
rather than shipped as a value nothing could ever produce. `DEGRADED` *is*
reachable, but only under `setupNodeSdk: false`, via the same kind of
fragile SDK-internals-adjacent check this entry's own "open question"
below anticipated would be needed ("the obvious approaches... reach into
implementation detail that isn't guaranteed stable") — under
`setupNodeSdk: true` this axis is permanently `UNKNOWN`, not merely rarely
`DEGRADED`. Implemented as a new **top-level accessor**, not a
`ThrashSummary` field — correcting the placement this speculative test
originally guessed at, per ADR 008's Finding 4.

**Test status**: the shipped feature has full, passing (not skipped)
coverage — `test/observation/tool-outcome-counter.test.js`,
`test/observation/integrity.test.js`, and `test/instrument.observation.test.js`.
The two *original* exploratory spec files below remain `describe.skip`,
left as-is rather than rewritten: `test/thrash/observation-liveness.test.js`
(this entry's own original speculative test, kept as a historical record
of the four-state framing this update supersedes) and
`test/thrash/observation-integrity.test.js` (added during the same
investigation to spec the more realistic "provider registered but export
broken" failure mode — still describe.skip because it specs a
config-driven trace-export failure that the shipped `toolOutcome`
counter's own tests don't need in order to prove the counter itself is
correct).

The body below is kept as the original report for context.

### Body

`instrumentMcpServer()` with no `TracerProvider`/`MeterProvider`
registered silently no-ops — spans and metrics are dropped via
`@opentelemetry/api`'s default no-op implementations, with no warning.
That means a tool call that returns `isError: true` in that state is
indistinguishable, from outside the process, from a tool that never
failed at all: both produce zero recorded telemetry. "Nothing happened"
and "nothing was successfully observed" collapse into the same zero.

A skipped specification test already documents the intended shape at
`test/thrash/observation-liveness.test.js` (`describe.skip`, not a
working implementation — see that file's docblock for the full
rationale). It proposes a `summary.observation` field on
`getThrashSummary()`'s return value (`ThrashSummary`,
`src/thrash/types.d.ts`), with three provisional values:

- `OBSERVED_CLEAN` — the observation channel is confirmed live (a real
  provider is registered) and nothing has failed.
- `OBSERVED_FAILING` — the observation channel is confirmed live and at
  least one failure has been recorded.
- `OBSERVATION_UNAVAILABLE` — no live provider is registered, so nothing
  emitted here can be trusted to mean "healthy."

The field name, its exact value set, and even whether it belongs on
`ThrashSummary` at all versus somewhere else are explicitly **not**
decided — see the skipped test's docblock, which says so directly.

**Open question for implementation:** how does `instrumentMcpServer()`
detect "a live provider is registered" without coupling to
`@opentelemetry/api`/SDK internals that aren't part of its stable public
contract? The obvious approaches (checking `trace.getTracerProvider()`'s
identity against the known no-op singleton, or similar for metrics) reach
into implementation detail that isn't guaranteed stable across
`@opentelemetry/api` versions, and this project's own principle (see ADR
001, ADR 002) is to avoid depending on non-public surfaces of dependencies
wherever avoidable. Finding a reliable, version-stable way to answer
"is telemetry actually going anywhere" is the core design problem this
issue needs to solve before the skipped test can become real.

---

## 3. Pre-handler parse-failure gap

**Target:** Unscheduled

### Body

A malformed `tools/call` request — one that fails `CallToolRequestSchema`
validation (e.g. a missing or wrongly-typed `name`/`arguments` field) —
produces **zero telemetry**: no span, no fingerprint, nothing. This is
invisible by construction, not by oversight.

The reason: the SDK's `Protocol.setRequestHandler()` (in
`@modelcontextprotocol/sdk`'s `shared/protocol.js`) wraps every handler
with a schema-parse step (`parseWithCompat()`) that runs *before* calling
the handler `instrumentMcpServer()` wrapped. `instrumentMcpServer()`
follows ADR 001's "innermost layer" wrapping strategy — it only patches
the `handler` argument passed to `setRequestHandler`, deliberately
avoiding a larger, less stable surface (patching `Protocol`'s own
request-dispatch/parsing internals). That means a parse failure throws
*before* `wrapToolCallHandler`'s span/fingerprint logic ever runs — there
is no span to attach a status to, and no error object reaches
`computeFingerprint()` at all.

Confirmed via direct code reading during ADR 007's investigation (see
that ADR's Context section, "the real, confirmed gap") — not
hypothesized.

**Why this is unscheduled rather than merely deferred:** closing it means
wrapping a layer above `setRequestHandler`'s `handler` argument — i.e.
revisiting ADR 001's core decision, not adding a patch-level attribute or
threshold. That's a materially bigger architectural change (a new,
less-stable dependency surface) than anything else in this gap list, and
deserves its own ADR and design pass rather than being bundled into a
future feature release by default.

**Scope note:** the JSON-RPC error this produces also isn't `-32602` —
`parseWithCompat()` throws a raw `ZodError` with no `.code` property, so
`shared/protocol.js`'s fallback (`Number.isSafeInteger(error['code']) ?
error['code'] : ErrorCode.InternalError`) reports it as `-32603`
(`InternalError`) on the wire, regardless of what actually made the
request malformed.

---

## 4. Client-side retry caps interact with detection thresholds

**Target:** Unscheduled
**Raised by:** u/Context-Stream-AI (external review)

### Body

Agent Thrash Detection's thresholds (`threshold`, `inputThreshold`,
`notFoundThreshold` — see README's "Agent Thrash Detection" →
"Configuration") all assume the calling agent will keep retrying an
identically-failing call past the configured count. Some agent
frameworks impose their own client-side cap on same-arguments retries —
e.g. an agent that gives up and reports failure to its user after 2
identical attempts.

If an agent's own retry cap is lower than the relevant threshold (e.g.
the agent caps at 2 retries, but `threshold` defaults to 3), that agent's
thrashing **never crosses the threshold and is never detected** —
`mcp.tool.loop.detected` simply never fires for it, even though the
underlying pattern (retrying an unfixable call) is exactly what this
feature exists to catch.

This is arguably *correct* behavior in isolation — 2 identical failures
genuinely is a weaker signal than 3, and lowering every default threshold
to accommodate the most conservative possible agent would raise false
positives for everyone else. But the current defaults were chosen
(`threshold: 3`, ADR 006) without an explicit model of client-side retry
caps — they assume an effectively uncapped agent, and that assumption is
not stated anywhere a configuring operator would see it before hitting
this gap themselves.

**Possible directions, not decided:**

- Document the assumption explicitly (done as a note in this release —
  see README's "Agent Thrash Detection" → "Configuration") so operators
  running capped agents know to lower `threshold` accordingly, rather
  than silently getting no detection.
- A lower recommended default, or a documented "if your agent caps
  retries at N, set `threshold` to N" formula.
- Detection based on session-level failure diversity rather than a single
  tool's consecutive count, so a capped agent's *pattern* across several
  different tools could still register — a materially different
  detection model, out of scope for a patch-level change.

---

## 5. Partial convergence in field-level validation

**Target:** Unscheduled
**Raised by:** u/Pleasant-Ad192 (external review)

### Body

ADR 009 (`docs/adr/009-field-level-convergence.md`) found that
`computeFingerprint()` already distinguishes "the same schema field
failing repeatedly" from "a different field failing each attempt" —  as
a side effect of hashing the full Zod issues JSON, which embeds every
failing field's `path`. That distinction is now regression-tested
(`test/fingerprint/field-level-convergence.test.js`) and surfaced
diagnostically via `mcp.failure.validation_paths` (v0.7.0).

One real gap survives that fix: **when several fields fail validation
and the agent fixes one of them, the shape of the issues array changes,
so the fingerprint changes too — even though the same underlying field
is still failing underneath.** Concretely: attempt 1 fails on both
`date` and `currency`; attempt 2 fixes `date` but still fails on
`currency`. The issues array shrinks from two entries to one, the
normalized message changes, and the fingerprint changes with it — so
`ThrashDetector` sees this as a *fresh* episode (count resets to 1)
rather than recognizing that `currency` has now failed on both attempts.
An agent that is only partially converging — fixing some fields while
staying stuck on one — currently gets no credit for the fields it did
fix, and no continuity for the field it's still stuck on.

**Why this is unscheduled rather than merely deferred:** ADR 009 names
the *direction* for a fix — compare extracted `mcp.failure.validation_paths`
*sets* across consecutive attempts on the same tool, not just fingerprint
equality — but does not specify an algorithm. Specifically unresolved:

- **What `ThrashDetector` groups by.** Today it groups strictly by
  `(sessionId, toolName, channel, fingerprint)` (`src/thrash/detector.js`).
  Comparing path sets across attempts implies either a secondary grouping
  key alongside fingerprint, or replacing fingerprint-based grouping with
  something path-set-based for `protocol.input` specifically — a real
  architectural choice, not a parameter tweak.
- **What state transition a shrinking or changing path set triggers.**
  ADR 009 says this is "a stronger, intentional convergence signal" than
  today's incidental fingerprint inequality, but doesn't say what should
  actually happen: reset the counter, extend the window, skip counting
  that attempt, or emit a distinct signal alongside the ordinary count.
- **What "reinforces the count with actual evidence" means mechanically**
  for a *stable* path set. Does a stable set MERGE attempts that
  currently produce different fingerprints (e.g. the same field failing
  for a different underlying reason each time) into one count? If so,
  by what matching rule — exact path-set equality, or something looser?

Implementing any one of these without settling the others first would
mean inventing a design ADR 009 deliberately left open, not following
one it decided — which is why this was deferred rather than built
alongside the diagnostic attribute in v0.7.0.

---

## 6. Four in-memory trackers reset every `instrumentMcpServer()` call under stateless HTTP

**Target:** v0.9.0 (proposed — see ADR 012)
**Found by:** internal self-review, not an external report

**Status update (v0.9.0): partially fixed, not closed.** ADR 012's
proposed `instanceKey` option shipped — a host-supplied string that
shares all four trackers below across `instrumentMcpServer()` calls, via
a bounded, TTL-evicting internal registry, instead of each call
constructing them fresh (Phase 2 wiring: `src/config.js`/
`src/instrument.js`; Phase 3 public API: `src/index.d.ts`).
`test/integration/thrash-stateless-http-lifecycle.test.js` is no longer
`describe.skip`: it now proves the fix directly — a shared `instanceKey`
across 5 separate `instrumentMcpServer()` calls, and `mcp.tool.loop.detected`
fires by the 5th — alongside a second test confirming the pre-fix
behavior is unchanged when `instanceKey` is omitted, which remains the
default.

**What `instanceKey` fixes:** the exact scenario this entry describes — a
fresh `Server`/`McpServer` constructed and re-instrumented on every
incoming request, on an otherwise long-lived process — for all four
trackers, when `instanceKey` is set to the same stable value on every
call.

**What it does NOT fix — two real gaps, not corner cases:**

1. **A composition requirement for thrash detection specifically,
   discovered while writing the Phase 2 regression test — not anticipated
   in ADR 012's original Decision text.** `ThrashDetector` groups episodes
   by `(sessionId, toolName, fingerprint)`. `instanceKey` shares the
   tracker *object*; it does nothing about the session-id half of that
   lookup key. Without a real, transport-provided `extra.sessionId` on
   every call, each `instrumentMcpServer()` call generates its own random
   per-connection fallback id (README's "Session id resolution" section)
   — so even with the same shared tracker, each of N stateless-HTTP
   requests lands under a different, unrelated key, and nothing ever
   accumulates past 1. Real Streamable HTTP transports provide a real
   session id automatically, so the common case works with `instanceKey`
   alone — but a custom `Transport`, `assumeSingleSession: true`, or
   anything else landing on the fallback path will set `instanceKey`, see
   nothing happen, and have every reason to conclude the fix is broken.
   That is the identical silent-inertness shape this whole entry is
   about, now one layer deeper, hiding behind what looks like a fix.
   Documented as its own prominent callout in the README's new
   "instanceKey" section, not a footnote.
2. **Does not help across process/container boundaries — Lambda, Cloud
   Run, or any horizontally-scaled deployment.** `instanceKey`'s registry
   is one process's in-memory state. Concurrent instances each load their
   own copy and only ever see the calls routed to them; passing the
   identical `instanceKey` string everywhere does not change that. This
   is a structural limitation of an in-process registry, investigated and
   accepted rather than solved with an external store (ADR 012's Update
   section explains why: this library's deliberately dependency-free
   posture) — counters remain instance-local and best-effort by design
   for distributed deployments, documented as such in the README, not
   only the ADR.

**Update (2026-08-10): MCP spec 2026-07-28 makes gap 1 permanent, not just
a corner case.** Investigated directly against the spec text and the
installed SDK, not assumed. [MCP spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
removes protocol-level sessions and the `Mcp-Session-Id` header from the
Streamable HTTP transport entirely — not deprecated, removed — along with
the `initialize`/`notifications/initialized` handshake that used to mint
one. For a 2026-07-28-native transport, `extra.sessionId` cannot ever be
populated: there is no header, no handshake, and no other spec-level
mechanism to source it from, for any client, on any transport.

Gap 1 above already establishes that `instanceKey` shares the tracker
*object* but does nothing about the session-id half of `ThrashDetector`'s
`(sessionId, toolName, fingerprint)` lookup key. This spec revision turns
that from "a caveat covering custom transports and `assumeSingleSession`
misuse" into the *permanent, unconditional* state for every 2026-07-28-native
deployment. No configuration of `instanceKey` — or anything else this
library exposes today — closes it. The codebase's own regression test
already proves the mechanism behaves exactly this way:
`test/integration/thrash-stateless-http-lifecycle.test.js`'s docblock
states plainly that `instanceKey` "fixes thrash detection for a stateless
deployment that has real session ids... it was never meant to, and does
not, paper over the absence of any session identity at all." The README's
"instanceKey" section (`packages/core/README.md`) now documents this
scoping explicitly, correcting an earlier version of that section that
implied "real Streamable HTTP transports" universally provide a usable
session id — true through spec 2025-11-25, not true for 2026-07-28.

As of this writing, `@modelcontextprotocol/sdk` — this library's actual
dependency — does not implement 2026-07-28: its `LATEST_PROTOCOL_VERSION`
is `2025-11-25`, and the transport still requires `Mcp-Session-Id` on the
wire. 2026-07-28 support currently ships only in the separate, first-beta
`@modelcontextprotocol/{server,client,core}@2.0.0` packages, not the
package this library depends on. **This is a forward-looking gap, not a
currently-shipping break** — but it is a gap against a spec revision that
is already published, not a hypothetical future one, so `instanceKey`'s
thrash-detection fix has a known shelf life rather than an open-ended one.

**Possible directions, not decided:** lean on trace correlation instead of
in-process session-keyed counting — `mcp.failure.fingerprint` is present
on every failed-call span regardless of session id, so grouping by
fingerprint over a time window at the trace-analytics layer (Tempo +
TraceQL, a Collector processor, or similar) doesn't need a session id at
all. This is directionally the same reframe ADR 012's Update section
already applies to the *distributed* (multi-process) version of this
problem — worth revisiting together rather than solving twice. Not
scoped further here.

**Status update (v0.10.0, continued): the fallback-id half of gap 1 is
now fixed; the "v2 provides no real session id by default" reality above
is not, and cannot be, by this fix.** `thrashConnectionFallbackSessionId`
(`src/instrument.js`) is now registry-backed via the same
`getOrCreateTracker()`/`instanceRegistry` machinery the four trackers
already use — a fifth namespaced entry (`'thrash-fallback-session'`) on
the same shared, bounded registry, no new bound/eviction policy
introduced. Concretely: gap 1's own wording above — "each
`instrumentMcpServer()` call generates its own random per-connection
fallback id... so even with the same shared tracker, each of N
stateless-HTTP requests lands under a different, unrelated key" — is no
longer true when `instanceKey` is set. Repeated calls sharing an
`instanceKey` now reuse the same generated fallback id, so the fallback
path can accumulate across calls the way real-session-id calls always
could. Confirmed by test, not just reasoned about:
`test/integration/thrash-v2-transport-detection.test.js`'s "registry-backed
via instanceKey" describe block drives 5 separate `instrumentMcpServer()`
calls, each a fresh v2 `Server` connected to a real stdio transport with
no real session id, sharing one `instanceKey`, and confirms
`mcp.tool.loop.detected` now fires by the 5th — the exact assertion that
would have failed before this fix, for the exact reason gap 1 describes.
When `instanceKey` is omitted (the default), this is a complete no-op —
`getOrCreateTracker()` calls its factory directly without touching the
registry, so the fallback id is fresh on every call, byte-identical to
before.

**What this does NOT fix, and cannot:** the 2026-07-28-native "no real
session id available at all" reality the 2026-08-10 update above
describes is a fact about what the deployment provides, not about what
this library does with what it's given — no amount of registry-backing
changes that a v2 deployment under `createMcpHandler`'s default posture
never populates `ctx.sessionId` in the first place. What actually changed
is *which* deployments even reach the fallback path at all: entry 8's fix
(landing in this same v0.10.0 release) means `isSingleConnectionTransport()`
no longer auto-detects `PerRequestHTTPServerTransport` as single-connection,
so the fallback path is no longer reached automatically by every v2 HTTP
deployment by default — only by an operator's explicit, informed
`assumeSingleSession: true` opt-in (or a positively-confirmed v2 stdio
deployment, which was never ambiguous to begin with). **For exactly that
narrower, explicit-opt-in population, this fix is what makes thrash
detection actually work** — before it, even a fully correct, intentional
`assumeSingleSession: true` v2 deployment using `instanceKey` would have
seen thrash detection stay silently inert, for the reason gap 1 describes.
See ADR 015's Update section (the "Finding 3/8 landed together" entry) for
why these two fixes had to ship together, and specifically in this order
— registry-backing the fallback id *before* fixing detection would have
made the entry-8 false positive worse (a stable id shared across
misclassified calls, instead of a fresh one resetting every call).

**Deliberately not folded into this fix — a narrower, separate, still-open
gap:** `thrashSessionState` (`{ hasSeenRealSessionId, hasWarnedFallbackUsed }`)
is still a plain object constructed fresh inside `instrumentMcpServer()`
on every call, not registry-backed the way the fallback id now is. Under
the v2 per-request factory model, this means "has this server ever proven
itself session-aware" also forgets on every call — rule 2 of
`resolveThrashSessionId()`'s priority order (a later call with no
sessionId, after a real one was already observed, is skipped rather than
falling back) can never actually engage across separate per-request calls,
even if earlier requests in the same logical deployment did carry a real
session id. Narrower consequence than the fallback-id gap this update
fixes: rule 1 (a real sessionId always wins) is unaffected regardless, so
this only matters for a deployment that mixes real-session-id calls with
occasional no-session-id ones under a shared `instanceKey`. Not scoped
into this change; tracked here so it isn't lost.

The body below is kept as the original report for context.

### Body

Agent Thrash Detection, Cost & Token Attribution's budget tracking, Tool
schema drift detection, and the Two-axis observation contract's
`toolOutcome` counter all keep in-memory state across tool calls — and all
four are constructed as local variables inside `instrumentMcpServer()`'s
own function body, freshly, on every single call:

- `budgetTracker` — `src/instrument.js:194`
- `thrashDetector` — `src/instrument.js:200`
- `toolOutcomeCounter` — `src/instrument.js:245`
- `schemaDriftDetector` — `src/instrument.js:275`

Under a "stateless" Streamable HTTP deployment — a fresh `Server`
constructed, and re-instrumented, on every incoming POST — every one of
these four trackers is discarded and rebuilt from empty before it ever
sees a second data point. Nothing accumulates, no threshold is ever
crossed, and nothing warns that this is happening. The existing
`kInstrumented` idempotency guard doesn't help: it only prevents
re-instrumenting the *same* object twice, and this deployment shape hands
`instrumentMcpServer()` a genuinely different, freshly-constructed object
on every request.

Reproduced directly:
`test/integration/thrash-stateless-http-lifecycle.test.js`
(`describe.skip` — a confirmed, unfixed gap kept as a living reproduction,
not a working fix). It drives 5 identical-fingerprint tool failures across
5 separate `instrumentMcpServer()` calls and confirms
`mcp.tool.loop.detected` never fires, even past the default `threshold:
3`, purely because of this lifecycle mismatch — not because the detection
logic itself is wrong.

**This was already documented once, too narrowly.** ADR 010
(`docs/adr/010-schema-drift.md`) accepted the identical root cause as a
schema-drift-specific limitation without noticing `thrashDetector` and
`budgetTracker` already shared the same construction pattern, or that
`toolOutcomeCounter` (v0.8.0) would ship afterward with a docblock
claiming "process-lifetime" — an assumption this gap shows is false under
this topology.

Full investigation, why tracer/meter identity isn't affected (and is what
makes the bug observable via the metric at all), and a proposed fix —
a host-supplied `instanceKey` resolved through an internal, bounded
registry, argued against a module-level store and against exporting the
trackers as injectable public objects: ADR 012
(`docs/adr/012-tracker-lifecycle-and-shared-state.md`). Not yet
implemented; see that ADR's "Consequences" section for the recommended
release sequencing (a documentation-only caveat first, the
`instanceKey` fix as a later minor release).

---

## 7. `instrumentMcpServer()` silently instruments nothing when passed an MCP v2 server

**Target:** Must be closed *as part of* Phase 1 of ADR 015
(`docs/adr/015-mcp-v2-support.md`) — a loud rejection of unsupported
server kinds, not merely v2 support being added. This bug exists
independently of whether v2 support ever ships.
**Found by:** internal self-review, flagged during the ADR 015 Phase 0
investigation and confirmed live in a follow-up session — not a
code-reading hypothesis.

**Status update (v0.10.0): FIXED.** `detectServerKind()` now requires
`.server instanceof <Server>` for a REAL, resolved SDK class (either
`@modelcontextprotocol/sdk` or, once Phase 2 landed, `@modelcontextprotocol/server`)
before accepting a McpServer-shaped object — no longer just a duck-typed
`.server.setRequestHandler` presence check. An object that duck-types the
shape but matches neither installed SDK's `Server` class now throws a
specific, actionable error (`UNWRAPPABLE_MCPSERVER_ERROR`, naming what was
detected and the plausible causes) instead of silently instrumenting
nothing. Confirmed live, the same way the original bug was found: a real
`@modelcontextprotocol/server@2.0.0` `McpServer`, passed to the *fixed*
`instrumentMcpServer()`, now either (a) gets properly wrapped end to end
(once Phase 2's real v2 detection/wrapping also landed — same v0.10.0
release) or (b) throws immediately if only Phase 1's hardening were
deployed without Phase 2. Neither path silently succeeds while doing
nothing. Regression-tested: `test/instrument.test.js`'s "detectServerKind
hardening" describe block (a v1 McpServer still instruments unchanged; a
McpServer-shaped-but-unwrappable object throws with a message naming both
supported SDKs and all three plausible causes) and, for the full v2 case,
`test/instrument.v2.test.js` (a real v2 `McpServer`/`Server` produces
correct spans end to end). No escape hatch was added — see ADR 015's
Update section and `detectServerKind()`'s own docblock
(`src/instrument.js`) for the full argument against one.

### Body

**This precedes, and is more urgent than, entry 8 below.** Entry 8
describes a heuristic that misbehaves once MCP v2 telemetry is actually
flowing through this library. This entry is why no MCP v2 telemetry flows
at all today, through any code path, with today's shipped
`detectServerKind()` — entry 8's bug is currently unreachable *because*
this one prevents `wrapToolCallHandler` from ever running for a v2 server
in the first place.

`detectServerKind()` (`src/instrument.js`) recognizes a high-level
`McpServer` by duck-typing: an object with a `.server` property exposing
`setRequestHandler`, plus either a `.tool` or `.registerTool` function —
deliberately not `instanceof McpServer`, to avoid importing that class at
all (ADR 001). `@modelcontextprotocol/server@2.0.0`'s `McpServer`
satisfies this shape exactly: `.server` is a real `Server` instance
exposing `setRequestHandler`, and `.registerTool` exists (see ADR 015
Finding 1) — even though this package has never been tested against, and
does not intend to yet support, that package. The low-level branch
(`input instanceof Server`) correctly does not match a v2 `Server`, since
it's a different class from `@modelcontextprotocol/sdk`'s — but the
`McpServer` duck-type branch has no equivalent guard.

Once detected, `instrumentMcpServer()` proceeds normally:
`resolveOptions()` resolves, `assertInstrumentFirst()` passes (v2's
`Server` also exposes a working `assertCanSetRequestHandler` — ADR 015
Finding 2), a tracer is set up, all four trackers are constructed, and
`server.setRequestHandler` is patched. **That patch is where it silently
stops working.** It compares `schema === CallToolRequestSchema`, where
`CallToolRequestSchema` is the Zod object imported from
`@modelcontextprotocol/sdk/types.js` (v1). v2's `setRequestHandler` never
receives that object at all — it dispatches by the method name
**string** `'tools/call'` (ADR 015 Finding 1). The comparison is `false`
for every call, so the branch that wraps the handler in
span/fingerprint/thrash logic never runs, and every registration falls
through to `originalSetRequestHandler(schema, handler)` completely
unmodified.

**Confirmed live, not predicted from reading the code.** Constructed a
real `@modelcontextprotocol/server@2.0.0` `McpServer`, passed it to this
package's actual, shipped `instrumentMcpServer()`, registered a tool, and
invoked the captured `tools/call` handler directly, with
`@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter` wired up as the
global tracer provider so any span produced would be captured:

- `instrumentMcpServer()` returned **without throwing**, returning the
  same server object (`returned === input`), with `getThrashSummary` and
  `getObservationState` both attached as functions — every outward signal
  a caller can observe says "instrumentation succeeded."
- The tool call itself executed correctly and returned the right result
  (`{"content":[{"type":"text","text":"hello"}]}` for an echo tool) —
  nothing about the server's actual behavior is broken.
- **Zero spans were recorded.** No span, no `mcp.failure.*` attributes, no
  metrics, no thrash/budget/schema-drift bookkeeping — nothing. The tool
  call ran completely uninstrumented.

**Why this is worse than every other gap in this file.** Every other
entry here describes telemetry that's degraded, incomplete, or
occasionally wrong under specific conditions. This one produces **total,
silent telemetry loss**, with a success return value and no diagnostic of
any kind. A caller would only discover it by independently checking
whether their tracing backend received any spans at all — exactly the
class of problem "Observation liveness" (entry 2 above / ADR 008) exists
to catch for *other* causes of silent gaps, and this failure mode
bypasses that protection entirely: `getObservationState()` still reports
whatever it would report for a correctly-instrumented v1 server, since
nothing about this bug is visible to it.

**Scope: reachable today, independent of whether MCP v2 support ever
ships.** Unlike entry 8 below (which only matters once this package
actually understands v2 request/response shapes), this bug exists in the
currently-published `detectServerKind()`/`instrumentMcpServer()` as
shipped. Anyone who passes an `@modelcontextprotocol/server@2.0.0`
`McpServer` to today's `instrumentMcpServer()` — for any reason: an
accidental version mismatch, early experimentation, a dependency
resolution quirk — gets this silently, right now, with no library
changes required to trigger it.

**Workaround: none, from inside the library.** There is no configuration
option that surfaces this — it isn't gated behind
`thrashDetection`/`fingerprinting`/`costTracking`, it's a total bypass of
the wrapping mechanism itself, upstream of every one of those features.
The only mitigation is operational: verify the object passed to
`instrumentMcpServer()` was actually constructed from
`@modelcontextprotocol/sdk` (v1), not `@modelcontextprotocol/server`
(v2), and don't attempt to use this package against a v2 server until
official support ships (see ADR 015).

**What Phase 1 must do about this, per ADR 015's update:** add real v2
detection *and* make unrecognized/unsupported server kinds fail loudly —
this bug is a direct argument against shipping v2 detection as "recognize
v2 objects and wrap them" without also closing the gap where an
in-between or misdetected object (a v2 object that doesn't yet have full
wrapping support, or a genuinely unsupported third SDK in the future)
falls through to the same kind of silent success this entry documents.
"Reject what we don't understand, loudly" needs to be the default, not an
afterthought added once someone reports the silent gap.

---

## 8. `isSingleConnectionTransport()` misclassifies MCP v2's `createMcpHandler` transport as single-connection

**Target:** Before MCP v2 support is considered complete (see ADR 015,
`docs/adr/015-mcp-v2-support.md`, Phase 3)
**Found by:** internal self-review, ADR 015 Phase 0 investigation — not an
external report

**Status update (v0.10.0): FIXED.** Initially scoped out of the same
v0.10.0 work that shipped real MCP v2 support (see the superseded
paragraph below, kept for the record) and grouped instead with entry 6's
fallback-session-id gap as follow-up work — then investigated properly
and folded back into v0.10.0 before release, rather than shipping the
confirmed live false positive this entry describes. `isSingleConnectionTransport()`
(`src/instrument.js`) now takes a second parameter, `kind` (`'v1' | 'v2'`,
already resolved once per `instrumentMcpServer()` call by
`detectServerKind()` — no new detection work needed to get it), and
branches:

- **v1 (`kind === 'v1'`): completely unchanged**, byte-for-byte — still
  `!('sessionId' in transport)`. No confirmed bug ever motivated touching
  v1, and the investigation that preceded this fix explicitly argued
  against a global flip for exactly that reason (see ADR 015's Update).
- **v2 (`kind === 'v2'`): requires POSITIVE confirmation instead of
  inferring from an absent property.** `transport.constructor.name ===
  'StdioServerTransport'` (confirmed live: both SDKs' stdio transport
  classes report this exact name) is now what's checked for the "safe to
  treat as single-connection" case. `PerRequestHTTPServerTransport` — this
  entry's whole subject — has no such name and therefore falls to
  `false`, the same "undetermined" branch this function already had for
  any transport it couldn't confirm; `WebStandardStreamableHTTPServerTransport`
  remains correctly excluded via its own `sessionId` property, in both
  stateless and stateful construction, confirmed unaffected by this
  change.

Confirmed by test, not just reasoned about:
`test/integration/thrash-v2-transport-detection.test.js`'s
"v2 transport-detection matrix" describe block drives real
`PerRequestHTTPServerTransport`/`WebStandardStreamableHTTPServerTransport`/
`StdioServerTransport` instances (both v1's and v2's) through
`.connect()` and asserts on the actual `mcp.tool.loop.detected` outcome —
including a REGRESSION TEST specifically named as such for the live false
positive this entry reported, and a dedicated "v1 unaffected" describe
block asserting the no-behavior-change claim explicitly rather than
leaving it implicit.

**Why `.constructor.name`, given this entry's own body below (and ADR
015's original Finding 8) explicitly said "not by name/instanceof":** that
rejection conflated two different risks. `instanceof` requires importing
a class — which fails across independently-resolved copies of the same
package (the dual-package-hazard class of bug `detectServerKind()`
guards against) and, for an optional peer dependency, might not resolve
at all. `.constructor.name` requires no import of either SDK and is
immune to the dual-package-hazard problem specifically: a class's `.name`
is fixed by its declaration and identical across every resolved copy of
the package, unlike class *identity*, which `instanceof` depends on. See
ADR 015's Update section for the full correction and the honestly-stated
residual fragility (a bundler/minifier renaming the class would defeat
this check — but the failure mode is losing detection, the safe
direction, not fabricating loops).

**Superseded status update, kept for the record (originally read: "NOT
fixed — still stands, and is now a LIVE gap rather than a
forward-looking one"):** ADR 015 Phases 1–3 shipped real MCP v2 support
(`@modelcontextprotocol/server` is now a recognized, supported optional
peer — closing entry 7 above) without initially touching this heuristic.
`isSingleConnectionTransport()` was, at that point, confirmed
byte-identical to the implementation this entry was originally written
against. That was a deliberate scoping choice at the time, not an
oversight — this round of work explicitly carved this specific fix out
as follow-up, grouped with entry 6's fallback-session-id gap under what
ADR 015's own phased rollout plan calls "Phase 3 — session/thrash
correctness." It was then investigated and fixed before v0.10.0 actually
shipped, per the update above, rather than left open across a release
boundary.

### Body

**This entry describes behavior downstream of entry 7 above.** Entry 7
means no v2 telemetry — correct or otherwise — flows through today's
shipped code at all, for any request. This entry describes what would go
wrong *once entry 7 is fixed* and `wrapToolCallHandler` actually starts
running for v2 requests. Both need to be accounted for in the same Phase
1 implementation (ADR 015) that adds real v2 detection — closing entry
7's detection gap without also addressing this one would trade a silent
no-op for a silent false-positive, not fix the underlying problem.

This is also the opposite failure mode from entry 6 above, and a distinct
bug from that one too. Entry 6 is about thrash detection **under-firing**
(silently missing real loops) once a real session id is unavailable. This
entry is about the transport-detection heuristic that decides when to use
the generated per-connection fallback in the first place **over-firing** —
misclassifying a genuinely multi-client transport as safe for that
fallback, which then merges unrelated clients' failures into one
fabricated `mcp.loop.detected` loop.

`isSingleConnectionTransport()` (`src/instrument.js`) uses one structural
signal to decide whether `server.transport` is safe to treat as
single-connection: whether the transport object declares a `sessionId`
property at all. Both session-oriented v1 transports
(`StreamableHTTPServerTransport`, `SSEServerTransport`) declare it (even
when unset); `StdioServerTransport` does not, correctly, since stdio really
is one connection for the process's whole lifetime. The heuristic assumes
"no `sessionId` property" implies "genuinely single-connection like
stdio" — true for every transport `@modelcontextprotocol/sdk` (v1) ships.

**Confirmed false for MCP v2**, by constructing real instances of every
relevant transport class from the installed `@modelcontextprotocol/server@2.0.0`
package and testing `'sessionId' in instance` directly — not inferred from
`.d.mts` type declarations, which would have been misleading here (see
below):

| Transport | `'sessionId' in instance` | Heuristic's classification |
|---|---|---|
| `WebStandardStreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`) | `true` (own property, value `undefined`) | Correct — not single-connection |
| `WebStandardStreamableHTTPServerTransport`, stateful | `true` | Correct — not single-connection |
| `StdioServerTransport` | `false` | Correct — single-connection |
| `PerRequestHTTPServerTransport` | `false` | **Wrong — misclassified as single-connection** |

`PerRequestHTTPServerTransport` is the transport class `createMcpHandler`
constructs internally for every request under the 2026-07-28 protocol
revision (both its legacy-compat fallback and modern-era serving — the
primary new stateless HTTP surface MCP v2 introduces). It declares no
`sessionId` property at all — not because each instance is genuinely 1:1
with one client (it isn't; `createMcpHandler` serves arbitrary numbers of
distinct HTTP clients through instances of this class, one per request),
but because the 2026-07-28 revision removed the session concept from the
protocol entirely. The heuristic has no way to distinguish "no session
concept, because single-connection" (stdio) from "no session concept,
because the protocol revision doesn't have one" (`PerRequestHTTPServerTransport`)
— both present identically as "no `sessionId` property."
`WebStandardStreamableHTTPServerTransport`'s type declaration
(`sessionId?: string;`) looks superficially identical to what one might
guess `PerRequestHTTPServerTransport`'s would be — the two only diverge in
the compiled runtime object, which is why this needed to be checked
against the real package rather than assumed from types.

**Consequence, if this package instrumented a v2 server today:** every
call served through `createMcpHandler` would resolve
`isSingleConnectionTransport(server)` to `true`, triggering the fallback
session id path for every request (compounded by the fact that no v2
request will ever carry a real `sessionId` either, per entry 6's
2026-07-28 update above — so every call permanently takes this branch,
never the "real session id" branch). Different, unrelated HTTP clients'
tool-call failures would merge into one shared fallback key, and three
different clients each failing once would look identical to one client
failing three times in a row — a false-positive `mcp.tool.loop.detected`
event that never happened to any real client. This is the exact scenario
the README's "Session id resolution" section already warns
`assumeSingleSession: true` can cause on a misconfigured multi-client
transport — except here it would happen by default, from auto-detection,
with no operator opt-in required.

**Scope: not currently reachable.** This package's `detectServerKind()`
(`src/instrument.js`) only recognizes `@modelcontextprotocol/sdk`'s
`Server`/`McpServer` — it does not yet accept
`@modelcontextprotocol/server` (v2) objects, so no production deployment
can hit this today. It is documented now, during ADR 015's Phase 0
investigation, specifically so the eventual v2 implementation (ADR 015's
Phase 1–3) accounts for it from the start — the safe direction identified
there is defaulting `PerRequestHTTPServerTransport` to "not
single-connection" (the same posture the heuristic already takes for any
transport it can't positively confirm), once dual-SDK detection makes
"which SDK, and therefore which transport class" knowable at the call
site.

**Workaround, if evaluating v2 integration ahead of official support:**
`thrashDetection: { enabled: false }` fully suppresses the consequence.
Every code path that reads `isSingleConnectionTransport()`'s output
(`resolveThrashSessionId()`, feeding `applyThrashDetection()`/
`applyThrashSuccessClear()` in `src/instrument.js`) is downstream of a
`thrashConfig.enabled` check that no-ops immediately when the feature is
off — no fabricated loop event can be emitted regardless of what the
transport heuristic decided. This forfeits genuine thrash detection for
that server entirely; there is no narrower fix. `assumeSingleSession` does
not help here — it only adds a *second* way to reach the fallback path
(for transports auto-detection can't determine at all), it does not gate
away the auto-detected one this entry is about, and no configuration
option exists today to disable transport auto-detection on its own while
leaving real-session-id-based detection intact.

---

## 9. Budget guardrails cannot trip on unpriced spend, regardless of amount

**Target:** Unscheduled
**Found by:** internal self-review, v0.12.0 Phase 2/3 investigation into
the cost-aware sampling recipe (`docs/adr/011-cost-aware-sampling.md`) —
not an external report.

**Status update (v0.12.0): the visibility half is fixed; the behavior
question below remains open and unscheduled.** Assessed against exactly
the two options this entry's own "Possible directions" list below
sketched, and resolved for the smaller of the two: `createBudgetTracker()`
(`src/cost/budget.js`) now fires a one-time `diag.warn()` at construction
whenever `perSessionUsd`/`perToolUsd` is configured at all, naming the
constraint up front, and a second one-time `diag.warn()` — via a new
`recordUnpriced(model)` method, called from `applyCostAttribution()`'s
existing `costUsd === null` branch, the same branch that already sets
`mcp.tool.pricing_status: "unknown"` — the first time an unpriced call
under an active budget is actually observed, naming the model and which
scope(s) are configured. Both no-op when no budget is configured. Neither
changes `BudgetCheckResult`'s shape, adds a span attribute, or alters
`recordAndCheck()`'s behavior — this is diagnostics only, deliberately: an
unpriced call still contributes nothing to `perSessionUsd`/`perToolUsd`'s
running totals, exactly as this entry originally reported. What changed is
that the gap is now loud rather than silent, not that it's closed.

**Why the second option (routing unpriced calls into the tracker with an
explicit marker) was not built.** Argued explicitly before implementing
anything: making an unpriced call actually *count* toward a USD budget
means inventing a number for it — a configurable fallback price, or some
other stand-in — and a wrong fallback price is a *different*
confidently-wrong number, not a fix for the underlying disease this
library exists to catch. The whole value of a budget guardrail is that its
number can be trusted; manufacturing one to fill a gap would trade one
silent-failure shape for a quieter, harder-to-notice one wearing a "the
budget is working" costume. That direction also isn't a small addition —
it needs a real decision about what "exceeded" even means for a call with
no priced cost (a new token-count threshold? an "unknown = immediately
over budget" policy?), new public type/attribute surface, and by this
project's own consistent practice for exactly this class of decision
(ADR 011, ADR 016, ADR 018 all gated a public behavior/API change behind
an ADR before code), its own investigation — not something to fold
silently into a diagnostics-only patch. Left here as still open and
unscheduled, not attempted.

**Tests:** `test/cost/budget.test.js`'s two new describe blocks
(construction-time warning, `recordUnpriced()`) cover both warnings' exact
one-time-per-tracker-instance firing behavior, the no-budget-configured
no-op case, and that the warning names the model and configured scope(s).
Confirmed live end-to-end through the real `instrumentMcpServer()` entry
point too (a real unrecognized-model tool result, a configured
`perSessionUsd`, both warnings fire once each, a second identical call
re-fires neither).

### Body

`applyCostAttribution()` (`src/instrument.js`) only calls
`budgetTracker.recordAndCheck()` (`src/cost/budget.js`) inside its
`if (costUsd !== null)` branch:

```js
if (costUsd !== null) {
  span.setAttribute(ATTR_MCP_TOOL_COST_USD, costUsd);
  span.setAttribute(ATTR_MCP_TOOL_COST_CURRENCY, MCP_TOOL_COST_CURRENCY_USD);
  metricsRecorder?.recordCost(toolName, usage.model, costUsd, pricingStatus);

  const budgetResult = budgetTracker.recordAndCheck(sessionId, toolName, costUsd);
  ...
}
```

`costUsd` is `null` whenever `calculateCost()` doesn't resolve a price —
no model detected, or a detected model with no pricing-table entry — which
is exactly the case `mcp.tool.pricing_status` (ADR 016 point 4) exists to
flag as `"unknown"` rather than silently reporting as free. That attribute
fix stopped short of `budget.js`: a call whose usage extraction succeeded
(so real, non-zero token consumption is confirmed) but whose model is
unpriced **never reaches `recordAndCheck()` at all** — not "recorded as
$0," genuinely never called. `sessionCostMap`/`toolCostMap` (both in
`createBudgetTracker()`) accumulate real cost only; an unpriced call
contributes nothing to either running total, no matter how many tokens it
burned.

**Concrete consequence:** a session or tool that racks up substantial
token spend exclusively through an unlisted/unrecognized model (a new
provider release ahead of `DEFAULT_PRICING`, or a custom
`costTracking.pricing` override with a typo'd model key) can never trip
`perSessionUsd`/`perToolUsd`, ever — `mcp.tool.cost.budget_exceeded` stays
permanently unset for that session/tool regardless of actual usage,
identical in shape to the "confidently wrong zero" problem ADR 016 fixed
at the attribute level, one layer deeper: this time the guardrail meant to
act on that number is the thing silently blind, not just a dashboard
reading it.

**Why this is a library-behavior question, not the sampling recipe's:**
found during the same investigation that added the recipe's
`mcp.tool.pricing_status = "unknown"` tail-sampling policy (see
`packages/core/README.md`'s "Cost-aware trace sampling" section), but that
policy only affects which *traces a Collector retains* — it cannot make
`budgetTracker` itself see spend it was never called with. Closing this
gap means deciding what `recordAndCheck()` should actually do with an
unpriced call (accumulate against a token count instead of USD? track it
as a separate "unpriced spend" scope? warn once per session/tool the first
time it happens?) — a real design question, not a one-line fix, so this is
recorded rather than patched in-place.

**Possible directions, not decided:**

- Track unpriced-call *token* totals per session/tool alongside the
  existing USD maps, and expose them (a new
  `mcp.tool.cost.budget_exceeded`-adjacent attribute, or a
  `getThrashSummary()`-style accessor) so an operator can at least see
  "N unpriced tokens this session" even without a USD figure to threshold
  on.
- A configurable fallback price for unrecognized models (a "treat unknown
  as expensive" opt-in), so budget tracking fails toward over-counting
  rather than silently under-counting — mirrors this codebase's existing
  "fail toward under-detection, never over-detection" principle for thrash
  detection's transport heuristic (see entry 8 above), but inverted, since
  here silence is the unsafe direction, not the safe one.
- Do nothing beyond documenting it: budget tracking has always been
  best-effort/observability-only (`src/cost/budget.js`'s own module
  docblock: "never blocks a tool call and never throws"), and an operator
  running unlisted models may already be expected to supply
  `costTracking.pricing` overrides for them.
