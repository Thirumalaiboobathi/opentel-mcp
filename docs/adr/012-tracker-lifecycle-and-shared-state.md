# ADR 012: Tracker lifecycle and shared state across `instrumentMcpServer()` calls

**Status:** Proposed — design only, no implementation. Confirms and scopes an
internally-found bug; recommends a direction but does not build it.

**Found by:** internal self-review — testing this library against a
"stateless" Streamable HTTP deployment shape (a fresh `Server` per incoming
HTTP POST, re-instrumented each time), not an external report.

## Context

Finding: Agent Thrash Detection cannot fire on a "stateless" Streamable HTTP
deployment shape — a fresh `Server`/`McpServer` + transport constructed per
incoming HTTP POST, with `instrumentMcpServer()` called fresh on each one.
Every tracker resets before reaching any threshold; nothing ever fires, and
nothing warns that it isn't firing.

This was verified, not assumed. Reading `src/instrument.js` directly
confirms the claim, and — critically — shows it is not specific to thrash
detection. **All four in-memory trackers this package maintains are
constructed as local variables inside `instrumentMcpServer()`'s own
function body, freshly, on every single call:**

| Tracker | Site | Purpose |
|---|---|---|
| `budgetTracker` | `instrument.js:194` | Cumulative per-session/per-tool cost budget (`src/cost/budget.js`, v0.5.0) |
| `thrashDetector` | `instrument.js:200` | Consecutive same-fingerprint failure tracking (`src/thrash/detector.js`, v0.6.0) |
| `toolOutcomeCounter` | `instrument.js:245` | Cumulative success/failure/unknown counts (`src/observation/tool-outcome-counter.js`, v0.8.0) |
| `schemaDriftDetector` | `instrument.js:275` | Per-tool schema hash history (`src/schema-drift/detector.js`, v0.8.0) |

Under this deployment shape, every one of these is discarded and
rebuilt from empty on every request, regardless of `thrashDetection`,
`costTracking`, `schemaDrift`, or any other option — the reset is
architectural, not configurable away.

**This is not a new class of problem — ADR 010 already documented the
identical root cause, for one of these four, as an accepted limitation
rather than a bug.** Its Q4 finding, verbatim: "this only works when the
host keeps one long-lived instrumented `Server`/`McpServer` instance alive
across the sessions it serves... A host that instead constructs a fresh
`Server`/`McpServer` per HTTP session (stateless mode) gets no cross-session
drift detection at all, silently, by construction." **This ADR supersedes
that framing.** ADR 010 was right about the mechanism but wrong about the
scope: it was accepted for schema drift alone, as if schema drift's own
per-server state were the exception needing a documented caveat, without
the investigation at the time noticing that `thrashDetector` and
`budgetTracker` already shared the exact same construction pattern — and,
seven months later, that `toolOutcomeCounter` shipped in v0.8.0 with a
docblock literally describing itself as "process-lifetime," an assumption
this ADR shows is false under this topology. The accepted-limitation
framing undersold the problem by treating it as narrow when it was already
general.

## Findings

### 1. Why the `kInstrumented` idempotency guard doesn't help

`instrumentMcpServer()` sets `server[kInstrumented] = true` (a
`Symbol.for()`-keyed guard, `instrument.js`) specifically so calling it
twice on the *same* object is a no-op. This guard is irrelevant to the
this bug: this deployment shape hands `instrumentMcpServer()` a
genuinely different, freshly-constructed `Server` object on every request.
The guard checks "have I seen *this object* before" — every object in this
scenario is new, so it always answers "no," and full setup — including all
four `new`/`create*` calls above — runs again in full, every time.

### 2. Why `tracer`/`metricsRecorder` are NOT affected, and why that's exactly why the bug is observable at all

`setupTracer()`'s final line (`instrument.js:287`, unchanged since ADR 011's
investigation) is `trace.getTracer('opentel-mcp', PACKAGE_VERSION)`;
`setupMeter()` similarly resolves via `metrics.getMeter('opentel-mcp',
packageVersion)`. **OpenTelemetry defines both `Tracer` and `Meter` identity
by the `(name, version)` pair passed to `getTracer()`/`getMeter()`, not by
JS object identity** — confirmed already in this codebase's own reasoning
(`thrash/emitter.js`'s docblock: "a second `getMeter()` call here still
reports under the same meter to any backend"). This means the underlying
`mcp.tool.loop.detected` **counter instrument** is already, today,
effectively process-shared: calling `setupMeter()` fresh on every
`instrumentMcpServer()` call does not create a new, independent counter each
time: it resolves to the same one.

This is precisely why the bug is externally *observable* through that
metric rather than silently invisible: the counter is willing and able to
accumulate `.add(1)` calls across any number of `instrumentMcpServer()`
invocations. It just never receives any, because the **decision** to call
`.add(1)` is gated on `ThrashDetector.record()` crossing a threshold
in-process, and no individual instance's private, JS-object-scoped count
ever gets the chance to cross it before being discarded. The instrument
layer (shared, correct) and the decision layer (per-instance, broken) are
two different things, and only one of them inherited the right lifetime by
accident.

### 3. Reproduction, confirmed

`test/integration/thrash-stateless-http-lifecycle.test.js` (`describe.skip`
— a confirmed, unfixed gap, same discipline as
`test/thrash/observation-liveness.test.js`) drives 5 identical-fingerprint
tool failures across 5 separate `instrumentMcpServer()` calls, each on its
own fresh `Server`. With the default `threshold: 3`, a correctly
accumulating detector would have fired `mcp.tool.loop.detected` by the 3rd
call. Confirmed by actually running it unskipped before finalizing: the
assertion that a loop *was* detected by the 5th call fails outright
(`expected undefined to be defined` — the metric never fires across any of
the 5), and the literal "nothing fires at all" reading of the original
framing passes as a plain statement of current behavior. Both `it()` blocks
are kept, so the file is unambiguous about which reading of "assert no loop
is detected" it encodes.

## Decision

### Where tracker state should live: three options, argued in full

**Option A — a module-level singleton store.** A single `const` for each
tracker (or one shared container), constructed once at module load,
consulted by every `instrumentMcpServer()` call regardless of which
`server` object is passed.

*For:* Trivially fixes this case. No new option surface, no opt-in
required, works by default for everyone.

*Against:* This is process-global state with no way to distinguish *which*
logical service a given call belongs to, and it conflicts directly with how
every other piece of state in this package is scoped. Concretely:

- This repo's own test suite constructs many independent `Server` instances
  per file, expecting complete isolation between tests. A module singleton
  would leak thrash counts, budget totals, and tool-outcome counts across
  unrelated tests unless every test file remembered to reset it — a new,
  easy-to-forget source of flaky cross-test pollution, not a narrow
  edge case.
- A single process legitimately hosting more than one *distinct* MCP
  service (a supervisor process, a multi-tenant host) would have their
  state silently merged into one shared bucket. This is exactly the
  "unrelated clients merged into one shared state" failure mode
  `resolveThrashSessionId()` (`instrument.js`) already goes to considerable
  length to prevent at the *session* level — a module-level store
  reintroduces the identical class of bug one level up, for every one of
  the four trackers at once, silently and with no opt-out.
- It cannot be bounded or evicted meaningfully: nothing signals "this
  ephemeral server is done, its data can be reclaimed." A module singleton
  under this stateless-HTTP topology would, if naively keyed by
  server identity, grow without bound for the exact traffic pattern that
  motivates this ADR.

**Option B — injectable objects.** The host constructs a tracker instance
themselves, once, at their own application-startup scope, and passes the
same instance into every `instrumentMcpServer()` call for their repeated
ephemeral servers (e.g. `options.thrashDetection.detector: myDetector`).

*For:* Puts the choice in the hands of the only party who actually knows
their own deployment topology — the host, not this library, which cannot
see past one call at a time. Purely additive: nothing changes for a host
who doesn't pass one in. Philosophically consistent with
`assumeSingleSession: true`, this project's own existing precedent for "auto-
detection can't safely assume this, so let the operator opt in explicitly
instead of guessing" (`thrash/config.js`).

*Against:* `ThrashDetector`, `SchemaDriftDetector`, the budget tracker, and
`ToolOutcomeCounter` are today fully internal — none is exported from
`src/index.js`. Literal object injection means committing all four to the
public API surface, with the versioning, documentation, and stability
discipline that requires (this project's own `CONTRIBUTING.md` treats a
`.d.ts`-visible export as a standing commitment, not a convenience). That is
a materially larger, longer-lived commitment than this bug needs solved,
and it would need to be done four times — once per tracker, each with its
own constructor shape — rather than once. It also doesn't fully remove the
footgun: the host must still correctly share the *same* object across every
relevant call themselves, with no structural help from this library beyond
"here's the type."

**Option C — a host-supplied identity key, resolved through an internal
registry (`instanceKey`).** The host passes a stable string (e.g.
`options.instanceKey: 'my-service'`); `instrument.js` looks up or creates
each of the four trackers in an *internal*, bounded registry keyed by that
string, rather than constructing them unconditionally as local variables.

*For:* Gets the accumulation benefit of Option B without exporting any
internal class as public API — the registry and everything in it stay
fully internal, exactly like today. Opt-in and additive, same as Option B.
One consistent mechanism covers all four trackers at once, rather than four
separate injection points. The failure mode if misused (two genuinely
different services accidentally sharing one key) is the *same* class of
risk Option A has, but now it is a choice the host makes knowingly by
picking a key, not an automatic default silently applied to everyone —
matching this project's stated preference (see Alternatives rejected,
`assumeSingleSession`) for "wrong because the operator asserted something
false" over "wrong because the library assumed something false on their
behalf."

*Against:* Still requires the host to know about and correctly use the
option — it does not fix silent inertness by itself (see the `diag.warn`
discussion below, which is a separate, necessary complement, not something
this option makes unnecessary). A string key is a real footgun of its own:
an accidentally-unstable key (e.g. embedding a per-request id by mistake)
silently defeats the whole point while looking configured.

**Recommendation: Option C.** It is the only one of the three that doesn't
either (a) reproduce, at the architecture level, the exact "silently merge
unrelated things" failure this project has already spent real design effort
avoiding elsewhere (Option A), or (b) require a standing public-API
commitment four times over for a problem that doesn't need one (Option B).
It also composes: the registry construct is the same idea already proven at
smaller scope by `resolveThrashSessionId()`'s session-keyed state — this
ADR proposes applying it one level up, to the server-instance dimension,
not inventing a new mechanism.

### Registry bounds: must be a `BoundedTtlMap`, not an unbounded global

The `instanceKey` registry must reuse the bounded, TTL-evicting shape
`BoundedTtlMap` (`thrash/store.js`) already establishes — an unbounded
`Map` keyed by host-supplied strings is exactly the kind of unbounded
growth this package already treats as unacceptable for a long-lived stdio
process (see that module's own docblock). Concrete parameters, and the
reasoning behind each:

- **Cap:** the key space here is "distinct `instanceKey` values one
  process instruments," which in the corrected, intended usage should be
  small — a host supplies one stable identifier per logical service, reused
  across arbitrarily many ephemeral `Server` instances, not one key per
  request. Normal usage should never approach any reasonable cap. A default
  in the same range as existing precedent (`thrashDetection.maxTrackedKeys`
  default 1000, `schemaDrift.maxTrackedTools` default 1000) is defense-in-
  depth, not a response to an expected failure mode, matching exactly how
  both of those defaults are already justified.
- **TTL — must renew on every use, not just on creation.** `BoundedTtlMap`'s
  existing, documented semantics are "time-to-live from the moment an entry
  is `set()`" — `get()` refreshes LRU order but *not* expiry
  (`thrash/store.js`'s own docblock, confirmed by reading `set()`'s
  implementation: `expiresAt` is unconditionally recomputed as
  `clock() + ttlMs` on every `set()` call, never touched by `get()` alone).
  Reused as-is, a busy, long-lived logical service whose `instanceKey` entry
  was `set()` once at its first request would still expire after `ttlMs`
  regardless of continuous, heavy subsequent use — directly undermining the
  entire point of giving it a stable key. **The wiring, not
  `BoundedTtlMap` itself, must call `.set()` again on every cache *hit*, not
  only on a miss** (`let entry = registry.get(key); if (!entry) { entry =
  createTrackers(); } registry.set(key, entry);` — the `set()` call runs
  unconditionally, on both branches) — this reuses `BoundedTtlMap`
  unmodified while producing sliding-window, use-it-and-keep-it expiry at
  the call site. A default `ttlMs` well beyond thrash's own
  `entryTtlMs` (900,000 ms / 15 minutes, sized for "how long should one
  failure streak be remembered") is appropriate here, since evicting this
  registry's entry destroys an entire tracker's accumulated state, not one
  failure streak — a much bigger loss per eviction, needing a much longer
  "clearly abandoned" signal before it's reasonable to reclaim. A
  day-scale default (e.g. 24 hours) is a defensible starting point,
  explicitly a starting point pending real deployment feedback, not a
  value this design derives from first principles.
- **Eviction mid-session — this is the original bug, in miniature, and must
  be named as such rather than assumed away.** If an `instanceKey`'s entry
  is evicted (cap pressure, or the renew-on-use TTL genuinely elapsing
  because that key really did go quiet for the full window) and a later
  request arrives under the *same* key, the registry finds nothing and — by
  design — constructs fresh trackers, exactly the original bug's own
  behavior, just now gated behind a specific, much narrower timing
  condition (a real gap longer than the TTL, or cap pressure from an
  unexpectedly large number of distinct keys) instead of firing on every
  single request. This is a genuine reduction in blast radius, not a
  closure of the failure mode class — the same class of reset can still
  happen, it just requires an actual long idle period or key-space pressure
  to trigger, both plausible readings of "this service was probably
  restarted or decommissioned," which is a more defensible time to reset
  than "the next request arrived." Whether the registry should also
  distinguish "brand-new key" from "key seen before but since evicted" (and
  warn differently for each) was considered and is deliberately left open:
  it requires a third tier of state — a lightweight "have I ever seen this
  key" record independent of whether the tracker itself survived — which
  is real scope beyond what this pass decides. Noted as a considered
  enhancement for whoever implements this, not a requirement.

### Default behavior with `instanceKey` omitted: byte-identical to today

When `options.instanceKey` is not provided, `instrumentMcpServer()` must
take the *exact existing code path* — the current unconditional `new
ThrashDetector(...)` / `createBudgetTracker(...)` / `new
ToolOutcomeCounter()` / conditional `new SchemaDriftDetector(...)` calls,
untouched — not a registry lookup that happens to always miss. This is a
meaningful distinction, not pedantry: a "no key provided, so use a
per-call-random key" implementation would produce the same *result* as
today but would add a `BoundedTtlMap` lookup and insert to every single
call, for every user who never opts in — exactly the kind of unnecessary
per-call overhead this package already refuses elsewhere (see ADR 010's
"no allocation when disabled" standard for `schemaDrift.enabled: false`,
applied here to "no registry overhead when `instanceKey` is unset"). The
two code paths — key provided vs. not — must be a real branch, not a
uniform path that happens to degrade gracefully.

### The `diag.warn` question: transport shape is unavailable at instrument time, structurally, always

`isSingleConnectionTransport()` (`instrument.js`) cannot be used to detect
this pattern at instrument time. Its own docblock states plainly why: "the
SDK only populates [`server.transport`] after `server.connect(transport)`
runs, which happens *after* `instrumentMcpServer()` in normal startup
order." At the exact moment `instrumentMcpServer()` executes,
`server.transport` is **always** `undefined` — not sometimes, not only in
the buggy case, structurally always, for the correct long-lived usage and
this broken usage alike. There is nothing about the transport to
inspect at that point in the object's lifecycle, in any deployment shape.
This rules out transport-shape inspection entirely, not just for this
release but as a mechanism at all under the current SDK's connect-after-
instrument ordering.

**A call-frequency heuristic is the only lever available, and it comes in
two forms with very different confidence:**

1. **Keyed, once `instanceKey` exists (high confidence).** If a host
   supplies `instanceKey: 'my-service'`, the *same* key should essentially
   never need its registry entry recreated once it exists — a correctly-
   used stable key is found via `get()` on every subsequent call. Recreating
   the same non-default key's entry unexpectedly often, on a timescale far
   shorter than the registry's TTL, is a strong, low-noise signal that
   either the key isn't actually stable (e.g. a per-request id leaked into
   it by mistake) or TTL/cap pressure is evicting it prematurely. This is
   worth a `diag.warn` once the registry exists, because it is keyed on an
   identity the host explicitly claimed was stable — a real, specific
   contradiction, not a guess.
2. **Unkeyed, the actual common case this gap is about (best-effort
   only).** When no `instanceKey` is supplied — the default, and the exact
   configuration this bug occurs in — there is no identity to key
   a precise signal on at all. The only remaining lever is a bare,
   global, module-level call-frequency counter: warn if
   `instrumentMcpServer()` is called more than *N* times within *M*
   milliseconds, unconditional on any per-call identity. This is included
   here as a **secondary, best-effort mitigation, explicitly not a
   substitute for Option C** — its threshold is unprincipled until there is
   real deployment feedback to calibrate against (there is no principled
   way to derive *N*/*M* from first principles; it would need to start as a
   guess and be revised), and **this repository's own test suite would
   trip it**: individual test files in this codebase already construct and
   instrument dozens of `Server` objects in quick succession (this ADR's
   own reproduction test does it five times in a tight loop; several
   existing thrash/schema-drift integration test files do it far more)
   — a naive threshold tuned to be useful against a real stateless-HTTP
   traffic pattern is very plausibly *already* exceeded by this project's
   own CI runs. Shipping this heuristic without accepting that tradeoff
   explicitly, or without a way to opt out of it in test environments,
   would trade one honesty problem (silent inertness) for a different one
   (noisy, uncalibrated warnings training operators to ignore `diag.warn`
   output from this package generally). Recommended as a real, worthwhile
   addition — but one whose first shipped version should be treated as a
   best-effort starting point to react to, not a finished, well-tuned
   feature.

Both mechanisms should independently guard against the same failure mode
they're meant to catch: a broken or overly-aggressive warning heuristic
must never itself throw or affect the tool call path, same discipline as
every other `diag.debug`/`diag.warn` call site already in `instrument.js`.

## Constraints accepted

- This ADR does not decide the exact `N`/`M` for the unkeyed call-frequency
  heuristic, or the exact cap/TTL defaults for the `instanceKey` registry
  beyond the reasoning given above — those are implementation-time
  decisions this design constrains but doesn't finalize, pending real usage
  data.
- `instanceKey` fixes this for hosts who both know about the option and use
  it correctly. It does not, by itself, close the silent-inertness half of
  the bug for hosts who don't — that remains the `diag.warn` mechanism's
  job, and the keyed/unkeyed split above means the strong version of that
  warning only exists once a host has already partially engaged with the
  fix.
- Applying `instanceKey` uniformly across all four trackers (not just
  `thrashDetector`) is a deliberate scope decision, not an incidental
  extension — Finding 1 confirmed all four share the identical root cause,
  and shipping a fix for one while leaving the other three silently broken
  would repeat exactly the mistake ADR 010 made in accepting this as a
  schema-drift-only limitation.

## Alternatives rejected

- **Detecting the pattern via `server.transport`'s shape at instrument
  time.** Rejected — structurally impossible under the SDK's current
  connect-after-instrument ordering; the transport does not exist yet at
  the point this check would need to run, in every deployment shape, not
  only the buggy one.
- **A single module-level store (Option A) as the sole fix.** Rejected —
  see "Where tracker state should live" above; reintroduces the class of
  "unrelated things silently merged" bug this project already treats as
  unacceptable at the session level, now at the server-instance level, for
  every host, with no opt-out.
- **Literal object injection (Option B) as the sole fix.** Rejected — a
  materially larger public-API commitment (four internal classes made
  public) than the problem requires, for a benefit `instanceKey` achieves
  without it.
- **Silence (ship nothing, document nothing) until a full fix is
  designed and released.** Rejected — see "Release target" below; this is
  a live, currently-shipping gap affecting real deployments today, and this
  project's own established discipline (`docs/known-gaps.md`, README
  "Known limitations" sections written throughout this project's history)
  is to disclose a confirmed gap immediately, independent of when a fix
  ships, not to hold documentation hostage to implementation timing.

## Consequences

- **Release target: the fix (`instanceKey` + registry, and the keyed
  warning) is a new, additive, opt-in capability and should ship as a
  minor release** (e.g. v0.9.0), consistent with this project's own
  versioning pattern for every other new capability to date (v0.6.0
  thrash, v0.7.0 channel-aware detection, v0.8.0 schema drift/two-axis/
  cost-aware sampling) — nothing about it changes behavior for an
  existing, non-opting-in host, so there is no forced-upgrade urgency
  driving a patch release, but there is also no reason to bundle it with
  unrelated feature work.
- **The README/known-gaps caveat should ship independently, and sooner,
  not wait for the fix.** This is a real, currently-affecting gap in
  whatever the next release is (patch or otherwise) — this project's own
  precedent (ADR 010's schema-drift limitation was documented in the same
  release it shipped in; `docs/known-gaps.md` exists specifically to
  disclose confirmed-but-unfixed gaps immediately) argues for adding a
  plain "Known limitations" entry — covering all four trackers, not just
  thrash, and explicitly retracting/superseding ADR 010's narrower framing
  — as its own, fast, documentation-only change, whether or not v0.8.0 has
  already published. That documentation update is a necessary follow-up
  this ADR does not itself perform (design only) — tracked here so it
  isn't lost, not executed in this pass.
- `docs/known-gaps.md` and the README's "Tool schema drift detection" →
  "Known limitations" section (which currently describes this exact root
  cause as schema-drift-specific) both need a cross-reference to this ADR
  once it's accepted, correcting the "known limitation" framing to "known
  gap with a proposed fix, tracked here" for all four trackers rather than
  one.
- `test/integration/thrash-stateless-http-lifecycle.test.js` remains
  `describe.skip` until `instanceKey` (or whatever direction is
  ultimately implemented) actually lands — at that point it needs a
  rewrite, not just an unskip, to exercise the fix directly (constructing
  the five ephemeral servers with a shared `instanceKey` and asserting the
  loop *is* now detected) rather than only documenting the absence of one.

## Update (2026-08-09): External review — two additional limitations

Both raised in external review (no names available), after the design
above was already settled. Neither changes the Recommendation: Option C
(`instanceKey`) — both scope it more precisely than the original text
did. Design only, same as the rest of this ADR: nothing here is built.

### Limitation 1: `instanceKey` does not solve multi-instance/serverless distribution

**The gap.** `instanceKey` scopes tracker state to a *process*. On
Lambda, Cloud Run, or any horizontally-scaled container fleet, concurrent
requests are routed across concurrently-running instances, and instances
themselves are recycled. A retry loop of N requests — the exact scenario
Agent Thrash Detection exists to catch — can land on N different
instances instead of N calls to one process. Each lands on a tracker
that has never seen this fingerprint before. Same silent inertness this
whole ADR is about, reached by a different door.

**Why `instanceKey` doesn't solve it.** The registry Option C proposes is
a `BoundedTtlMap` living in one process's memory — a module-level
structure inside whichever copy of `instrument.js` is currently loaded.
Two concurrent Lambda execution environments (or two Cloud Run
containers, or two pods) each load their own copy of that module and
therefore construct their own, entirely independent registry, in
separate memory, on separate machines. Passing the *identical*
`instanceKey` string on every call — the fully correct, intended usage —
does not change this: each process's registry still only ever sees the
calls routed to it. A `get()` on a key that process has never seen is a
miss there regardless of how many other processes hold an entry for that
same key. `instanceKey` was designed to fix "this process keeps
discarding and rebuilding trackers across calls that should share one";
it was never designed to fix "these N processes each hold their own
copy of one tracker" — and nothing about a string-keyed, single-process
map could fix the second problem without becoming a different kind of
thing entirely (see external state, below).

This is the same distinction Finding 2 already draws for a different
purpose, worth restating precisely because it is also the hinge the
reframe below turns on: the exported **instrument** (the `mcp.tool.loop.detected`
counter itself) is process-independent by OTel's own identity rules —
Finding 2 already established this. The **registry** `instanceKey` adds
is not; it is deliberately, necessarily process-local, because it exists
to answer an in-process question ("have I already built trackers for
this key, in this process, before discarding them?") that has no
meaning across a process boundary.

**External state (Redis, DynamoDB, or equivalent) as an option.** The
standard fix for distributed counting is a shared external store: an
atomic increment per event, keyed by `instanceKey` (or, for thrash
specifically, by fingerprint), with the threshold check reading the
shared value instead of a local one.

*For:* This is the only design on the table that actually closes the
gap as stated — real accumulation across real process boundaries, the
same pattern every distributed rate limiter and every distributed
counter uses, because it is the correct tool for this exact problem.

*Against, and the recommendation:* Reject as a built-in. Every tracker
this ADR discusses is today a synchronous, zero-I/O, zero-latency,
fail-open in-memory structure — `cost/budget.js`'s own docblock states
the standard this codebase already holds every tracker to: "this module
never blocks a tool call and never throws." An external store breaks
that on both counts: the hot tool-call path gains a network round trip
(or an async fire-and-forget with its own staleness and failure modes
nothing here has ever needed to reason about), and correctness now
depends on a service this library doesn't control staying up. It is also
a first-of-its-kind dependency for this package — `package.json` today
lists exactly `@opentelemetry/api`/`@modelcontextprotocol/sdk` as peers
and `@opentelemetry/{exporter-trace-otlp-http,resources,sdk-trace-node}`
as runtime dependencies; nothing that talks to a database or a cache
exists anywhere in this codebase. Requiring a host to provision and operate a shared Redis
instance or a DynamoDB table just to get correct thresholding on one
optional feature is a materially larger ask than anything else this
library requires, and it multiplies Option B's already-rejected
injection-surface problem: now the shape that needs injecting is a
storage *client*, different per store technology, not a plain class.
Nothing about this problem justifies that cost today. At most, this
should be documented as a "bring your own" pattern for hosts who need
real distributed accumulation and are willing to take the dependency on
themselves — the same posture this ADR already takes toward Option B
(put the choice with the host, don't build it in) — not something this
library ships or maintains.

**Recommended position: counters are instance-local, best-effort, by
design — not a temporary caveat pending a future fix.** `instanceKey`
and its registry are an *optimization* that widens what "instance-local"
means in practice, from "one `instrumentMcpServer()` call" to "one
process, across as many ephemeral `Server` objects as share a key." They
are not, and under this recommendation will not become, a
distributed-counting mechanism. This needs to be a stated invariant of
the design, not an implied one a host discovers by reading the source —
which means it belongs in the README's existing "In-memory tracker state
is scoped to one `instrumentMcpServer()` call" section
(`packages/core/README.md:1439`), not only in this ADR. That section
already documents the single-process stateless-HTTP gap and cites this
ADR by name; once `instanceKey` ships, that section needs an explicit
follow-on sentence stating the multi-instance/serverless case by name,
so a reader configuring `instanceKey` for a Lambda deployment does not
reasonably conclude it fixes the thing they're actually running into.
Per this ADR's own established discipline (see "Consequences" above —
documentation is tracked here, not written in this design-only pass),
this is noted as a required follow-up, not executed now.

### Reframe considered: should threshold evaluation live downstream (Collector/backend) instead of in-process, for distributed deployments?

The premise is correct, and worth crediting precisely because getting it
right changes the answer: **OTel instrument identity is `(name,
version)`, not process or object identity — already established above
(Finding 2) — so every exported `mcp.tool.*` counter and histogram
already aggregates correctly across any number of concurrently-running
processes, today, with no change this ADR proposes.** A `sum by
(gen_ai_tool_name) (rate(mcp_tool_errors_total[5m]))` run against a
horizontally-scaled fleet exporting to one Prometheus is already
fleet-wide correct, unconditional on `instanceKey`. This is simply true
of how OTel's data model and any standard metrics backend work — not
something this library builds, and not something Limitation 1 changes.

What Limitation 1 actually identifies is narrower than "metrics don't
aggregate": it's that a *derived, thresholded* signal — "has this
fingerprint failed 3 times consecutively, therefore emit
`mcp.tool.loop.detected`" — requires a **decision**, made in-process,
against only that process's local slice, *before* anything is exported.
The raw signal each individual failure represents is already
fleet-correct once it lands in a metric or a span; the decision about
what those failures mean, evaluated too early and too locally, is the
actual bug. So: is that decision better made downstream instead? **Per
tracker, not as one answer** — the four don't behave the same way here,
and treating them as one would repeat the mistake ADR 010 already made
once (see Context, above) of generalizing from a single case.

1. **`thrashDetector` — the reframe does not fully apply, and the reason
   is a decision this project already made deliberately.** Distributed
   thrash detection needs to group failures by `mcp.failure.fingerprint`.
   That attribute is deliberately excluded from every metric label
   (`METRIC_SAFE_ATTRIBUTES`, `src/fingerprint/attributes.js` — unbounded
   cardinality, span-only by design). A downstream *metrics* query
   literally has no fingerprint dimension to group by. The fingerprint
   **is** available, unconditionally, on every failed tool-call span and
   on the `mcp.loop.detected` span event — so correct distributed thrash
   detection is a **trace-correlation problem** (query spans across the
   fleet, grouped by fingerprint, over a window), not a metrics-threshold
   problem, and evaluating it downstream would need a trace-analytics
   backend capable of that query (Tempo + TraceQL grouping, a Collector
   processor, a span-ingesting warehouse) — infrastructure most hosts
   asking "why doesn't thrash detection fire on Lambda" do not already
   have, and infrastructure this library has no way to provide or
   require. Directionally the correct long-term architecture for this
   signal specifically; not a drop-in substitute for `instanceKey` for
   hosts without it.
2. **`budgetTracker`, per-tool scope — the reframe applies cleanly, and
   is arguably already better than `instanceKey` even for one process.**
   `mcp.tool.cost.total` is already exported today with exactly
   `gen_ai.tool.name` + `mcp.tool.model` — both metric-safe, bounded
   labels (verified directly against a running exporter while building
   `dashboards/grafana-mcp-health.json`:
   `mcp_tool_cost_total{gen_ai_tool_name="summarize_ticket",mcp_tool_model="claude-sonnet-5",...}`).
   A downstream rule — `sum by (gen_ai_tool_name) (mcp_tool_cost_total) >
   $X` — is fully expressible against data this library already emits,
   correctly, fleet-wide, with zero code changes. This is exactly the
   shape of this project's own existing "Cost-aware trace sampling (a
   Collector recipe, not a library feature)" precedent (ADR 011,
   `packages/core/README.md`) — the same posture applied to a second
   signal. For per-tool budget, this isn't just viable, it's already
   possible today, and it sidesteps `instanceKey`'s own eviction/TTL
   reasoning entirely.
3. **`budgetTracker`, per-session scope — the reframe does not apply, for
   a stronger reason than fingerprint's.** No `mcp.session.id` (or
   equivalent) attribute exists anywhere in this codebase's span or
   metric attribute set — confirmed by inspection, not inferred; session
   id is used only as an internal `Map` key inside `instrument.js` and is
   never emitted at all. There is no dimension downstream could threshold
   against, because the data isn't externally observable in the first
   place — a strictly worse starting point than fingerprint's (which is
   at least on spans). Out of scope for this ADR to fix; flagged for
   whoever eventually considers exposing a (necessarily span-only, for
   the same cardinality reasons as fingerprint) session attribute.
4. **`schemaDriftDetector` — the reframe does not apply; this isn't a
   thresholding problem at all.** Drift detection is a diff between the
   previously-observed schema hash and the current one
   (`src/schema-drift/diff.js`) — it requires remembering one specific
   prior value per tool, not aggregating a count past a limit. No
   metrics query "thresholds" its way to a diff. Evaluating this
   downstream would require its own external state to remember
   last-seen-hash-per-tool — which is exactly the external-state design
   rejected above, not something a Collector rule expresses for free the
   way `sum(...) > X` does.
5. **`toolOutcomeCounter` — the premise doesn't reach this tracker at
   all.** It is not exported as an OTel metric, full stop —
   `src/observation/tool-outcome-counter.js`'s own docblock: "No OTel
   emission here either; this is the pure bookkeeping layer only." It is
   a synchronous in-process accessor (`getObservationState()`), not a
   signal that reaches any backend to threshold against. "OTel identity
   already aggregates it" has nothing to aggregate here. Only an
   in-process fix (`instanceKey` or equivalent) can ever help this
   tracker.

**Plain answer, since the question deserves one: yes, downstream/Collector-side
threshold evaluation is a better answer than `instanceKey` for
distributed deployments — for the subset of signals already exported
with metric-safe labels, per-tool cost being the clean case today. It is
not a general replacement for `instanceKey`, and it does not touch
Agent Thrash Detection's actual promise.** Fingerprint-level correlation
is a trace problem by this project's own deliberate cardinality decision,
not a metrics problem; per-session budget and `toolOutcomeCounter` have
no exported signal to evaluate downstream at all today; schema drift's
diff semantics don't reduce to thresholding regardless of where it runs.
Recommendation: document the downstream/Collector-rule pattern as the
recommended default advice for "I need multi-instance-correct cost or
error-rate visibility" — most naturally as an extension of the existing
"Cost-aware trace sampling (a Collector recipe, not a library feature)"
material rather than a new section — while keeping `instanceKey` as the
answer for accumulation semantics finer than what's on metric labels
today: per-session budget, fingerprint-level thrash, schema-hash
diffing, all within one process. These are complementary fixes for
different slices of the same symptom, not competing answers to the same
question, and both should be presented that way when documented. Not
written in this pass — design only, tracked below.

### Limitation 2: the startup guard isn't reachable — a reachable version fires on first evidence, not at startup

**The suggestion, and the correct diagnosis behind it.** A reviewer
proposed asserting at startup that each relevant hook actually fires
under the transport currently in use, noting correctly that
"registration succeeding is what misled you" — `instrumentMcpServer()`
returning without error looks identical whether instrumentation is
about to work correctly or is about to silently do nothing, which is
exactly the shape of failure this whole ADR is about. The instinct is
right. The mechanism as stated isn't reachable: this ADR already
established, in "The `diag.warn` question" above, that `server.transport`
is `undefined` at the exact moment `instrumentMcpServer()` runs,
**structurally, always** — not sometimes, not only in the broken case —
because the SDK only populates it after `connect()`, which runs after
instrumentation in normal startup order. There is nothing to inspect at
startup, in any deployment shape, so a startup-time assertion has no
evidence available to assert against. That finding stands as already
written; this doesn't re-derive it, only builds past it.

**The reachable version: assert on first fire, not at startup.** Track,
per tracker instance (scoped to the single `instrumentMcpServer()`
call/instance that constructed it — this needs no `instanceKey` and no
cross-call correlation; it is orthogonal machinery to everything else in
this ADR), how many tool calls that instance has processed. After the
Nth call, if the tracker's own observable state is still sitting at its
structurally-initial value, emit a single `diag.warn` — guarded by a
"has already warned" boolean so it fires at most once per instance, the
same one-shot-diagnostic shape this codebase already uses elsewhere
(`config.js`'s `warnedServiceNameIgnored`, `instrument.js:111-117`).
This is a third, independent lever alongside the keyed/unkeyed
`instanceKey`-registry-recreation warnings already decided above (now
three, not two) — independent because it fires from *inside* one
instance's own lifetime, using only evidence that instance itself
accumulated, and says something even to a host who has never touched
`instanceKey` at all, including one running a single, correctly
long-lived server that merely happens to be sitting quiet.

**This mechanism is not equally trustworthy across the four trackers,
and the false-positive risk needs naming per tracker, not once in
general** — the same discipline this ADR already applies to
`instanceKey`'s uniform-across-four scope decision (see "Constraints
accepted," above):

- **`toolOutcomeCounter` — strongest signal, low false-positive risk.**
  It increments unconditionally on every tool call, success or failure,
  with no precondition. If N calls genuinely passed through an instance
  and `{success, failure, unknown}` are all still zero, that is close to
  unambiguous evidence of exactly this ADR's bug (or some other
  structural break) — there is no legitimate "healthy but quiescent"
  state for this tracker. Best-suited target for this mechanism, by a
  wide margin.
- **`budgetTracker` — conditional signal, real false-positive risk named
  plainly.** It only moves when a tool result carries token-usage data
  `src/cost/extractor.js` recognizes (Anthropic/OpenAI/Bedrock-shaped
  `usage` fields). Confirmed hands-on while building
  `dashboards/dev/metrics-demo-server.js` for the Grafana dashboard: the
  stock demo tools reported nothing until usage data was added to them
  explicitly — real MCP tools very often never echo this at all. A
  perfectly healthy server whose tools simply don't report usage will
  trip this warning exactly like the actual bug would, and the tracker
  itself cannot tell the two apart.
- **`thrashDetector` — weak, noisy signal, same fundamental ambiguity as
  the unkeyed call-frequency heuristic's already-documented risk
  (above).** A healthy server with zero repeated-fingerprint failures in
  its first N calls is the *correct*, desired steady state — not
  evidence anything is broken. This heuristic cannot distinguish
  "nothing to detect" from "detection is broken," full stop; that
  ambiguity is the false-positive risk, named explicitly rather than
  smoothed over.
- **`schemaDriftDetector` — same ambiguity, plus a targeting mismatch.**
  Its accumulation is driven by `tools/list` calls, not `tools/call`; a
  literal "N tool calls" gate as described above doesn't even count the
  right event for this tracker — a corrected version would need to gate
  on N `tools/list` calls specifically. Even corrected, a schema that
  legitimately never changes (the common case) produces
  indistinguishable-from-broken quiescence, the same risk as thrash.

**Position: a secondary mitigation, explicitly weaker than a startup
guard, included because it checks where evidence exists rather than
where none does yet — not a substitute for the keyed/unkeyed mechanisms
already decided, and strongest for exactly one of the four trackers.**
Same discipline as the existing unkeyed heuristic's `N`/`M`: the value of
`N` here is not derived from first principles in this pass and is left
as an implementation-time decision pending real deployment feedback,
consistent with "Constraints accepted" above.

### Consequences of this update

- Neither limitation changes the Recommendation: Option C
  (`instanceKey`) above. Both scope what it claims to fix — Limitation 1
  bounds it to "one process," Limitation 2 adds a narrower, orthogonal
  detection lever alongside the already-decided keyed/unkeyed warnings,
  now three tiers instead of two.
- **README follow-up (tracked, not written in this pass):** once
  `instanceKey` ships and gets documented, the README's "In-memory
  tracker state is scoped to one `instrumentMcpServer()` call" section
  (`packages/core/README.md:1439`) must state the multi-instance/
  serverless non-solution explicitly, by name, alongside it — not leave
  a reader to assume a configured `instanceKey` is sufficient on a
  horizontally-scaled deployment.
- **A second, independent README follow-up:** the downstream/
  Collector-rule pattern for per-tool cost (and, more generally,
  metric-safe-labeled signals) in distributed deployments should be
  documented as its own recommended pattern, most naturally extending
  "Cost-aware trace sampling (a Collector recipe, not a library
  feature)" rather than duplicating that section's framing elsewhere.
- The "assert on first fire" mechanism should ship documented alongside
  `instanceKey` and the keyed/unkeyed warnings when that work lands as a
  single three-tier `diag.warn` story, not introduced separately later —
  splitting them across releases would ask hosts to learn this
  package's warning behavior twice.

## Update (2026-08-09): Phase 2 implementation decisions the Decision text left open

Phase 2 (`options.instanceKey`, the config/wiring pass — `src/config.js`,
`src/instrument.js`) had to resolve two structural questions the Decision
section above never answers for Option C. Both were confirmed as genuine
gaps before implementing, not assumed — recorded here as the implementation
decisions actually shipped, since code comments alone (`instrument.js`'s
`instanceRegistry` singleton and `getOrCreateTracker()` docblocks) aren't
where a reader auditing this ADR would look for them.

**Registry lifetime: a module-level singleton, constructed once in
`instrument.js` at module load.** The word "module-level" appears in this
ADR exactly twice before this Update — both describing Option A, which was
*rejected*. Option C's own text ("an internal, bounded registry keyed by
that string") never states where that registry itself lives. There isn't a
genuine alternative, though: the entire mechanism — repeated
`instrumentMcpServer()` calls sharing state via a key — only works if the
registry persists somewhere reachable across those calls; a per-call local
variable couldn't be looked up again by a later, unrelated call. A
module-level singleton is the only architecture consistent with what
Option C describes. Implemented as exactly that, one `InstanceRegistry`
instance for the process's lifetime.

**Key namespacing: one shared registry, keys namespaced per tracker type
(`${instanceKey}:thrash`, `${instanceKey}:budget`, `${instanceKey}:tool-outcome`,
`${instanceKey}:schema-drift`).** Also unaddressed above: "`instrument.js`
looks up or creates each of the four trackers in an internal, bounded
registry keyed by that string" is consistent with either one shared cache
entry per `instanceKey` (bundling all four trackers into one cached value)
or four independent entries per key, and the text doesn't say which. Using
the raw `instanceKey` string directly for all four trackers against a
single-value-per-key cache (the shape Phase 1's `InstanceRegistry` already
has — one `factory()`, one cached value, per key) would silently
type-confuse: a second `getOrCreate(instanceKey, budgetFactory)` call would
just return the first tracker already cached under that exact key (e.g. a
`ThrashDetector`) instead of ever running `budgetFactory`. Namespacing the
key per tracker type avoids this collision structurally — the four tracker
types can never be handed back in place of one another, because they are
never stored under the same registry entry.

*Tradeoff, named rather than glossed over:* four separate `InstanceRegistry`
instances (one per tracker type) would have achieved the identical
non-collision guarantee without relying on string-namespace hygiene at
all, and would additionally have given each tracker type its own
independent cap/TTL bound instead of all four, across every `instanceKey`
a process uses, sharing one bounded registry's cap and TTL. One shared
registry with namespaced keys was chosen for this phase as the simpler
implementation — fewer moving pieces, one place to reason about bounds —
not because the four-registries alternative was found wanting on
correctness. If independent per-tracker-type bounds turn out to matter in
practice (e.g. one tracker type's growth pattern under real deployment
traffic pressuring out another type's entries prematurely), splitting into
four registries remains a reasonable, low-risk follow-up: it changes
`instrument.js`'s internal wiring only, not `options.instanceKey`'s public
contract, so it would not be a breaking change for any host already using
the option.

## Update (2026-08-11): Cross-call detection without session identity — investigation, documentation-only outcome

**Filed here, not as a new ADR.** This is a direct continuation of the
first Update's "Reframe considered" section above — same question (should
threshold evaluation live downstream instead of in-process?), now asked
specifically for the case that section's per-tracker table already
flagged as hardest: thrash detection with no session identity available
at all, not merely across process boundaries. A new ADR would have had to
restate that table's reasoning to stand on its own; appending keeps the
two askings of the same question next to each other, where a reader
auditing either can see both. Investigation only — nothing in this update
changes code. The one artifact this update produces is documentation,
already shipped: `packages/core/README.md`'s new "Fleet-wide fingerprint
frequency (a Tempo recipe, not a library feature)" section, plus updated
caveats in the Agent Thrash Detection and Cost & Token Attribution
"Known limitations"/"Extending it" sections pointing at it.

### This is not ADR 011's shape, despite looking like it

ADR 011 already established the precedent this ADR's first Update reused
for per-tool cost: "Collector recipe, not a library feature." It's worth
being precise about why that precedent does *not* transfer to thrash
correlation, rather than assuming the posture is interchangeable because
both say "push it downstream."

ADR 011's Collector recipe (`tailsamplingprocessor`) makes a keep/drop
decision **per trace**, once, using only data already inside that one
trace's buffered span set. Thrash correlation under no-session-identity
needs the opposite shape: aggregate **across many separate traces** —
each stateless call is plausibly its own trace, with no shared parent —
over a time window, grouped by a value that recurs across them. A
Collector sampling processor has no operation that expresses "have I seen
this fingerprint N times across other, unrelated traces in the last 5
minutes" — that's not what a per-trace tail-sampling policy is for. The
correct-shaped mechanism turns out to be a backend aggregation/alerting
query (Tempo TraceQL metrics, or an equivalent), not a Collector
processor config — same *posture* as ADR 011 ("don't build it in-process,
document it as external"), different *artifact family* entirely. Treating
the two as the same shape would have led to documenting the wrong kind of
recipe.

### Backend capability, checked directly, extending ADR 013 rather than redoing it

ADR 013 already investigated SigNoz/Tempo/Jaeger for attribute and event
*filtering* — is a given attribute or event queryable at all. This
question is narrower but different: does the backend support
*aggregating* (counting occurrences, grouped by an attribute's value)
across traces, which ADR 013 didn't need and didn't check.

- **Tempo**: confirmed directly against Grafana's own docs. TraceQL
  metrics queries support `by(<attribute>)` grouping over arbitrary span
  attributes at query time, including high-cardinality ones — grouping
  happens over the trace/span store itself, not a pre-aggregated metrics
  time series, so it does not run into the cardinality constraint that
  keeps `mcp.failure.fingerprint` off `METRIC_SAFE_ATTRIBUTES`
  (`fingerprint/attributes.js`) in the first place. Real, pasteable query:
  `{ span.mcp.failure.fingerprint != "" && status = error } |
  count_over_time() by (span.mcp.failure.fingerprint)`.
- **SigNoz**: per ADR 013, raw ClickHouse querying (which is what an
  equivalent grouped count would need) is documented as Dashboard-only,
  not available from the ad-hoc query API. Achievable, but as a Dashboard
  SQL panel, not a live ad-hoc query — a materially heavier ask than
  Tempo's.
- **Jaeger**: per ADR 013, the documented `api_v3.QueryService`
  (`FindTraces`) has no aggregation or grouping parameter in the proto at
  all. Not achievable against the documented API, full stop.

This is the same ranking ADR 013 already reached for different reasons
(event queryability) — Tempo first, SigNoz second with a real cost,
Jaeger not viable — now confirmed to hold for aggregation capability too,
not just filtering.

### Fingerprint-only grouping answers a different question than thrash detection

`mcp.failure.fingerprint` is already unconditionally on every failed-call
span (`instrument.js`, whenever fingerprinting is enabled) independent of
session id or any in-process accumulation — so the Tempo query above works
today, with zero new emission. But `resolveThrashSessionId()`
(`instrument.js`) exists specifically to stop unrelated callers merging
into one shared count, the same failure mode Option A of this ADR's
original Decision was rejected for, one level down. A query grouped by
fingerprint alone has no way to make that distinction: one agent retrying
the same broken call 3 times, and three unrelated callers each hitting the
same bug once, are indistinguishable — both produce a count of 3 for that
fingerprint. That is a legitimate, useful signal (fleet-wide bug-frequency
monitoring) but it is not agent-thrash detection, and the README's new
section states this in bold rather than letting it be inferred — presenting
one as the other would be dishonest in exactly the way this project's own
documentation discipline (`docs/known-gaps.md`'s existence) exists to
prevent.

### The only path to real per-agent correlation, and why it's a separate future decision

Confirmed directly against the MCP spec: 2026-07-28's changelog states
plainly that "servers that need cross-call state use explicit,
server-minted handles passed as ordinary tool arguments" (SEP-2567) —
the application-level replacement for protocol-level sessions. Mechanically,
this library could read such a handle: `wrapToolCallHandler`
(`instrument.js`) already reads `request?.params?.arguments` (today only
to compute `mcp.tool.argument_count`). Reading a named argument's value
and setting it as a span attribute — the identity dimension the query
above is missing — is a small change in isolation, and it is the *only*
mechanism identified in this investigation that would make downstream
per-agent correlation actually correct, by giving a query something to
group by beyond fingerprint alone (`by (span.mcp.failure.fingerprint,
span.<new-attribute>)`).

**Deliberately not proposed as an addition here.** Every span attribute
this library emits today is library-computed metadata — a hash, a
category, a count, a boolean the library itself decided. A handle read out
of `request.params.arguments` would be the first attribute carrying a
value the *application* chose to put in a tool argument, which could be
anything: an opaque token, as the spec's own pattern intends, or — nothing
stops a host from putting something else there — a customer id, an email
address, a raw credential. That is a different category of risk than
anything `ATTRIBUTE_KEYS` (`fingerprint/attributes.js`) or
`thrash/attributes.js` currently names, and it deserves its own scoped
decision: what to name it, whether it's opt-in-only (almost certainly:
this cannot default to reading an arbitrary argument), how loudly to warn
about putting sensitive data in whatever argument a host designates, and
whether span-only placement (matching `fingerprint`'s own cardinality
reasoning) is sufficient protection or whether more is needed given the
value is unbounded *and* application-chosen rather than library-derived.
None of that is decided here — this update's scope is confirming it's the
only path, and naming why it doesn't get folded in casually.

### Other identity sources checked, and rejected or deferred

Three more candidates, checked directly against the installed
`@modelcontextprotocol/server`/`sdk` packages so the record shows they
were investigated, not overlooked.

- **`ctx.http?.authInfo` (v2) / `extra.authInfo` (v1).** Available in both
  SDKs, but never auto-populated — both are documented as strictly
  pass-through, populated only when the host's own bearer-token
  verification middleware supplies it, so this requires an
  already-authenticating deployment, not a zero-precondition read.
  `clientId` identifies the OAuth *client application*, not the end user —
  under a static client id (common, and this library can't detect which
  case a deployment is in) the merge blast radius is an entire product's
  userbase, invisible to this library. The token itself is narrower but
  still commonly spans multiple, unrelated agent runs within its lifetime,
  and is a secret — using it would require hashing before it ever touches
  a span, a new failure mode (hash it wrong, leak a credential fragment)
  none of the other candidates carry. **Rejected as a default.**
- **A gateway-set request header (`ctx.http?.req` / v1's
  `extra.requestInfo.headers`).** The least-bad candidate found, and the
  only one worth a future ADR. Viable only as one fixed, library-declared
  header name — a host-configurable "tell us which header" reinstates the
  exact "could be anything" problem that made the tool-argument idea
  ADR-sized in the first place. Its real cost is organizational rather
  than technical: the team owning the gateway is often not the team
  shipping the MCP server, so wiring it isn't free even where it's
  possible. Recorded alongside the argument-handle idea above as a future
  ADR candidate, not designed further here.
- **Trace id.** Dead end. The v2 SDK defines `traceparent`/`tracestate`/
  `baggage` `_meta` keys (SEP-414) as a documented convention, but nothing
  in the compiled client or server implementation reads or writes them —
  and this library extracts nothing from incoming context today either.
  Two independent gaps, neither closable by fixing only one side.

### Consequences of this update

- No code changes. The recommendation stands as already documented: do
  not build in-process cross-call detection for the no-session-identity
  case — `instanceKey` already covers what an in-process fix can cover,
  and this update finds nothing that changes that ceiling.
- The Tempo recipe and its caveat are live in
  `packages/core/README.md` ("Fleet-wide fingerprint frequency"), cross-
  linked from the Agent Thrash Detection and Cost & Token Attribution
  sections' existing "Known limitations"/"Extending it" text.
  `perSessionUsd` budget tracking gets the same "unsupported under
  stateless MCP, no substitute exists" statement — it has no
  fingerprint-equivalent attribute for even the degraded downstream query
  to key on, so it doesn't get the recipe pointer, only the caveat.
- The host-designated-argument-as-span-attribute idea is recorded here as
  a candidate for a future ADR, not scheduled. It would need its own
  design pass before any code is written, specifically on the sensitivity
  and opt-in questions above — a different kind of decision than anything
  else this ADR settles.
- The fixed-name gateway-header idea joins it as a second future-ADR
  candidate (see "Other identity sources checked" above); `authInfo` and
  trace id do not — both are rejected outright, not deferred.

## Update (2026-08-16): the trace id rejection above no longer holds — see ADR 018

**"Trace id. Dead end." (the "Other identity sources checked" list
above) is superseded, not retracted by editing it in place** — left as
written for the record of what was true when it was checked, per this
document's own established practice of appending corrections rather than
rewriting history (see the "Update" sections already throughout this
file). ADR 017 (`docs/adr/017-trace-context-propagation.md`, Phase 2)
closed the server-side half of the "two independent gaps, neither
closable by fixing only one side" finding above. A follow-up
investigation, checking whether the client-side half was still
hypothetical rather than assuming either way, found real (if narrower
than a first glance suggests) evidence that it is not: real, shipping
third-party instrumentation wrapping the official v1 MCP client SDK
already propagates `traceparent` into `_meta` today. Full findings, the
resulting design (a new, narrowly-scoped fallback tier for Agent Thrash
Detection's session-identity resolution — not a replacement for real
session ids, and explicitly not a claim that v2's structural
no-session-id gap is closed), and the adoption caveat that keeps this
scoped honestly: ADR 018
(`docs/adr/018-trace-id-as-thrash-fallback.md`).
