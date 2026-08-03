# ADR 007: Protocol-error channel

**Status:** Accepted — implemented across five phases and shipped in
v0.7.0. Originally opened as an investigation-only document (see the
Context section for what v0.4/v0.5/v0.6's failure-detection pipeline did
and didn't see); the Decision below was subsequently implemented in full,
verified against a real McpServer (see the addendum), and its remaining
open questions moved to `docs/known-gaps.md` rather than left implicit.

## Context

External review (Reddit) raised that opentel-mcp's failure detection only
reads the `isError` channel on a `CallToolResult`, missing JSON-RPC protocol
errors — a tools/call request that fails at the wire level with an `error`
object instead of a successful result. Two claims were made and had to be
checked against the installed SDK (`@modelcontextprotocol/sdk@1.29.0`)
rather than assumed:

**Claim A**: unknown tool (-32601) and schema validation failures (-32602)
come back as JSON-RPC error objects, not `isError: true`, still HTTP 200 over
Streamable HTTP.

**Claim B**: `-32602` (InvalidParams) is overloaded across at least four
conditions — tool not found, tool disabled, input validation, output
validation — disambiguated only by the message prefix `"Input validation
error:"` vs `"Output validation error:"`.

Both claims required reading `node_modules/@modelcontextprotocol/sdk`
directly and tracing `src/instrument.js`'s actual code path, not inferring
from docs. Full investigation notes precede this ADR in the conversation
that produced it; the load-bearing findings are summarized below.

### What's actually true

The HTTP-200 part of Claim A is confirmed: `server/webStandardStreamableHttp.js`
sends `isJSONRPCResultResponse` and `isJSONRPCErrorResponse` messages through
one identical `status: 200` path. There is no HTTP-level signal distinguishing
a protocol error from a success.

The rest of Claim A is **not** true as stated, and the discrepancy matters for
scoping this work correctly:

- "Unknown tool → -32601" is wrong. `server/mcp.js` throws `InvalidParams`
  (-32602) for `Tool ${name} not found`. The only tools/call-path -32601 is an
  unrelated, obscure case (`taskSupport: 'required'` called without task
  augmentation).
- For the high-level `McpServer` — the shape `instrumentMcpServer`'s
  `DuckTypedMcpServer` actually targets — `mcp.js`'s own tools/call dispatcher
  wraps itself in a try/catch that converts **every** thrown `McpError`
  (tool-not-found, tool-disabled, input validation, output validation, the
  taskSupport case, and in fact any error at all thrown by the user's handler)
  into `{ isError: true, content: [...] }` and returns it normally. The only
  exception re-thrown is `UrlElicitationRequired`. So for McpServer, all four
  conditions Claim A worried about already arrive via the channel this
  package already reads. They are already fingerprinted, already span-ERROR,
  already thrash-eligible.
- The gap that **is** real and confirmed: `Protocol.setRequestHandler` wraps
  every handler with a schema-parse step (`parseWithCompat`) that runs
  **before** the handler `instrumentMcpServer` wrapped is ever called. A
  malformed `tools/call` request (fails `CallToolRequestSchema` — e.g. a
  missing `name`) throws there, outside `wrapToolCallHandler`'s reach
  entirely. No span is created. Not even the existing `origin: 'thrown'`
  fingerprint path sees it, because that path requires the exception to occur
  *inside* the wrapped handler. This is invisible today, full stop — and
  fixing it means wrapping a layer ADR 001 deliberately chose not to wrap
  (see Consequences).
- A second, narrower case: if `tools/call` has no handler registered at all,
  the SDK sends a genuine `-32601`. This can't happen once `instrumentMcpServer`
  has wrapped anything, so it's not actionable here.

Claim B is confirmed, with a refinement: the message-prefix discriminator
only distinguishes 2 of the (at least) 4 `-32602` conditions. Tool-not-found
and tool-disabled carry no prefix — just `"Tool X not found"` / `"Tool X
disabled"`. Full disambiguation needs four distinct message-shape checks, not
one two-way prefix split, and none of it is backed by a structured field
(`error.data` is unused for this) — it is 100% prose parsing with zero
contract stability.

### A bug this investigation surfaced, not hypothesized

Tracing the actual code path (not the docs) found that `fingerprint/classify/validation.js`'s
matcher (`/\binvalid\b|\bmust be\b|\brequired\b/i`) classifies
`"Output validation error: Invalid structured content..."` as category
`validation` — the same bucket as a legitimate agent argument mistake — even
though the tool's *output* not matching its *own declared output schema* is
entirely the server's bug. `"Output validation error: ...no structured
content was provided"` matches nothing and falls to the `internal` catch-all,
which is scarcely better. Neither `applyThrashDetection` nor `ThrashDetector`
inspects category or origin before recording. **Today, an output-validation
bug that an agent retries already counts toward thrash detection** —
misattributing a server-side defect's cost to "agent thrashing." This is a
present miscategorization, not a projected risk, and it's the strongest
concrete argument for doing this work.

Also notable: `fingerprint/types.d.ts`'s `FailureOrigin` already declares a
third value, `'transport'` ("JSON-RPC / transport layer failure"), added in
v0.4.0 and never produced by any code path (confirmed by grep). The type
already reserved a slot for this; nothing ever filled it in.

### Semantic conventions checked

No MCP-specific spec attribute exists for protocol-vs-execution error origin.
The general RPC semconv's `rpc.jsonrpc.error_code` / `rpc.jsonrpc.error_message`
are **deprecated**, superseded by span-status description and
`rpc.response.status_code` (whose own spec example value is the string
`"-32602"`) — ADR 004 already flagged `rpc.response.status_code` as an
unemitted, relevant spec attribute for exactly this reason, before this gap
was raised. The `jsonrpc.*` namespace (already partly used — `jsonrpc.request.id`)
has no error-code member. There is nothing to align to beyond what ADR 004
already established: `error.type` + span status for the general shape,
`rpc.response.status_code` as the natural (if still unemitted) home for a raw
JSON-RPC numeric code.

## Decision

### Two channels, and why they need different treatment

1. **Tool-error channel** — JSON-RPC success, `CallToolResult.isError: true`.
   The agent's tool call reached the tool, the tool ran, and the tool itself
   reports failure. Already fully handled (ADR 004, ADR 006).
2. **Protocol channel** — a JSON-RPC `error` response. The call never
   produced a tool-level result at all; something failed at the RPC/dispatch
   layer before or instead of tool execution. Confirmed above to be *mostly*
   already visible for McpServer (via the `thrown` origin path, since McpServer
   only lets `UrlElicitationRequired` escape as a real protocol error) — the
   part that is NOT visible is failures that occur before
   `wrapToolCallHandler`'s wrapped function is even invoked (the
   `parseWithCompat` gap).

These need different treatment because they answer different operator
questions. "Is this tool broken" is a tool-error-channel question. "Is a
client sending malformed requests, or is the transport/dispatch layer
misbehaving" is a protocol-channel question — and conflating them means a
spike in malformed requests (a client bug) gets buried inside the same
`mcp.tool.errors` signal as a broken tool (a server bug), when the fix and
the owner are completely different.

### Where the new dimension lives: separate attribute, not the fingerprint hash

The request named this dimension "origin" with values `'protocol' |
'execution'`. That name collides with the *existing* `origin: FailureOrigin`
field (`'tool_error' | 'thrown' | 'transport'`), which has been part of the
hashed `FingerprintInputs` since v0.4.0 (`compose.js`'s
`HASH_INPUT_VERSION` string literally concatenates `origin` into the hash
input). Reusing the name "origin" for a different, coarser concept would be
confusing in the codebase and in any dashboard built on `mcp.failure.origin`.
This ADR proposes calling the new dimension **`channel`** (`mcp.failure.channel`,
values `'protocol' | 'execution'`) specifically to avoid that collision, and
argues its placement below.

**Argument for hashing it in (making it part of `FingerprintInputs`,
changing fingerprints):**
Two failures with an identical error class, category, and normalized message
could arise on different channels — e.g. a malformed request that happens to
normalize to the same shape as a legitimate isError result — and grouping
them under one fingerprint would mix a client-bug signal with an agent/tool
signal in the same dashboard row. Fingerprint identity is supposed to mean
"same underlying cause"; channel is arguably part of that identity, not an
afterthought.

**Argument against (keeping it as a separate, additive attribute):**
`compose.js`'s `HASH_INPUT_VERSION` versioning exists precisely so a hash
input change ships as `v2` without silently reinterpreting `v1` fingerprints
already recorded/alerted-on by consumers (ADR 006). Adding `channel` to the
hash is exactly that kind of change — it would flip fingerprints for every
tool-error-channel failure already in production dashboards, for a benefit
(avoiding cross-channel fingerprint collisions) that is narrow: collisions
require the error class, category, *and* normalized message to coincidentally
match across channels, which is rare in practice given how differently
protocol-layer messages (SDK/Zod-shaped) and tool-layer messages
(handler-shaped) read. Thrash detection's exclusion requirement (below) also
doesn't need `channel` in the hash — it needs a pre-record check, which is
cheaper and clearer as an explicit guard than as an emergent property of hash
collision avoidance.

**Decision: `mcp.failure.channel` ships as a separate, additive span
attribute, not part of `FingerprintInputs`.** No existing fingerprint
changes. If cross-channel collisions turn out to matter in practice, revisit
under a `v2` hash bump per the existing versioning mechanism — that's a
reversible follow-up; hashing it in today, then discovering it wasn't
needed, is not.

### -32602 disambiguation and its fragility

The four `-32602` sub-cases (tool not found, tool disabled, input validation,
output validation) have to be told apart by matching the SDK's literal
message text — there is no structured alternative today (`error.data` is
unused for this by the SDK). This is unavoidable with the current SDK
surface, but it must be built and documented as a **best-effort heuristic
scoped to the installed SDK version**, the same way `cost/extractor.js` and
the fingerprint classifiers already document themselves as best-effort — not
as a stable contract. A future SDK patch rewording these messages (or
localizing them) breaks the match silently, since these are prose literals,
not part of any documented stable API. Any implementation must fall back to
an explicit "unrecognized -32602 shape" bucket rather than mis-slotting an
unmatched message into one of the four known cases.

### Output validation is not thrash

An output-validation failure means the tool's own handler produced a result
that doesn't match the output schema the *server* declared for that tool. No
argument the agent supplies can fix this — the bug is entirely in the tool's
implementation. If an agent retries such a call, that is not evidence of
agent confusion or a bad prompt; it's the agent reasonably retrying a call
that could never have succeeded. Counting it toward `mcp.tool.loop.*` /
`ThrashDetector` inflates thrash metrics with a category of failure the
agent has zero ability to resolve by trying again differently, and points
whoever's triaging the alert at the wrong owner (the agent's prompting)
instead of the right one (the tool's own bug).

**Decision:** wherever the output-validation sub-case is identified (see
disambiguation above), it must be excluded from
`applyThrashDetection`/`ThrashDetector.record()` entirely — not merely
tagged. Thrash detection keys purely on fingerprint equality; there is no
"count it but flag it" middle ground that keeps `activeLoops` /
`totalLoopsDetected` meaningful, since those numbers exist specifically to
answer "how much has an agent wasted retrying." A retried, deterministic
server bug wastes tokens too, but attributing that waste to *thrash* rather
than to a distinct "server keeps failing this tool" signal is the same
category error the fingerprint miscategorization already commits today (see
Context). This should get its own signal in a later pass, not be silently
dropped — but it must stop being counted as thrash now.

## Constraints accepted

- **The `parseWithCompat` pre-handler gap is not closed by this ADR.**
  Closing it means wrapping a layer above `setRequestHandler`'s `handler`
  argument — the SDK's own request-schema-parse step, which happens inside
  `Protocol.setRequestHandler` itself. ADR 001 deliberately chose the
  innermost-layer wrapping strategy specifically to avoid depending on a
  larger, less stable surface. Fixing this gap means revisiting that
  decision, which is a bigger architectural call than a patch-level channel
  attribute and is out of scope here. It should be tracked as its own,
  separate ADR if ever prioritized — not bundled into this one by implying a
  fix this document doesn't actually deliver.
- Message-prefix/shape matching for `-32602` sub-cases is inherently
  version-coupled to the installed SDK. Any implementation needs a test that
  pins the SDK version it was verified against, the same discipline this
  codebase already applies to fingerprint classifiers.
- `mcp.failure.channel` is a new, non-spec attribute (like
  `mcp.tool.outcome` already is — see `attributes.js`) since no MCP-specific
  spec attribute exists for this. It should be documented the same way:
  explicitly marked NOT part of the MCP semantic conventions.

## Alternatives rejected

- **Reusing `origin` for the new protocol/execution split.** Rejected — see
  Decision above; collides with the existing hashed `FailureOrigin` field
  and would be actively confusing.
- **Hashing `channel` into `FingerprintInputs` immediately.** Rejected for
  now — breaking change to existing fingerprints for a narrow,
  not-yet-demonstrated collision risk; revisit under a `v2` hash bump if
  evidence emerges.
- **"Tag but still count" for output-validation thrash.** Rejected — thrash
  detection's counters exist to mean "wasted agent retries"; keeping a
  server-bug case inside them keeps the number wrong regardless of what
  attribute rides alongside it.
- **Reaching for `rpc.jsonrpc.error_code`.** Rejected — deprecated in the
  general RPC semconv package in favor of span status and
  `rpc.response.status_code`; adopting a deprecated attribute in a new 2026
  feature has no upside.

## Consequences

- v0.7.0 shipped exactly this scope: (1) a `mcp.failure.channel` span
  attribute (six values, additive, not hashed — the actual value set grew
  from the original `'protocol' | 'execution'` sketch to the full
  `protocol.*` sub-classification once implemented), (2) best-effort
  `-32602` sub-case disambiguation scoped to the installed SDK version,
  with an explicit unrecognized-shape fallback, (3) excluding the
  output-validation sub-case from thrash detection entirely, (4) the
  McpServer disguised-failure recovery mechanism added during
  verification (see addendum) so (1)-(3) actually apply to `McpServer`
  users, not just the low-level `Server`. None of this required an
  `index.d.ts` breaking change or a fingerprint hash version bump — both
  confirmed by test, not just asserted (`test/fingerprint/compose.fixtures.test.js`).
- The `parseWithCompat` pre-handler gap remains a known, documented blind
  spot: a malformed `tools/call` request produces zero telemetry (no span,
  no fingerprint). Stated plainly in the README's "Known limitations"
  section and tracked in `docs/known-gaps.md`, rather than left implicit.
  Closing it means a future ADR revisiting ADR 001's wrapping layer.
- The already-shipped miscategorization (output-validation errors landing
  in `validation` or `internal` category, and already counting as thrash)
  was called out as a bugfix in the v0.7.0 CHANGELOG entry, with its
  affected range stated explicitly (v0.4.0 for the miscategorization,
  v0.6.0 for the false-positive thrash count, through v0.6.1) — not
  folded silently into a "new feature" framing.
- `fingerprint/types.d.ts`'s unused `'transport'` `FailureOrigin` value is
  now doubly orphaned: this ADR's `channel` dimension does not reuse or
  retire it. Whether `'transport'` should eventually be wired up for the
  pre-handler gap (if ADR 001 is ever revisited) or removed as dead is left
  open, not decided here.

## Addendum (Phase 3 verification): McpServer reachability and the disguised-failure recovery

Post-implementation verification of Phase 3 surfaced a gap this ADR should
have caught in its original Context section: it documented that McpServer
converts nearly every protocol-shaped failure to `isError: true`, but never
drew the conclusion that follows from that fact for `classifyFailureChannel()`
itself.

**Reachability of each `channel` value, by server API:**

| Value | High-level `McpServer` (`.tool()`/`.registerTool()`) | Low-level `Server` (hand-rolled dispatcher) |
|---|---|---|
| `'execution'` | Reachable — and, before the fix below, the *only* value most failures could ever produce, since McpServer's own try/catch (`mcp.js`) converts tool-not-found, tool-disabled, input validation, output validation, and any other handler bug to `isError: true`. | Reachable when the host's own handler returns `{isError:true}` itself. |
| `'protocol.not_found'` | Unreachable via the raw thrown-error path (McpServer swallows it) — reachable only via the recovery mechanism below. | Reachable directly. |
| `'protocol.input'` | Same as above. | Reachable directly. |
| `'protocol.output'` | Same as above — this is the specific false positive Phase 3 was built to fix, and without the recovery mechanism, it remained fully present for McpServer users. | Reachable directly. |
| `'protocol.other'` | Reachable via the raw thrown-error path only for `UrlElicitationRequired` (code `-32042`) — the sole error McpServer re-throws instead of swallowing. Not a general catch-all in practice for McpServer. | Reachable for any other code, or an unrecognized `-32602` message. |
| `'unknown'` | Effectively unreachable via the raw thrown-error path — McpServer's catch swallows *any* error, McpError or not, into `isError: true`. | Reachable for a thrown value with no `.code`. |

Confirmed empirically, not just by reading the code: a real `McpServer` with a
real `registerTool()` call and a real Zod `outputSchema`, driven through an
output-validation failure 10 times, fired `mcp.tool.loop.detected` at the
default threshold — the exact false positive this ADR exists to close,
completely unaffected by the original Phase 3 implementation, because that
implementation only classified `channel` on the thrown/rejected branch of
`wrapToolCallHandler`, which McpServer's own failures never reach.

**The fix**: `classifyFailureChannel()` now also inspects an `isError: true`
result's `content[0].text` for the exact `MCP error {code}: ` wrapper
`McpError`'s constructor always applies (confirmed via direct inspection of
the constructor and empirical output — `new McpError(code, message).message
=== 'MCP error ${code}: ${message}'`). McpServer preserves this text
verbatim when it converts a thrown `McpError` to `isError: true`, so the
wrapper survives the conversion and can be parsed back out: if
`content[0].text` matches it, the recovered `code` and remaining message are
run through the same `classifyByCodeAndMessage()` logic the genuine
JSON-RPC-error path uses, producing the correct `protocol.*` value instead of
`'execution'`. If the text doesn't match that wrapper — i.e. it's a genuine,
tool-authored business-logic message, not a disguised protocol failure — the
result is `'execution'`, unchanged from before. This closes the reachability
gap in the table above: every `protocol.*` value (except the
`UrlElicitationRequired` sliver of `'protocol.other'`) is now reachable for
McpServer users too, via recovery rather than a raw throw.

This recovery step is coupled to McpServer's exact wrapping behavior
(`MCP error {code}: {message}`) in addition to the `-32602` sub-case message
prefixes already noted as fragile above — a future SDK version changing
*either* format silently reopens this gap. `test/integration/thrash-mcpserver-disguised-protocol.test.js`
pins this against the installed SDK version, same discipline as the
`-32602` sub-case tests.

**Defensive degradation, confirmed by test** (`test/fingerprint/classify.channel.test.js`'s
"disguised protocol failure recovery" block): if the wrapper format is
absent, reworded, differently punctuated, or missing its code digits — i.e.
the SDK changes or drops it — `recoverDisguisedProtocolFailure()` simply
fails to match and returns `null`, and `classifyFailureChannel()` falls back
to `'execution'`: the exact pre-recovery, pre-Phase-3 behavior, never a
thrown error and never a wrong specific `protocol.*` answer. The one
distinct case is `content` itself being unreadable (a throwing accessor),
which the classifier's outer `try/catch` still catches, resolving to
`'unknown'` rather than `'execution'` — also non-throwing, just a different
(and arguably more honest — the shape couldn't be confirmed at all) fallback
value.

**Assessed risk: collision with a genuine tool-authored message.** Could a
tool's own business-logic error text legitimately start with `"MCP error 4:
"`? Yes — plausibly, via a tool that proxies or forwards another MCP call's
error text verbatim (an orchestrator tool surfacing a downstream failure).
This is a real, if narrow, misclassification risk, not eliminated by this
recovery step, and is being accepted rather than engineered around further
in this pass:

- For any code other than `-32601`/`-32602`, the practical impact is
  cosmetic only: `resolveThreshold()` (src/thrash/detector.js) gives
  `'protocol.other'` the exact same threshold as `'execution'`, so a
  misclassified span attribute doesn't change thrash-detection behavior at
  all, only its label.
- A forwarded `-32601`-shaped message would flag as thrash after 1 call
  (`notFoundThreshold`) instead of 3 — more eager than correct, not less;
  arguably still a reasonable outcome for a call that keeps failing
  identically, just mislabeled.
- A forwarded `-32602` "Input validation error:"-shaped message would use
  the higher `inputThreshold` (5) instead of 3 — a real, if narrow, delay in
  detecting genuine agent thrash.
- The sharpest case: a forwarded `-32602` "Output validation error:"-shaped
  message is excluded from thrash detection ENTIRELY, even though it may be
  a genuine, repeatable failure from the forwarding tool's own perspective.
  This is a false negative, not a false positive, and is the one case where
  this risk could hide a real thrash pattern from an operator.

Accepted for this pass because: (1) it requires a fairly specific
coincidence — a tool's own text matching the literal, unusual phrase `"MCP
error"` followed by a colon-delimited integer, which is far more indicative
of forwarded McpError text than independently-authored business copy; (2)
it only manifests for proxy/orchestrator-style tools, a narrower population
than the confirmed, common bug this recovery step closes; (3) tightening the
match (e.g. requiring the recovered code to be exactly `-32601`/`-32602`
before trusting it, which is already what `classifyByCodeAndMessage()` does
for the *sub-classification* — only the bare `-32601` case and the
`-32602` marker-matched cases actually change behavior) doesn't eliminate
the sharp output-validation case, since that's precisely a `-32602` message
that also matches a real marker. Revisit if this pattern (proxying/
forwarding downstream MCP errors verbatim into a tool's own result text)
turns out to be common enough in practice to justify a more conservative
recovery rule, or a way for a tool author to opt out of recovery for a
specific result.

## Acknowledgments

This ADR exists because of external review (Reddit) on the original
isError-only failure detection — the two claims that opened the Context
section above. Verifying those claims against the installed SDK, not
assuming them, is what surfaced the confirmed output-validation false
positive this work fixes.

Additional external review during this same release cycle raised gaps
this ADR's scope doesn't close, now tracked in
`docs/known-gaps.md` rather than silently dropped: field-level convergence
tracking for `protocol.input` (u/Pleasant-Ad192) and an
observation-liveness contract for `getThrashSummary()` (Massimiliano
Brighindi) — both targeted at v0.8.0 — and how client-side agent retry
caps interact with these thresholds (u/Context-Stream-AI).
