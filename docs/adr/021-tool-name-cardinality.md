# ADR 021: `gen_ai.tool.name` metric-label cardinality

**Status:** Proposed — design only, no implementation.

**Found by:** `docs/known-gaps.md` entry 11 (internal self-review — an
audit of whether `METRIC_SAFE_ATTRIBUTES` bounds metric label *values*,
not just which attribute *keys* are allowed onto a label). This ADR is
the scoped design decision that entry's own "Possible directions" section
says is needed before any code changes — read that entry in full before
this document; it is not re-derived here, only argued from.

## Context

`gen_ai.tool.name`'s value is `request.params.name` — incoming
`tools/call` request content, read at `src/instrument.js`'s
`wrapToolCallHandler()` before the underlying handler has had any chance
to reject an unrecognized name. `metricsRecorder.recordCall(toolName)`
fires unconditionally, before `await handler(request, extra)`: **the call
fails; the label is recorded first.** Twelve metric instruments across
three files (`src/metrics.js`, `src/thrash/emitter.js`,
`src/schema-drift/emitter.js`) carry this value as a label, all traced
directly to `toolName`/`event.toolName` — see entry 11's own inventory,
not repeated here.

**Two existing ADRs assert `gen_ai.tool.name` is already a bounded,
metric-safe value. Both are superseded by entry 11, and this ADR treats
that correction as settled, not something to re-argue:**

- `docs/adr/012-tracker-lifecycle-and-shared-state.md`: *"`mcp.tool.cost.total`
  is already exported today with exactly `gen_ai.tool.name` +
  `mcp.tool.model` — both metric-safe, bounded labels (verified directly
  against a running exporter...)."*
- `docs/adr/010-schema-drift.md`: *"attributes `gen_ai.tool.name` (the
  existing attribute already used as a metric label on every other
  `mcp.tool.*` counter... so this isn't a new cardinality precedent, it's
  reusing one already accepted)."*

Both passages verified that the *label mechanism* exports correctly —
neither verified that the underlying *value space* is bounded. It isn't:
`gen_ai.tool.name` is arbitrary caller-supplied request content, with no
length cap, no character-set restriction, and (per Decision 1 below) no
uniformly-available way to check it against what the server actually has
registered. Per this project's own established convention (known-gaps
entries 6, 7, 8), the correction lives here and in entry 11, not by
editing either ADR's original text.

**The actual failure mode is bounded, not a leak or a crash.** The
installed `@opentelemetry/sdk-metrics` implements the OTel spec's default
2000-distinct-attribute-combination cap per instrument; the 2001st+
combination collapses into a shared `otel.metric.overflow` bucket rather
than growing without bound. This library never constructs a
`MeterProvider` itself, so this protection is entirely the host's, not
this library's — and this library applies no cap of its own to
`gen_ai.tool.name`, unlike the 128-character cap it does apply to
`error_class`/`error.type`. That asymmetry — a mitigation this codebase
already uses elsewhere for exactly this class of risk, simply never
applied here — is the concrete gap this ADR evaluates closing.

## Decision 1 — Registry reachability: available for one server shape, not the other, and never live

**Checked against both installed SDKs' actual source, not assumed.**

`instrumentMcpServer()` accepts either a low-level `Server` or a
high-level `McpServer` (`detectServerKind()`, `src/instrument.js`), and
wraps at the low-level `Server.setRequestHandler()` layer in both cases —
the same layer regardless of which shape was passed, by design (ADR 001).
This has a direct consequence for registry access:

- **Low-level `Server`, used directly (no `McpServer` wrapper) — no
  registry exists that this library can inspect, at all.** This is a
  first-class, fully-supported usage mode, not an edge case. The
  `CallToolRequestSchema`/`'tools/call'` handler such a host registers is
  an opaque function; whatever validation logic decides "is this tool
  name real" lives entirely inside it, invisible to `instrumentMcpServer()`.
  There is no "the registered tool set" object to check against for this
  shape — the phrase itself doesn't refer to anything reachable here.
- **High-level `McpServer` (v1 `@modelcontextprotocol/sdk` or v2
  `@modelcontextprotocol/server`) — a registry object exists, and the
  outer `McpServer` instance is already retained in scope
  (`detectServerKind()`'s `outer` field, used today for
  `shutdown`/`getThrashSummary`/`getObservationState`), but the registry
  itself is a private, undocumented implementation detail with no public
  accessor.** Confirmed directly against both SDKs' shipped source:
  - v1 (`@modelcontextprotocol/sdk/dist/esm/server/mcp.js`):
    `this._registeredTools = {}` — a plain object map, read directly by
    the SDK's own internally-installed `tools/list`/`tools/call`
    handlers. No `getTools()`, no `listTools()`, no public getter
    anywhere on the class.
  - v2 (`@modelcontextprotocol/server`'s `mcp-*.cjs`): identical shape —
    `_registeredTools = {}`, same underscore-prefixed class field, same
    absence of a public accessor. Entries additionally carry an
    `enabled` flag the internal `tools/list` handler filters on, so
    "registered" and "currently listable" aren't even the same set.

  Reading `outer._registeredTools[toolName]` would be a cheap, O(1)
  lookup — performance is not the obstacle. The obstacle is that neither
  SDK has committed to this field's existence, shape, or name as public
  API. Depending on it would recreate, for cardinality safety, exactly
  the version-coupling risk ADR 001's outer-shape duck-typing and ADR
  015's `instanceof`-only inner-`Server` check were both built
  specifically to avoid for wrapping itself.

**The one mechanism that works for both server shapes without touching a
private field: passively observe real `tools/list` responses as they
occur, not query a registry.** `wrapToolsListHandler()`
(`src/instrument.js`) already intercepts every `tools/list` call for
schema-drift capture and already reads `result.tools` after the
handler resolves — for a low-level `Server`, `result` is whatever the
host's own handler returned; for an `McpServer`, it's the SDK's
auto-generated handler reading the same private registry the section
above can't access directly. Either way, `result.tools`' name list is
public output the host already chose to return to a real caller, not an
internal field this library would be reaching into. Building a "names
seen so far" set from that observation is the only registry-adjacent
signal available uniformly across both server shapes — but it is
inherently a cached, demand-driven observation, never a live query
(nothing forces a `tools/list` call to happen before the first
`tools/call`, and this library cannot request one on its own — it does
not own the client relationship). Decision 2 evaluates what that
staleness actually costs.

**Conclusion:** registry-based validation is not a uniformly-available
mechanism. It's unavailable by construction for low-level `Server` users,
available only via an undocumented private field for `McpServer` users
(rejected as a dependency for the same reason this project has already
rejected equivalent risks elsewhere), and the one general alternative —
observing real `tools/list` traffic — is cached and stale by nature, not
a clean yes/no answer to "can we check." Every option below inherits this
constraint.

## Decision 2 — Dynamic registration: the observed-set mechanism is unavoidably stale, in three distinct ways, two of which produce false positives

Given Decision 1, "live vs. cached" isn't a choice — an observed set is
the only mechanism available, so it's cached by construction. What
matters is what staleness costs, in each direction a race can go:

1. **Tool registered after the observed set was last built, called
   before any new `tools/list` refreshes it.** `notifications/tools/list_changed`
   is real, confirmed live against both installed SDKs
   (`registerTool()`/`.update()` are callable post-`connect()` in both) —
   but it's a signal a *client* may react to by re-listing, not something
   this library can force. A perfectly valid call to a newly-registered
   tool would be flagged unrecognized for an unbounded window, up to the
   lifetime of a client that never re-lists. **False positive.**
2. **Tool unregistered, called anyway by a client working from stale
   information.** The observed set still contains the now-invalid name,
   so this library's own check would pass it through — but the
   underlying `tools/call` handler still rejects it at the protocol
   level regardless, exactly as it does today. This direction costs
   nothing extra; the mitigation is merely imperfect, not wrong.
3. **Cold start: the very first `tools/call` a server ever receives,
   before any `tools/list` has been observed.** The observed set is
   empty. Every call — including to a real, correctly-registered tool —
   would be flagged unrecognized until some client happens to list
   first. Most well-behaved MCP clients do call `tools/list` during
   capability negotiation, but nothing in the protocol *requires* it
   before the first `tools/call`, and a scripted/testing client, or an
   agent reusing a tool list cached from a prior connection, can
   legitimately skip it. **False positive.**

Two of three race directions misclassify **legitimate** traffic as
unrecognized, not just genuinely bad traffic. That's the decisive fact
carried into Decision 3: any value-validation approach built on the only
available mechanism has a real, structural false-positive cost against
healthy calls — not a hypothetical edge case, a consequence of how the
mechanism has to work given Decision 1's constraint. Bounding that cost
further (e.g., only bucket after N consecutive unrecognized calls to the
same name within a window) is possible in principle, but is itself a new
stateful heuristic with its own threshold/window design space — the same
shape of complexity Agent Thrash Detection's own threshold/window
tuning already represents, not a small addition on top of this ADR's
actual scope.

## Decision 3 — What happens to an unrecognized name: document only, not drop or bucket

Three options, entry 11's own framing, each argued with Decision 1/2's
findings folded in:

**Drop the metric entirely for that call.** Loses the "flood of calls to
nonexistent tools" signal entry 11 already flags as itself worth
alerting on — and, per Decision 2, would *also* silently drop
`mcp.tool.calls`/etc. for a real fraction of legitimate first-calls and
post-registration-lag calls, on top of the calls it's actually meant to
catch. Additionally creates a visible inconsistency an operator would
have to learn: the call's span still exists, in full detail: the call
plainly happened, yet it's invisible on every aggregate dashboard.
Rejected — the cost compounds rather than trades off.

**Bucket to a placeholder (e.g. `"<unknown>"`) on the metric label only,
leaving the span attribute untouched.** Keeps aggregate call-volume
visible (a real improvement over dropping), at the cost of losing which
specific name every unrecognized call used, on the metric side — and,
per Decision 2, this bucket would *also* catch a share of legitimate
calls, not just bad ones, indistinguishable in the aggregate from actual
bad-name traffic. This is the *only* one of the three options this ADR
would recommend if a validate-based approach were adopted at all — see
Decision 4 for why the split treatment is correct, not confusing. But
adopting it means accepting a mechanism (Decision 1/2) unreliable enough
to misclassify healthy traffic, for a benefit (narrower overflow
protection) the status quo already delivers in a different, deterministic
shape (the SDK's own overflow bucket, host-version-dependent but never
wrong about *which* calls it applies to).

**Document only — the option already in effect.** The failure mode,
per Decision 1/2, is real but every available mitigation costs more than
it's worth: unavailable for half this library's supported inputs, coupled
to undocumented SDK internals where it is available, and — even in its
best available shape (observed-set bucketing) — trades a deterministic,
universal, host-controlled degradation (SDK overflow bucket) for an
earlier, less complete, and occasionally *wrong* one of this library's
own making. **Recommended.** Decision 6 weighs this formally against the
one-time cost of building and maintaining the alternative.

## Decision 4 — Span and metric label should not receive the same treatment, even if validation were ever built

Not confusing — this is the same shape of tradeoff this codebase has
already argued for and shipped, applied to a new attribute rather than
inventing a new pattern:

- A span is a single, self-contained record. High-cardinality content on
  it costs nothing shared — `mcp.failure.fingerprint`/`signature` already
  carry unbounded values on spans today, by design (`METRIC_SAFE_ATTRIBUTES`,
  `src/fingerprint/attributes.js`, deliberately excludes them from every
  metric label for the identical reason this ADR is examining for
  `gen_ai.tool.name`).
- A metric label feeds a shared, cardinality-bounded index across every
  call, forever (until the metric resets). The same value that's free on
  a span is expensive there.

`mcp.failure.category`/`origin` (bounded 8×3 enum space) are metric-safe;
`fingerprint`/`signature`/`error_class`/`validation_paths` are span-only —
this project already ships one attribute with two different values at
two different fidelities for exactly this reason, and nobody has found
that confusing in practice. It's also a standard, widely-recognized
pattern outside this codebase: a structured access log records a
request's full URL; the metrics counter built from the same traffic
labels by route *template* (`/users/:id`), not the literal path with
real ids in it — the same "full fidelity where it's free, a bounded
projection where it isn't" split, for the same reason. If validation is
ever built, the span attribute should keep the real name unconditionally
(already true today, and not a new risk — a span's own cardinality is
bounded by how many spans exist, not by a shared index) and only the
metric label gets the placeholder treatment. Recorded here so a future
implementer doesn't have to re-litigate it, even though Decision 3
recommends not building it now.

## Decision 5 — Scope: `gen_ai.tool.name` only for validation; the allowlist mechanism gap is real, shared, and fixed separately

Entry 11 traces the identical root cause through three attributes:
`gen_ai.tool.name` (this ADR), `mcp.tool.model` (its own shape gate,
`isValidModelId()`, bounds length/character-set but not the *size* of
the set of distinct values — a materially different, already-partially-mitigated
situation), and `error.type` (identical underlying value to
`mcp.failure.error_class`, which is *deliberately* excluded from
`METRIC_SAFE_ATTRIBUTES` — yet reaches `mcp.tool.errors` anyway, because
`ATTR_ERROR_TYPE` is governed in `src/attributes.js` as a spec attribute,
a separate file/domain `METRIC_SAFE_ATTRIBUTES` has no jurisdiction
over).

**This ADR does not cover all three.** `mcp.tool.model` has its own
ADR lineage (ADR 016, ADR 019 Part 2) and a materially different
mitigation shape already in place; folding it in here would be exactly
the "bundled patch" scope creep `docs/known-gaps.md` entry 10 already
explicitly rejected for a structurally identical situation ("Both need
their own scoped decision... not a bundled patch folded into this
entry"). `error.type` is spec-governed territory (ADR 004), a different
code surface with its own governance history. Each deserves its own
decision if one is warranted, not a shared one made under this ADR's
narrower title.

**But the *mechanism* gap entry 11 names — "a gap in the mechanism, not
just this value" — is real, shared across all three, and worth fixing on
its own, independent of what Decision 3 concludes for `gen_ai.tool.name`
specifically.** Checked directly against `src/metrics.js`: no call
site — `recordCall`, `recordError`, `recordDuration`, `recordTokens`,
`recordCost`, none of them — ever consults `METRIC_SAFE_ATTRIBUTES` or
`COST_METRIC_SAFE_ATTRIBUTES` before attaching a label. Only
`ATTRIBUTE_KEYS.CATEGORY` is conditionally attached, and that's a
docblock-documented convention followed by whoever wrote that line, not
anything the code enforces. The same is true in `src/thrash/emitter.js`
and `src/schema-drift/emitter.js`. **These lists are governance
documentation for a human to consult before adding a new attachment
site — never a runtime or test-time gate.** That's a stronger version of
entry 11's own finding: it isn't that `error.type` falls outside one
list's jurisdiction, it's that *no* list is ever actually checked, for
*any* attribute, by anything but a future self-review pass happening to
notice.

**Decision: add a dev-time (test-suite) invariant, not a runtime check,
that closes this specific gap — independent of, and compatible with,
whatever Decision 3 concludes for `gen_ai.tool.name`'s values.** A test
that statically collects every attribute key literal used as a metric
label across `metrics.js`/`thrash/emitter.js`/`schema-drift/emitter.js`
and asserts each one is a member of an explicit, reviewed allowlist would
have caught `gen_ai.tool.name`, `mcp.tool.model`, and `error.type` never
being added to one, the same release each was introduced — a deterministic,
zero-runtime-cost, zero-behavior-change catch, in the same spirit as
`scripts/verify-tarball.js`'s own release-gate role. Concretely, this
means:

- A new `METRIC_SAFE_ATTRIBUTES` export in `src/attributes.js` (mirroring
  `fingerprint/attributes.js`'s and `schema-drift/attributes.js`'s
  same-named exports), covering the spec/custom attributes that file
  governs and are used as labels today: `ATTR_GEN_AI_TOOL_NAME`,
  `ATTR_MCP_METHOD_NAME`, `ATTR_MCP_TOOL_OUTCOME`.
- **`gen_ai.tool.name`'s entry in that new list is a deliberate,
  documented acceptance of Decision 3's status quo — not a fresh
  endorsement that it's safe.** The docblock should say exactly that,
  citing this ADR, so the list itself carries the correction entry 11
  made necessary rather than silently re-asserting the two superseded
  passages' original claim.
- **`ATTR_ERROR_TYPE` is the one genuinely awkward entry, and should be
  called out as such rather than quietly included.** Adding it to the
  new list alongside `gen_ai.tool.name` would paper over the exact
  inconsistency this Decision just diagnosed — the identical value is
  deliberately excluded from `mcp.failure.error_class`'s own list.
  Recommended: include it, but with a docblock stating plainly that this
  is existing, pre-existing behavior being made explicit and traceable
  (to known-gaps 10 and this entry), not a newly-argued safety claim —
  removing it from the label outright would be a behavior change with
  its own cost/benefit this ADR's scope doesn't cover.
- `mcp.tool.model` is intentionally left out of this pass — see the
  scope note above; its own list (or an explicit non-inclusion decision)
  belongs to whatever ADR next revisits ADR 016/019 Part 2's territory,
  not this one.
- The test itself lives wherever this project's existing metrics/attribute
  tests already do (`test/metrics.test.js` and neighbors) — a single new
  describe block, not a new file, matching how this codebase generally
  scopes small governance tests.

This is a small, low-risk, purely additive change: no runtime behavior
changes, no public API changes, and it fails loudly at test time if a
future attribute is added to a metric label without a matching allowlist
entry — exactly the kind of dev-time-only enforcement this project
already favors (`verify-tarball.js`, the ADR-discipline convention
itself) over adding cost to the hot path.

## Decision 6 — Is this worth fixing at all: yes, partially, and honestly

The consequence, confirmed directly against the installed
`@opentelemetry/sdk-metrics`, is host-SDK-dependent overflow aggregation
— bounded memory, no crash, no leak of anything the tool catalog doesn't
already expose via `tools/list` to any connected client. Weighed against
that:

- **Value-validation (Decisions 1-4): not worth it.** Every mechanism
  available is either categorically unavailable (low-level `Server`),
  coupled to undocumented SDK internals (`McpServer`'s private registry),
  or — in its best available shape, observed-set bucketing — trades a
  deterministic, universal degradation this library doesn't control for
  an earlier, incomplete, occasionally-wrong one that it does. The
  false-positive cost against legitimate traffic (Decision 2) is the
  deciding fact, not the amount of code a fix would take. **Document
  only** — update `docs/known-gaps.md` entry 11 to record this ADR as
  its resolution (decision: document, not implement), and correct the
  two superseded ADR passages by reference (this document + entry 11),
  not by editing ADR 010/012's original text, per this project's own
  convention.
- **The allowlist mechanism gap (Decision 5): worth fixing, cheaply.**
  The dev-time invariant test is a small, additive, zero-behavior-change
  catch for a real structural gap — worth doing regardless of what this
  ADR concludes about `gen_ai.tool.name`'s values specifically, since it
  guards every *future* attribute this project adds to a metric label,
  not just the three entry 11 already found.

Both conclusions honestly reflect what the evidence in Decisions 1-5
supports, not a default toward "do nothing" or a default toward "always
build something."

## Constraints accepted

- No registry-based validation of `toolName` against a server's actual
  registered tools, for either supported server shape — Decision 1.
- No cardinality mitigation applied to `gen_ai.tool.name` on metric
  labels in this pass — the label carries the same unvalidated,
  unbounded value it does today.
- `mcp.tool.model`'s and `error.type`'s own cardinality questions are
  explicitly out of scope for the validation half of this ADR — Decision
  5.
- The new `METRIC_SAFE_ATTRIBUTES` list in `src/attributes.js` documents
  and makes explicit the *existing* set of labels this codebase already
  attaches without a cap — it does not change which values are attached
  or remove any label from any metric.

## Alternatives rejected

- **Reading `outer._registeredTools` directly.** Rejected in Decision 1 —
  undocumented private field, present on neither installed SDK's public
  API surface, and only reachable for one of two supported server
  shapes at all.
- **Requiring hosts to supply their own registered-tool-name list as a
  new `instrumentMcpServer()` option.** Not evaluated in depth here
  because it doesn't change Decision 2's staleness analysis (a
  host-supplied list is exactly as capable of going stale relative to
  dynamic `registerTool()`/`.update()` calls as an observed one, and adds
  a second source of truth a host has to keep in sync with their own
  registration calls) — would need its own ADR if pursued, not folded in
  as a minor variant here.
- **Dropping the metric entirely for an unrecognized name.** Rejected in
  Decision 3 — compounds the false-positive cost with a second,
  independent loss (aggregate call volume).
- **A stateful "N consecutive unrecognized calls" heuristic before
  bucketing.** Noted in Decision 2 as a way to bound the false-positive
  cost further, not adopted — its own threshold/window design space,
  comparable in complexity to Agent Thrash Detection, disproportionate to
  what Decision 6 concludes this problem is worth.
- **Folding `mcp.tool.model` and `error.type` into this ADR's scope.**
  Rejected in Decision 5 — different governance history, different
  existing mitigations, and this project's own precedent (known-gaps
  entry 10) against bundling independently-scoped attribute decisions
  into one document.
- **A runtime (per-call) allowlist check instead of a dev-time test.**
  Rejected in Decision 5 — the twelve call sites this concerns are
  already on the hot path; a per-call check buys nothing a one-time,
  deterministic test doesn't already guarantee, for a real (if small)
  per-call cost.

## Versioning: no dedicated release, folds into whatever ships next

Unlike v0.14.0's redactor hook (a new public API surface, phased across
four releases), this ADR's only concrete action items are: a
`docs/known-gaps.md` update recording this ADR as entry 11's resolution,
a documentation-only correction note pointing from ADR 010/012 to this
ADR and entry 11, a new `METRIC_SAFE_ATTRIBUTES` export in
`src/attributes.js` (additive, no existing export changed or removed),
and one new test file/describe block. None of these change public API,
runtime behavior, or emitted telemetry in any way a consumer could
observe or need to react to. **Recommended target: whatever the next
release is** (patch or minor, whichever this project's own SemVer
discipline calls the next planned cut) — no dedicated version, no
phasing, and no reason to hold either the documentation fix or the test
back waiting for unrelated work.

## Consequences

- `docs/known-gaps.md` entry 11 gains a resolution note pointing here;
  the entry itself is not deleted or rewritten, matching entries 6, 7, 8's
  own precedent for a correction recorded as an appended update.
- `docs/adr/010-schema-drift.md` and `docs/adr/012-tracker-lifecycle-and-shared-state.md`
  are not edited — both are superseded, by reference, via this document
  and entry 11, consistent with this project's stated convention of never
  rewriting an ADR's original reasoning after the fact.
- `gen_ai.tool.name` remains exactly as unvalidated and unbounded on
  every one of its twelve current label sites as it is today — this ADR
  changes nothing about runtime behavior.
- A new, small, dev-time-only test starts enforcing that any *future*
  attribute added to a metric label across `metrics.js`/`thrash/emitter.js`/
  `schema-drift/emitter.js` must appear in an explicit, reviewed allowlist
  — closing the mechanism gap for new attributes even though this ADR
  declines to close it for `gen_ai.tool.name`'s existing values.
- If a deployment's tool-name cardinality genuinely exceeds what a host's
  own `@opentelemetry/sdk-metrics` overflow protection tolerates, the
  documented, supported mitigation remains what it already is today:
  configure that SDK's own cardinality limit, or filter/aggregate
  `gen_ai.tool.name` in a Collector processor before export — the same
  "Collector recipe, not a library feature" posture ADR 011 already
  established for cost-aware sampling, extended here to cardinality
  rather than solved by new library code.
