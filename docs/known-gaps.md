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

---

## 10. Three raw-content channels reach spans; the largest isn't in the custom `mcp.*` attributes at all

**Target:** The two low-risk items below are fixed. `recordException`/
`setStatus` and `mcp.tool.model` remain unscheduled — each needs its own
ADR before a fix, per this entry's original "No fix proposed here"
reasoning.
**Found by:** internal self-review — a raw-content audit of every
attribute and span event this package emits, prompted by re-checking ADR
012's (`docs/adr/012-tracker-lifecycle-and-shared-state.md`) claim that
every attribute this library emits today is library-computed metadata.

**Status update: items 3 and "error_class" fixed; items 1 and 2 remain
open, deliberately.** `mcp.failure.validation_paths` format 1
(`parseZodIssuesArray()`, `fingerprint/classify/validation-paths.js`) now
gates each string path segment through `PATH_SEGMENT_RE`, the same
identifier-only shape formats 2/3 already required — a segment that isn't
schema-identifier-shaped (a `z.record()` schema's runtime key) is replaced
with the placeholder `<KEY>` rather than surfaced, dropped, or silently
omitted (see the constant's own comment for the three-way argument: drop
the whole path loses the signal entirely; dropping just the segment
fabricates a path to a *different*, real field; a placeholder is the only
option that does neither). Numeric (array-index) segments are never
redacted — Zod only ever produces those for array indices, never object
keys. `mcp.failure.error_class` (`fingerprint/attributes.js`) is now
capped at 128 characters by `computeFingerprint()`
(`fingerprint/compose.js`'s `MAX_ERROR_CLASS_LENGTH`) — length-bounded
only, not pattern-scrubbed, since a class identifier isn't expected to
contain the structured-PII shapes `normalizeMessage()` scrubs for; a
non-string `.name` is coerced to a string before capping rather than
throwing. ADR 004 (`docs/adr/004-semantic-conventions-alignment.md`) is
updated where it called the same underlying `err.name` value
"low-cardinality" for `error.type` — that was an assumption about
well-behaved code, not an enforced property, and `error.type` itself
remains uncapped (a separate, spec-owned attribute outside this fix's
scope). `recordException`/`setStatus({ message })` and `mcp.tool.model`/
`gen_ai.response.model` are untouched, on purpose — see the Body's own
"No fix proposed here" reasoning below, which still holds for both.
**Tests:** `test/fingerprint/classify.validation-paths.test.js`'s new
"dynamic/record keys are redacted" describe block (identifier paths
unaffected, a record-shaped email key redacted, a root-level dynamic key,
numeric segments never redacted, mixed identifier/dynamic segments in one
path, independent redaction across multiple issues in one array) and
`test/fingerprint/compose.test.js`'s new cases (128-char cap, short names
untouched, two names sharing a 128-char prefix hash identically — a
documented tradeoff, not a bug — and a non-string `.name` coerced rather
than throwing).

### Body

Traced every `mcp.*`/`gen_ai.*` attribute and every span event this
package emits back to where its value originates. The custom attribute
surface this project has been actively governing — fingerprint, thrash,
schema-drift, cost provenance — holds up: closed enums, hashes, counts,
and numeric measurements throughout. `classifyFailureChannel()`
(`src/fingerprint/classify/channel.js`) reads message text internally but
only ever *returns* one of six closed enum values, so no raw text escapes
into `mcp.failure.channel`. `normalizeMessage()`
(`src/fingerprint/normalize/message.js`,
`src/fingerprint/normalize/patterns.js`) scrubs UUIDs, emails, URLs, IPs,
timestamps, filesystem paths, hex runs, and quoted opaque ids before
hashing, and the normalized string itself is never emitted as its own
attribute — only hashed into `mcp.failure.fingerprint`, or folded
(truncated to 60 chars, and only the stack frame's function name/line, not
message content) into `mcp.failure.signature`.

But three paths do carry raw, application-controlled content onto spans,
and the largest of the three isn't in the custom attribute surface at
all — it's two stdlib OTel calls that predate, and fall outside, all of
the governance work above.

**1. `span.recordException(err)` / `span.setStatus({ message: err?.message })`
— the largest exposure, present since the earliest instrumentation.**

Both thrown-exception paths call these two in sequence: tools/call at
`src/instrument.js:1458-1459`, tools/list at `src/instrument.js:1583-1584`.

```js
span.recordException(err);
span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
```

`recordException` is the OpenTelemetry JS SDK's own `Span` method — it
adds an `exception` span event carrying `exception.message` (= `err.message`)
and `exception.stacktrace` (= `err.stack`), verbatim, with no length cap.
`setStatus`'s `message` puts the same raw `err.message` on the span a
second time, as the status description. Neither call is gated by
`fingerprintingEnabled` — both fire on every thrown exception
unconditionally, whether or not fingerprinting is on — and neither goes
through `normalizeMessage()` or any other scrubbing step in this codebase:
they run directly against `err`, entirely outside the fingerprint
pipeline (`computeFingerprint()`, `src/fingerprint/compose.js`, only runs
afterward and separately, feeding the hashed/normalized `mcp.failure.*`
attributes from the same `err`). If a thrown error's message or stack
contains an email address, a credential, a connection string, or a
username-bearing file path, it lands on the span exactly as thrown.

This isn't a hidden accident either — `docs/adr/013-ui-query-layer.md:86-87`
documents querying `event.exception.message` directly as an ordinary
TraceQL example, treating it as a normal queryable field, not something
flagged anywhere as unscrubbed or sensitive.

**2. `mcp.tool.model` / `gen_ai.response.model` — a tool result's own
content, echoed verbatim. Since v0.5.0.**

`readModel()` (`src/cost/extractor.js:83-97`) reads `result.model`,
`result.usage.model`, or `result._meta.model` — including from JSON
parsed out of `result.content[0].text` — gated by nothing stronger than
`typeof candidate === 'string' && candidate.trim() !== ''`. `applyCostAttribution()`
(`src/instrument.js:816-818`) sets both attributes to that value
unmodified:

```js
if (usage.model) {
  span.setAttribute(ATTR_MCP_TOOL_MODEL, usage.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, usage.model);
}
```

No allowlist against `DEFAULT_PRICING`'s known models, no length cap —
this is a tool result's own declared field, put on the span exactly as
the tool (or whatever produced the tool's response) wrote it.

**3. `mcp.failure.validation_paths`, format 1 only — scoped and
conditional, not a blanket gap.**

`parseZodIssuesArray()` (`src/fingerprint/classify/validation-paths.js:165-188`),
which handles the JSON-issues-array rendering (SDK ≤1.29.0, or any
low-level `Server` author who throws a raw, unrendered `ZodError`), joins
Zod issue `path` segments with no character restriction — whatever string
or number Zod put in `path` is used as-is. For a `z.record()`-shaped
schema, Zod's `path` includes the actual runtime key the caller passed —
e.g. an email address used as an object key — so that value reaches
`mcp.failure.validation_paths` unfiltered whenever a failure renders in
this format. The two newer formats — `extractRenderedPaths()` (SDK
≥1.30.0) and `extractV2Paths()` (`@modelcontextprotocol/server` v2) — are
safe: both are gated by `RENDERED_DOT_PATH_RE`/`V2_ISSUE_START_RE`,
identifier-only regexes that cannot carry arbitrary content. This gap
requires both a dynamic-key schema and the older/raw rendering path to be
live at once.

**Also flagged, an already-known tradeoff rather than a new finding:
`mcp.failure.error_class`.**

`inputs.errorClass = coerced.name` (`src/fingerprint/compose.js:124`) is
`err.name` (or `obj.name` for a non-`Error` throwable), set on the span
unmodified at `src/fingerprint/attributes.js:88` — no truncation, no
scrubbing, unlike `normalizedMessage`, which gets both. In practice
`err.name` is almost always a fixed class identifier ("TypeError",
"ZodError"), but nothing enforces that — a tool author who assigns an
arbitrary string to `.name` puts it on the span raw. The identical raw
value also reaches `error.type` on the thrown path
(`src/instrument.js:1460`), which ADR 004
(`docs/adr/004-semantic-conventions-alignment.md:62-79`) already accepts
as a deliberate tradeoff, describing the exception class name as
"low-cardinality." That description is an assumption about how tool
authors and thrown values behave, not a property this library measures or
enforces anywhere.

**What this means for ADR 012's boundary.** ADR 012
(`docs/adr/012-tracker-lifecycle-and-shared-state.md:923-938`) rejected
reading a host-designated tool argument specifically because it would be
"the first attribute carrying a value the *application* chose to put in a
tool argument" — a categorically different risk than anything this
library emitted at the time that decision was written. Read literally,
that's still true: nothing reads `request.params.arguments` values today.
But the boundary the ADR was actually protecting — raw, unbounded,
application-controlled content reaching a span — is already crossed, by
mechanisms that weren't in view when that decision was made:
`recordException`/`setStatus` (stdlib OTel behavior, not this package's
own attribute code) and `mcp.tool.model` (a tool *result* field, not an
argument). "Tool argument" vs. "tool result" vs. "exception message" does
not hold up as a privacy boundary on its own — a tool author, or a
compromised or buggy tool, controls the content of all three equally.

**No fix proposed here, deliberately — both real candidates cut against
something this project already committed to elsewhere.** Scrubbing or
gating `recordException`/`setStatus` would diverge from the
exception-recording behavior every other OTel-instrumented library in a
user's stack already produces for the exact same kind of error — silently
different behavior for this one library's spans is its own kind of
surprise for an operator reading a trace. Capping or allowlisting
`mcp.tool.model` changes what `applyCostAttribution()` accepts as a valid
model identifier, which has direct, non-cosmetic consequences for
cost/budget attribution (`docs/adr/016-pricing-override-and-staleness.md`):
a narrower model-matching rule could start silently missing calls that are
today priced correctly. Both need their own scoped decision — the same
way ADR 011, ADR 016, and ADR 018 each got one before the corresponding
code changed — not a bundled patch folded into this entry.

## Update (2026-08-30): both remaining items now have a design — ADR 019

The two items left open after the direct fix above — `recordException`/
`setStatus({ message })` and `mcp.tool.model`/`gen_ai.response.model` —
each got the scoped decision this entry said they needed. ADR 019
(`docs/adr/019-raw-content-on-spans.md`) first settles the framing
question that decides how to weigh both (checked against OpenTelemetry's
own semantic-conventions guidance on `exception.message`/
`exception.stacktrace` sensitivity, rather than inventing a position), then
designs: a new `errorRecording.mode` (`'full'` | `'normalized'` |
`'none'`) option for the exception-recording pair, defaulting to today's
unchanged `'full'` behavior; and a length/character-allowlist gate for
`mcp.tool.model`, with rejection routed through the same
`pricing_status: 'unknown'` + one-time-warning machinery
`docs/known-gaps.md` entry 9 already established, specifically so
rejection can never become a silent drop. Design only, as of this update
— no code has changed for either item. Recommended target: v0.13.0 for
both, paired.

## Update (2026-08-30): both items implemented in v0.13.0 — one still open by design, not by omission

Both of ADR 019's designs have shipped in full:

- **`errorRecording.mode`** (Part 1) is implemented exactly as designed —
  `'full'` / `'normalized'` / `'none'`, threaded through both thrown paths
  (`tools/call` and `tools/list`), `'normalized'` reusing
  `normalizeMessage()`/`parseAndNormalizeStack()` rather than a new
  scrubbing pipeline, `error.type`/`exception.type` now capped at 128
  characters unconditionally in every mode. See the README's "Error
  recording" section.
- **`mcp.tool.model` validation** (Part 2) is implemented exactly as
  designed — the `[A-Za-z0-9._:/@-]{1,256}` allowlist gates entry into
  `applyCostAttribution()`'s model-bearing attributes and metric labels;
  a rejected value sets `mcp.tool.pricing_status: 'unknown'` and fires a
  one-time, shape-only `diag.warn()` (length and which check failed,
  never the value); `budgetTracker.recordUnpriced()` now receives the
  validated (possibly `undefined`) model rather than the raw tool-result
  value, closing a second leak path through its own pre-existing warning
  that the ADR's own pseudocode had not accounted for. See the README's
  "Model identifier validation" section.

**`errorRecording` still defaults to `'full'` — this entry's original
exposure is unchanged for anyone who doesn't opt in.** ADR 019 Part 1
deliberately kept the default unchanged for all of `0.x` (see its "Argue
the default"); shipping the config surface is the fix landed this
release, not a change to what a default-configuration deployment already
sends. A deployment running with no `errorRecording` option set still
puts raw `err.message`/`err.stack` on every thrown-exception span exactly
as it did in every prior release — this is the intended, documented state
of this entry until a future major version revisits the default, not an
oversight. `mcp.tool.model`'s gate, by contrast, ships default-on with no
opt-out, per ADR 019 Part 2's asymmetry argument (a shape gate costs a
well-behaved tool nothing, unlike a content-scrubbing policy).

Both items are still tracked here — not closed out — for exactly that
reason: the underlying content-exposure this entry originally raised for
`recordException`/`setStatus` remains real and reachable at the default
configuration, by design, until 1.0.

## Update (2026-09-01): `errorRecording.mode` is scoped to this library's own span, not the trace — a documentation gap, not a new code gap

**Raised by:** external review (r/mcp), prompted by the observation that
`errorRecording.mode` only controls what THIS library puts on a span,
with no way to stop other instrumentation in the same process from adding
its own, unscrubbed exception content to a different span in the same
trace.

**Confirmed live, not just reasoned about.** Built a minimal reproduction:
an `instrumentMcpServer()`-wrapped server with `errorRecording: {
mode: 'normalized' }`, run under a real ambient context manager
(`AsyncLocalStorageContextManager` — the propagation mechanism production
deployments actually use for context to survive an `await`; this
project's own test suite registers `contextManager: null` instead, which
disables ambient propagation entirely — see this update's second half
below for what that means for existing test coverage), wrapped in an
outer span standing in for a generic APM agent or HTTP/framework
auto-instrumentation. The tool handler throws an `Error` whose message
contains an email address. The outer span catches the rethrown error and
calls a plain, standard-library `span.recordException(err)` on itself —
nothing exotic, exactly what that class of instrumentation commonly does
around a request handler. Result, read directly off an
`InMemorySpanExporter`: both spans share one trace ID, with the tool span
correctly parented under the outer span; the tool span's `exception`
event carries the scrubbed message (`"...for <EMAIL>"`); the outer span's
`exception` event AND its `status.message` both carry the original, raw
email, unscrubbed.

**Why this isn't a bug in `errorRecording.mode` itself.** The mode does
exactly what the README always said it does — governs what
`recordThrownException()` (`src/instrument.js`) puts on the span
`wrapToolCallHandler`/`wrapToolsListHandler` create for the current call.
The README's "No mode mutates the original `err`" sentence
(`packages/core/README.md`, "Error recording" section) already disclosed
the mechanism: both call sites rethrow the untouched `err` afterward.
What the README did not say plainly is the consequence — that the
unmodified, fully raw `err` is exactly what reaches anything further out
in the call stack, and if that code independently records it (its own
`recordException()` call on its own, ancestor span — reachable because
this library's span is a child of whatever span was already active when
the request handler ran, via ordinary OTel context propagation, not
anything this library does deliberately), the raw content lands in the
same trace regardless of `errorRecording.mode`. `'none'` provides no more
protection here than `'normalized'`: neither mode mutates `err`, so an
outer recorder sees the identical raw content either way.

**Not fixable from inside this library.** The only way to close this from
here would be mutating `err.message`/`err.stack` in place before
rethrowing — which the README already argues against for a different,
still-valid reason (silently rewriting a thrown error's content out from
under whatever the host application's own error handling does with that
same object afterward is a correctness hazard, not just a telemetry
one). This library controls one span; it has no visibility into, and no
authority over, what any other instrumentation attached to the same
process does with the error it rethrows. Treated as a documentation gap,
not a code gap: `packages/core/README.md`'s "Error recording" and "What
this library records" sections are updated (same release as this update)
to state the span-vs-trace scoping explicitly, rather than proposing a
code change here.

**Separate finding surfaced by writing the reproduction: this project's
own test suite cannot see this class of issue at all, by construction.**
`test/instrument.error-recording.test.js` and every other span-emitting
test in `packages/core/test/` register their `NodeTracerProvider` with
`contextManager: null` (see each file's `beforeEach`). Directly checked:
with `contextManager: null`, no context manager is installed at all, so
there is no ambient-context propagation across an `await` boundary — an
outer `tracer.startActiveSpan()`'s span does NOT become the active
context inside an inner `await`ed call the way it does in every real
deployment (which needs a working context manager, typically
`AsyncLocalStorageContextManager` via `@opentelemetry/sdk-trace-node`'s
`NodeTracerProvider.register()` default, or whatever the host's own SDK
setup installs). Concretely reproduced: the same repro above, first run
with `contextManager: null` exactly as the existing suite configures it,
produced two spans with **different, unrelated trace IDs** — not a
parent/child relationship at all — even though the outer span was
demonstrably still "active" by every synchronous measure at the point the
inner span was created. Only re-registering with a real
`AsyncLocalStorageContextManager` produced the correct, single-trace,
parent/child result reported above. This means: any existing or future
test in this suite that asserts on parent/child span structure, trace ID
continuity across an `await`, or "is this the active span" behavior is
implicitly running in a configuration that cannot represent how context
actually propagates in a deployed instance. Scoped separately, not fixed
here: see the follow-up investigation into exactly which existing tests
depend on this and whether they can be moved to a real context manager
without breaking (tracked outside this file, as a test-infrastructure
question rather than a content-exposure one).

---

## 11. `gen_ai.tool.name` (and two related attributes) carry unvalidated, unbounded values onto metric labels

**Target:** Unscheduled — the real options each have a genuine cost and
need their own decision, per this entry's own "Possible directions" below.
**Found by:** internal self-review — an audit of whether
`METRIC_SAFE_ATTRIBUTES` (`src/fingerprint/attributes.js`) bounds metric
label *values*, not just which attribute *keys* are allowed onto a label —
not an external report.

### Body

**`gen_ai.tool.name`'s value is `request.params.name` — incoming request
content, never validated against the server's registered tool set.**
`src/instrument.js:1569`: `const toolName = request?.params?.name;`, inside
`wrapToolCallHandler()`. Nothing between that line and any of the sinks
below checks `toolName` against what the server actually has registered.

**This makes reachability much broader than "a server that registers
tools dynamically."** `metricsRecorder?.recordCall(toolName)`
(`src/instrument.js:1617`, immediately after span-attribute setup) fires
unconditionally, *before* `await handler(request, extra)`
(`src/instrument.js:1618` onward) — i.e., before the underlying MCP SDK
handler has had any chance to look `toolName` up and fail with "tool not
found." **The call fails; the label is recorded first.** Any caller —
not an operator's own dynamic registration, not an unusual deployment
shape, just an ordinary `tools/call` request naming a tool that doesn't
exist — puts an arbitrary string on a metric label. Dynamic tool
registration (real, and confirmed live against both installed SDKs —
`notifications/tools/list_changed` is spec-level wire protocol, and
`registerTool()`/`.update()` are callable post-`connect()` in both
`@modelcontextprotocol/sdk` and `@modelcontextprotocol/server`) is a
*second*, additive path to the same problem, not the only one.

**Twelve metric instruments across three files carry this value as a
label, all traced directly to `toolName`/`event.toolName`:**

- `src/metrics.js` — `recordCall()` → `mcp.tool.calls` (line 110),
  `recordError()` → `mcp.tool.errors` (116), `recordSilentFailure()` →
  `mcp.tool.silent_failures` (123), `recordDuration()` →
  `mcp.tool.duration` (129), `recordTokens()` → `mcp.tool.tokens.total`
  (136), `recordCost()` → `mcp.tool.cost.total` (143) — six instruments,
  one shared `ATTR_GEN_AI_TOOL_NAME` key.
- `src/thrash/emitter.js:100-105` — one `metricAttrs` object,
  `{ [ATTR_GEN_AI_TOOL_NAME]: event.toolName }`, shared across five
  instruments: `detected`, `length`, `wastedTokens`, `wastedCostUsd`,
  `duration`. That module's own docblock (lines 16-20) already excludes
  `mcp.failure.fingerprint`/`mcp.loop.session_id` from every metric here
  as "unbounded, per-caller values" — the same reasoning this entry
  applies to `gen_ai.tool.name`, which the docblock does not apply it to.
- `src/schema-drift/emitter.js:83-88` — the `detected` counter,
  `{ [ATTR_GEN_AI_TOOL_NAME]: event.toolName, ... }`, one instrument.
  `event.toolName` here comes from a `tools/list` response's own
  registered-tool entries (not a `tools/call` request), so this one
  instance genuinely does depend on how many tools are registered, not on
  arbitrary request content — worth distinguishing from the other eleven.

**`mcp.tool.model` shares the same root cause, and its own docblock says
so.** `readModel()` (`src/cost/extractor.js:83-97`) returns the first
non-empty string found at `result.model`/`result.usage.model`/
`result._meta.model` — a tool's own response content, not checked against
`DEFAULT_PRICING`'s keys or any other closed list. `src/metrics.js:60-62`'s
docblock states the justification explicitly: *"Model names are bounded in
practice by how many distinct models a deployment actually calls, the
same cardinality argument this package already relies on for
`gen_ai.tool.name` on every other counter."* If that argument doesn't
hold for `gen_ai.tool.name` — and the request-content reachability above
says it doesn't — it doesn't hold here either, by the docblock's own
citation. One real difference, not present for `gen_ai.tool.name` at all:
`mcp.tool.model` does pass through a shape gate, `isValidModelId()`
(`src/cost/calculator.js:46,61-62` — `/^[A-Za-z0-9._:/@-]{1,256}$/`),
wired into `applyCostAttribution()` at `src/instrument.js:919-923` (ADR
019 Part 2). That bounds the *length and character set* of any one value,
the same way `error.type` is bounded below — it does not bound the *size
of the set* of distinct values a generous 256-character identifier
pattern still admits, so the cardinality concern stands even though the
"zero validation" framing that's accurate for `gen_ai.tool.name` isn't
quite accurate here.

**`error.type` reaches `mcp.tool.errors` despite `mcp.failure.error_class`
being deliberately excluded from `METRIC_SAFE_ATTRIBUTES` for exactly this
reason — a gap in the mechanism, not just this value.**
`METRIC_SAFE_ATTRIBUTES` (`src/fingerprint/attributes.js:87`) is
`Object.freeze([ATTRIBUTE_KEYS.CATEGORY, ATTRIBUTE_KEYS.ORIGIN])` —
`ERROR_CLASS` is pointedly not in that list, and that file's own docblock
(lines 24-33) explains why: `err.name`, capped at 128 characters but "not
pattern-scrubbed... a class name isn't expected to contain structured PII
shapes, but nothing enforces that." Yet the *identical underlying value*
still reaches a metric label: `error.type` (`ATTR_ERROR_TYPE = 'error.type'`,
`src/attributes.js:37`) is computed at `src/instrument.js:1715` —
`String(err?.name ?? 'Error').slice(0, MAX_ERROR_CLASS_LENGTH)`, the same
128-character cap `error_class` uses, via the same shared constant — and
passed straight into `recordError()` (`src/instrument.js:1762`) →
`mcp.tool.errors`. `METRIC_SAFE_ATTRIBUTES` never gets consulted for this
value at all, because `ATTR_ERROR_TYPE` is tracked in `src/attributes.js`
as a spec-defined OTel semantic-convention attribute, a separate
governance surface from `src/fingerprint/attributes.js`'s
fingerprint-specific one. The allowlist's protection only covers
attributes that flow through the module it lives in — it has no way to
stop a spec attribute, set directly by `instrument.js`/`metrics.js`, from
carrying the exact value the allowlist was built to keep off a label.
`error.type` is length-bounded, same as `error_class` — it is not
*set*-bounded, and `METRIC_SAFE_ATTRIBUTES` was never in a position to
apply its judgment to it either way.

**The actual consequence: silent loss of per-tool granularity, not a
memory leak or a crash — and the protection is entirely the host's, not
this library's.** This library never constructs a `MeterProvider`
(`src/metrics.js`'s `setupMeter()` resolves whatever the host application
registered, or a no-op). The installed `@opentelemetry/sdk-metrics@2.9.0`
implements the OTel spec's default cardinality limit — 2000 distinct
attribute-combinations per instrument
(`node_modules/@opentelemetry/sdk-metrics/build/src/state/DeltaMetricProcessor.js`,
`MetricCollector.js:68`'s `?? 2000` default). The 2001st+ distinct
combination on any one instrument collapses into a shared
`{'otel.metric.overflow': true}` bucket rather than growing without
bound. So the mechanical failure mode, once a deployment crosses that
threshold on any one of the twelve instruments above, is: every
additional distinct `gen_ai.tool.name` (or `mcp.tool.model`, or
`error.type`) value's calls/errors/duration/etc. silently merge into one
undifferentiated overflow series — a real observability degradation
(exactly the per-tool signal these metrics exist to provide, lost,
silently), but bounded memory, not a leak. Two caveats this library
cannot control or verify: (1) that protection depends entirely on the
host's own `@opentelemetry/sdk-metrics` version and reader actually
implementing the spec's cardinality-limit feature — an older SDK, or a
non-compliant custom reader, has no equivalent backstop; (2) this library
applies **no cap of its own** on `gen_ai.tool.name` (nothing — no length
limit, no character allowlist, no dedup ceiling), unlike the 128-character
cap it does apply to `error_class`/`error.type`. The self-imposed
mitigation this codebase already uses elsewhere for exactly this class of
risk was simply never applied to the attribute this entry is about.

**This has not been previously investigated, and two existing ADRs assert
the opposite as settled fact — both need to be read as superseded by this
entry, not as still-current.**

- `docs/adr/012-tracker-lifecycle-and-shared-state.md:580-584`: *"`mcp.tool.cost.total`
  is already exported today with exactly `gen_ai.tool.name` +
  `mcp.tool.model` — both metric-safe, bounded labels (verified directly
  against a running exporter while building
  `dashboards/grafana-mcp-health.json`...)."* What was verified there is
  that the label mechanism exports correctly, not that the underlying
  value space is bounded — this entry is the first place that assumption
  is actually tested, and it doesn't hold.
- `docs/adr/010-schema-drift.md:280-284`: *"attributes `gen_ai.tool.name`
  (the existing attribute already used as a metric label on every other
  `mcp.tool.*` counter... so this isn't a new cardinality precedent, it's
  reusing one already accepted)."* That ADR explicitly built a thirteenth
  consumer of this value on the strength of it having been "already
  accepted" — a precedent this entry finds was never actually established,
  only assumed and then propagated forward.

Neither passage should be treated as a live justification for
`gen_ai.tool.name`'s cardinality safety going forward; this entry is that
re-examination, and the correction lives here rather than by rewriting
either ADR's original text, matching this file's own established
convention (entries 6, 7, 8 above all carry forward corrections as
appended updates, not edits to the original reasoning).

**Possible directions, not decided — each has a real cost, and this entry
takes none of them:**

- **Validate `toolName` against the server's live registered-tool set
  before it reaches any sink** (span attribute, metric label, or the span
  name itself) — closes the gap at the source, but needs a decision about
  what happens to a genuinely unknown name: reject the call outright
  (a behavior change on the JSON-RPC error path this project has
  historically been careful about — see entry 3's own "Pre-handler
  parse-failure gap" for how sensitive that path already is), or record it
  differently (see below) while still letting the call fail normally.
- **Bucket an unrecognized tool name to a fixed placeholder (e.g.
  `"unknown"`) on metric labels specifically, while leaving the span
  attribute untouched** — bounds cardinality without touching the
  JSON-RPC error path at all, but loses per-unknown-tool metric signal
  entirely (every bad tool name, or every not-yet-registered dynamic one,
  collapses into one bucket — indistinguishable from every other one, the
  same shape of loss the SDK's own overflow bucket already produces once
  cardinality crosses 2000, just triggered deliberately and much earlier).
- **Do nothing beyond documenting it** — the failure mode is real but
  bounded (per-instrument overflow, not unbounded memory), and a
  deployment with genuinely low tool-name cardinality (the common case)
  is unaffected regardless. This is the option already in effect as of
  this entry.

Any of the above needs its own scoped decision before code changes, per
this project's own established practice for exactly this class of
tradeoff (ADR 011, ADR 016, ADR 018, ADR 019, ADR 020 were all argued
through an ADR before implementation) — not something to patch inline
alongside this entry.
