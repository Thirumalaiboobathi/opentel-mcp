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
**Raised by:** [reporter attribution — fill in]

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
