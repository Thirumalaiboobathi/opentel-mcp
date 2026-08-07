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
