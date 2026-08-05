# ADR 010: Tool schema drift detection

**Status:** Proposed — investigation only, no implementation. First of three
features scoped for v0.8.0. Written the same way ADR 008/009 were: an
investigation against the installed SDK (`@modelcontextprotocol/sdk@1.29.0`)
that settles the open design questions, ending in a recommendation rather
than shipped code.

## Context

MCP servers advertise every tool's `inputSchema` via `tools/list`. If a
server silently changes that schema between deployments — a parameter
renamed, a type tightened, a `required` field added — an agent that cached
the old shape (or whose prompt/tool-calling code was generated against it)
starts failing tool calls with no signal pointing at the actual cause. The
existing `mcp.failure.*` pipeline (ADR 006, ADR 007) would eventually see
the resulting `protocol.input` validation failures, but nothing today
connects those failures back to "the schema itself changed under you,"
which is a materially different, more actionable diagnosis than "the agent
sent bad arguments."

Four questions had to be answered against the real SDK before any design
was possible, and all four required reading `node_modules/@modelcontextprotocol/sdk`
directly rather than assuming behavior from docs.

## Findings

### 1. When `tools/list` is called, and whether `list_changed` matters

`tools/list` is a stateless, client-initiated request with no server-side
caching. For `McpServer`, the registered handler recomputes the entire
tool list from live state on every single invocation:

```
this.server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: Object.entries(this._registeredTools)...
```

(`server/mcp.js:67-99`). Nothing in the SDK restricts a client to calling
this once per connection — a client can re-request it at any point in a
session, and different clients plausibly do this on different cadences
(some re-fetch every turn, some cache indefinitely). This matters directly
for the design: schema drift can only be *observed* the next time some
client happens to call `tools/list`, not the instant a tool is redefined
server-side.

The SDK does push `notifications/tools/list_changed`
(`sendToolListChanged()`, `server/mcp.js:765-769`), fired automatically by
`RegisteredTool.update()` whenever a tool's name, description, schema, or
enabled state changes (`server/mcp.js:605-652`, specifically the
`this.sendToolListChanged()` call at line 646). This confirms the exact
scenario this feature targets — `registerTool(...).update({ paramsSchema:
newSchema })` — is a real, first-class, publicly documented SDK capability
that already exists today, not a hypothetical.

Current instrumentation sees **none of this notification traffic** — it
has no hook on any outbound/server-to-client message, only on inbound
request-handler registration (see Q2). This turns out not to matter for
the recommended design below, which drives entirely off observed
`tools/list` *responses*, not the notification that one might be about to
change. Listening for `list_changed` could let drift be flagged the
instant it happens rather than on the next `tools/list` call, but that
requires patching a second, structurally different surface (outbound
notification sending, not request-handler registration) — an additional
hook point this investigation recommends *not* taking on in a first pass
(see Alternatives rejected).

### 2. THE DECIDING QUESTION — does the wrapped handler path see `tools/list`?

**No, not today — but the already-patched hook point sees the
registration call and simply chooses not to act on it. Extending it is a
direct, unmodified application of ADR 001, not a conflict with it.**

`instrument.js:205-224` patches `server.setRequestHandler` at the instance
level and wraps the handler only when `schema === CallToolRequestSchema`
(line 207); every other schema — including `ListToolsRequestSchema` —
passes straight through unwrapped via `originalSetRequestHandler(schema,
handler)` at line 223. Since `Server extends Protocol`
(`server/index.js:33`) and `Protocol.prototype.setRequestHandler`
(`shared/protocol.js:886-892`) is the exact single extension point ADR 001
identified as the SDK's only hook, **the patched call already intercepts
the `ListToolsRequestSchema` registration for both server APIs**:

- Low-level `Server`: a host registers `ListToolsRequestSchema` directly,
  through the same patched method as `CallToolRequestSchema`.
- `McpServer`: `setToolRequestHandlers()` registers `ListToolsRequestSchema`
  *then* `CallToolRequestSchema` through this same patched method, in one
  lazy call the first time any tool is registered (`server/mcp.js:60-100`,
  guarded by `_toolHandlersInitialized` so it only fires once per
  instance) — already covered by the existing "instrument before
  registration" constraint ADR 001 established for `CallToolRequestSchema`.

Adding a second branch — `if (schema === ListToolsRequestSchema) { handler
= wrapToolsListHandler(...) }` — alongside the existing `CallToolRequestSchema`
branch at `instrument.js:206-224` is architecturally identical to what ADR
001 already does: same instance-level patch, same idempotency guard
(`kInstrumented`), same instrument-first constraint, same reference-equality
schema check (avoiding the zod-internals coupling ADR 001's "Alternatives
rejected" already ruled out). This is **not** the `parseWithCompat`
pre-handler gap from ADR 007 / `known-gaps.md` #3 — that gap lives one
layer *above* `setRequestHandler`, inside `Protocol.setRequestHandler`
itself (`shared/protocol.js:886-892`, the schema-parse step that runs
before either branch's handler is invoked), applies identically and
unavoidably to both `tools/call` and `tools/list`, and is out of scope
here exactly as it was out of scope for ADR 007.

**Verdict: the hook point is clean. No second architectural hook, no
revisiting ADR 001, no conflict.** This is the load-bearing finding for
the rest of this document — the recommendation below assumes it, and
would need to be renegotiated entirely if it were false.

### 3. Is `inputSchema` stably serializable?

For `McpServer`, `inputSchema` is regenerated from the tool's Zod shape on
*every* `tools/list` call via `toJsonSchemaCompat()`
(`server/zod-json-schema-compat.js:18-31`), which delegates to the
third-party `zod-to-json-schema` package (line 8). For a fixed,
unchanged Zod schema object, this is very likely deterministic in
practice — but that is not a documented, versioned contract of a
dependency this project doesn't control, the same posture ADR 007 already
takes toward SDK message-text stability. For a hand-rolled low-level
`Server`, `inputSchema` is whatever JSON the host's own code produces —
built however that author likes, with no convention at all governing key
order.

**Canonicalization is required**, for the same reason ADR 006 rejected
hashing the raw error message: naive `JSON.stringify(inputSchema)` +
hash would produce false "drift" from key reordering alone — a dependency
patch bump, a refactor of how a host builds its schema object, or simply
running on a different Node/V8 build, none of which represent an actual
schema change. The fix is cheap: recursively sort object keys before
stringifying. Cost is bounded by one tool's schema size (small, and
authored by the server operator, not attacker/client-controlled), well
within the same microsecond-scale budget the existing fingerprint
pipeline already meets (`test/fingerprint/benchmark.test.js`).

**Is the v0.4 hasher reusable? Yes, directly — the primitive, not the
composer.** `src/fingerprint/hash.js`'s `hashInputs(input)` is a generic,
already-pure `sha256(input).slice(0, 16)` with zero coupling to
failure-specific concerns (`hash.js:37-39`) — it takes a pre-built
canonical string and returns a truncated hex digest, nothing more. That
function can be called as-is. What is **not** reusable is
`fingerprint/compose.js`'s `computeFingerprint()` — that function is
entirely specific to error/failure shapes (classification, message
normalization, stack normalization) and has no bearing on a tool
definition. Schema drift needs its own small composer: canonicalize the
schema object into a deterministic string, prefix it with a version tag
the same way `compose.js`'s `HASH_INPUT_VERSION` does (`compose.js:23`,
`v1|...`) — so a future change to what's canonicalized (e.g. deciding to
include `annotations` or `outputSchema`) can ship as a new version without
silently reinterpreting hashes already recorded — then feed that string
through the existing `hashInputs()`.

### 4. State scope: per-session or per-server?

**Per-server-instance, keyed by tool name — not per-session.** This is
the one place a naive implementation would get it wrong by copying Agent
Thrash Detection's existing session-keyed pattern
(`resolveThrashSessionId()`, `instrument.js:481-505`) without noticing the
underlying object being tracked is different in kind.

`_registeredTools` (`server/mcp.js:19`) is a single object shared by
*every* session connected to one server instance — it is not per-session
state, unlike a thrash episode (which is genuinely scoped to one agent's
conversation). If schema snapshots were keyed by `sessionId` the way
thrash entries are, two failure modes follow directly:

- A brand-new session would independently hit "cold start" for a schema
  that has been stable and unchanged for weeks, since that session's key
  has never seen it — a spurious "first observation" flag with no real
  drift behind it.
- Worse, a real drift that happened *between* two sessions would go
  undetected: the new session's own "first observation" for its key
  becomes the post-drift schema, with nothing under that key to compare
  against — silently swallowing the exact signal this feature exists to
  produce.

The correct scope: one plain `Map` keyed by tool name, held in the
`instrumentMcpServer()` closure alongside `thrashDetector` /
`budgetTracker` (`instrument.js:164-190`) — constructed once per
instrumented server instance, read and updated on every `tools/list`
response regardless of which session's request triggered it. Unlike
thrash's session map, this does **not** need `BoundedTtlMap`'s
LRU/TTL eviction machinery (`thrash/store.js`) — a server's own tool
count is inherently small and bounded by its own registry, not by
attacker/client-controlled session volume, so a plain `Map` is
sufficient and simpler.

**The real, honest caveat**: this only works when the host keeps one
long-lived instrumented `Server`/`McpServer` instance alive across
sessions — exactly the stdio case (one process, one connection, for the
process's entire lifetime) and the common HTTP pattern this package's own
`resolveThrashSessionId()` already assumes (one instrumented instance,
many sessions differentiated by `extra.sessionId`). Some HTTP deployments
instead construct a *fresh* `Server`/`McpServer` per session (stateless
mode) — in that topology, the tool-name-keyed map resets every session,
and cross-session drift becomes undetectable by construction. This
package cannot detect or fix that topology choice; it can only be
documented as a limitation, the same way ADR 008 documented
`LIVENESS_INDETERMINATE` as an expected, not rare, outcome.

## Decision

### What "drift" means, concretely

A tool's canonicalized, hashed schema changing between two observed
`tools/list` responses. Sub-classified, on a best-effort basis, into:

- **`field_added`** — a key present in the new `inputSchema.properties`
  absent from the old one.
- **`field_removed`** — the inverse.
- **`type_changed`** — a property present in both, but its JSON Schema
  `type` (or `enum`/`const`/`format` where `type` alone doesn't capture
  the constraint) differs.
- **`required_changed`** — the `required` array gained or lost an entry
  independent of the property itself appearing/disappearing (e.g. an
  existing optional field became mandatory).
- **`description_changed`** — see below; tracked as a distinct, additive
  dimension, not folded into the above.
- **`multiple`** — more than one of the above changed in the same
  observation; reported rather than arbitrarily picking one, the same
  "never guess a single answer when more than one is true" discipline
  `classifyFailureChannel()` already follows.
- **`unknown`** — the diff logic itself couldn't confidently characterize
  what changed (e.g. a schema shape canonicalization doesn't handle, such
  as nested `oneOf`/`anyOf` branches reordering) — never silently
  reported as one of the above, the same non-guessing discipline as
  `classifyFailureChannel()`'s own `'unknown'`.

**Is a description-only change worth flagging?** Yes, but as a separate,
lower-weight signal, not merged into the structural drift dimension
above. The argument for including it at all: a tool's `description` is
what the calling model actually reads to decide *how* to invoke the tool
and *when* to trust its output — a description that silently changes
(without any change to `inputSchema`) can alter agent behavior just as
consequentially as a type change, and is exactly the vector "MCP tool
poisoning" / "rug-pull" attacks already documented in the wider MCP
security community rely on: a tool approved once, then redefined via
description alone, with no schema-shape signal at all to catch it. A
schema-drift feature that only watches `inputSchema` and ignores
`description` would miss that entire class of change by construction.

The argument against merging it into the same signal as structural
drift: descriptions are edited far more often for benign reasons (typo
fixes, clarity wording, formatting) than a schema's structural shape
changes, and folding both into one "drift detected" signal would drown
the rare, high-signal structural case in comparatively frequent,
low-stakes wording noise — the same reasoning ADR 007 already used to
keep `channel` a separate additive attribute rather than reusing `origin`,
and ADR 006 used to keep `category` and `fingerprint` on visibly
different cardinality tiers.

**Decision: track `description_changed` as its own boolean/enum
dimension on the same drift event, computed and reported independently
of the structural diff** — a tools/list observation can report structural
drift, description drift, both, or neither, rather than collapsing to one
verdict. Operators who want tight, low-noise alerting can filter to the
structural dimension alone; operators who want the full tool-poisoning
surface get both without a second feature.

### What gets emitted, and cardinality

Two things, following the existing split between spans (rich, one-shot)
and metrics (aggregated, cardinality-bounded) this package already
maintains for tool-call telemetry:

1. **A span per `tools/list` call**, named `tools/list` (a new
   `MCP_METHOD_NAME_TOOLS_LIST` constant, `SpanKind.SERVER` — mirroring
   the existing `${TOOLS_CALL_METHOD} ${toolName}` pattern at
   `instrument.js:676-678`, minus the per-tool name since one `tools/list`
   response covers every tool at once). When drift is detected, span
   attributes list which tool(s) drifted and how —
   `mcp.tool.schema_drift.tools` (a bounded list of tool names, bounded by
   the server's own registry size) and, per drifted tool, its
   `drift_type`. Span-only, matching how `mcp.failure.validation_paths`
   (ADR 009) is kept span-only rather than a metric label, for the same
   reason: informative for one observation, not something you want on
   every time series.
2. **A counter, `mcp.tool.schema_drift.detected`**, incremented once per
   (tool, drift observation), with attributes `gen_ai.tool.name` (the
   existing attribute already used as a metric label on every other
   `mcp.tool.*` counter — `ATTR_GEN_AI_TOOL_NAME`, `metrics.js:100-137` —
   so this isn't a new cardinality precedent, it's reusing one already
   accepted) and a new `mcp.tool.schema_drift.type` attribute holding the
   bounded enum above (7 values). Cardinality is `(#tools registered on
   this server) × 7` per deployment — the same shape of bound
   `METRIC_SAFE_ATTRIBUTES` already relies on for `category`/`origin`
   (`fingerprint/attributes.js:10-12`, an 8×3 space), not the unbounded
   shape that keeps `fingerprint`/`signature`/`validation_paths` span-only.
   `description_changed` is reported as a **separate** boolean attribute
   on the same counter event (not a distinct counter), so a dashboard can
   `sum by (drift.type)` for structural-only alerting while still having
   the description dimension available to filter on.

### Cold-start handling

The first `tools/list` observation for a tool this server-instance's map
has never seen must **not** report drift — there is no prior snapshot to
compare against, so "different from nothing" is not a meaningful verdict.
This mirrors `ThrashDetector`'s and `computeFingerprint()`'s own
established discipline of a defined, inert behavior for "no prior state"
rather than a guessed answer. Concretely: `wrapToolsListHandler` records
the canonical hash for every tool present in the response; only a tool
*already present* in the map with a *different* hash than before is
eligible to report drift. A tool appearing in the map for the very first
time is recorded silently. This also means a tool being added or removed
outright (present in the new response but not the map, or vice versa) is
a distinct, separate signal from `field_added`/`field_removed` *within*
an existing tool's schema — a new tool is not "drift" of anything, it's
a new tool; only an existing, previously-observed tool's schema changing
counts.

## Constraints accepted

- Canonicalization assumes a bounded, JSON-Schema-shaped `inputSchema`
  object — recursive key-sorting over arbitrary depth is fine for this
  (schemas are small, operator-authored, not user-controlled), but the
  diffing logic that classifies *what* changed (added/removed/type/
  required) needs its own bounded traversal depth or `unknown` fallback
  for schemas using less common JSON Schema constructs (`oneOf`, `anyOf`,
  `$ref`) that a first-pass differ may not confidently interpret — same
  never-guess discipline as `classifyFailureChannel()`.
- Per-server, tool-name-keyed state (Q4) assumes the host keeps one
  instrumented `Server`/`McpServer` instance alive across the sessions it
  serves. A host that constructs a fresh instance per HTTP session gets
  no cross-session drift detection at all, silently, by construction —
  this must be documented plainly (README "Known limitations"), not
  discovered by an operator wondering why nothing ever fires.
- `description_changed` detection depends on `RegisteredTool`/tool
  definition objects exposing `description` as plain text with no
  templating or dynamic generation between calls — a tool whose
  description is regenerated with cosmetic non-determinism every
  `tools/list` call (e.g. embedding a timestamp) would false-positive on
  every observation. No evidence this happens in practice was found in
  this investigation; flagged as an assumption, not a confirmed absence.
- Canonicalization + hashing runs on every `tools/list` response, and
  unlike `tools/call` (naturally rate-limited by actual agent tool usage),
  `tools/list` call frequency is entirely client-controlled — some clients
  re-fetch it every turn. Per-call cost scales with total schema size
  across all registered tools, which should stay well within budget for
  realistic tool counts, but this is a different cost profile than the
  rest of this package's per-call-bounded work and is worth a benchmark
  before shipping, not just an assumption carried over from the
  fingerprinting budget.

## Alternatives rejected

- **Hooking outbound `notification()`/`sendToolListChanged()` to react to
  drift the instant it happens**, rather than waiting for the next
  client-initiated `tools/list`. Rejected for a first pass — this is a
  structurally different hook (outbound message send, not inbound
  request-handler registration) than anything ADR 001 established or
  anything the rest of this package touches, adding a second, new
  architectural surface for a feature whose primary hook point (Q2) is
  otherwise clean. Revisit only if "instant" detection turns out to
  matter in practice; "detected on the next `tools/list` call" is a
  materially simpler v1 with no correctness gap for any client that
  calls `tools/list` at all.
- **Session-keyed drift state**, copying `resolveThrashSessionId()`
  directly. Rejected per Q4's findings above — actively wrong, not just
  unnecessary complexity: produces both false cold-starts per new session
  and false negatives for drift that happens between sessions.
- **Folding `description_changed` into the same enum as structural drift
  (one verdict per observation).** Rejected — see "What 'drift' means"
  above; would drown the rare, actionable structural signal in frequent,
  low-stakes wording-only noise.
- **Hashing the whole tool definition (including `description`) into one
  combined fingerprint**, the way `computeFingerprint()` hashes multiple
  failure dimensions into one value. Rejected — unlike a failure
  fingerprint (where the goal is collapsing many occurrences of *one*
  cause to one identity), here the goal is telling operators *which*
  dimension changed; collapsing to a single opaque hash would answer
  "something changed" without answering the actually useful question,
  which the enum-based approach answers directly.
- **A hosted/external schema-diffing or contract-testing service.**
  Rejected on the same grounds ADR 006 already rejected hosted grouping
  services: this package's stance is a synchronous, local, one-line
  `instrumentMcpServer()` call with no new runtime dependency or network
  call in the critical path (ADR 005).

## Recommendation

**Build it.** The deciding question (Q2) came back clean: the hook point
ADR 001 already established is sufficient, requires no architectural
revisit, and extending it with a `ListToolsRequestSchema` branch is a
direct, unmodified application of the existing patching strategy — the
same conclusion ADR 001's own "Update" reached when McpServer support was
added via duck-typing. Canonicalization is a small, cheap addition reusing
the existing `hashInputs()` primitive; state scope has a correct,
low-complexity answer (a plain `Map`, not a new bounded-store type); and
cold-start handling follows a pattern this package already applies
elsewhere. Nothing here required inventing a new mechanism the rest of
the codebase doesn't already have precedent for.

Scope the v1 narrowly: structural drift (`field_added`/`field_removed`/
`type_changed`/`required_changed`) plus the separate `description_changed`
dimension, span-per-`tools/list`-call plus one bounded-cardinality counter,
no notification hook, no cross-session guarantees beyond what a
long-lived server instance naturally provides. Document the
per-server-instance topology assumption (Q4) and the `tools/list`-call-
frequency cost profile (Constraints) up front in the README, the same way
ADR 008's trace-only scope limit and ADR 007's `McpServer`-reachability
table are surfaced rather than buried.
