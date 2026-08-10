# ADR 009: Field-level convergence tracking

**Status:** Accepted, partially implemented. Answers the
`docs/known-gaps.md` "Field-level convergence tracking" entry raised by
external review (u/Pleasant-Ad192). The Recommendation below shipped in
two parts: the regression tests pinning down the already-working
fingerprint behavior (item 1 below), and the `mcp.failure.validation_paths`
diagnostic attribute (item 2). Item 3 — the partial-convergence fix — was
**not** implemented: this document names the *direction* (compare
extracted path sets across attempts) but never settled on an algorithm
(what `ThrashDetector` groups by, what state transition a shrinking or
changing set triggers, what "reinforces the count" means mechanically),
and implementing it would have meant inventing that design rather than
following one this ADR actually decided. Tracked as its own entry in
`docs/known-gaps.md`, pending that decision. Item 4 (no low-level
`Server` support beyond best-effort) is inherent to how items 1-2 were
built, not a separate follow-up.

## Context

The claim under investigation: a `protocol.input` failure (ADR 007)
repeating on the *same* schema property usually means an ambiguous tool
description or schema — fixable server-side, not by the agent — while a
*different* property failing each attempt means the agent is converging
on a correct call. A count-based detector, keying only on "how many
consecutive failures," can't tell these apart. Can opentel-mcp determine
*which* property failed, not just that validation failed?

## Findings

### 1. What the SDK actually puts in the message

`server/zod-compat.js`'s `getParseErrorMessage(error)` (lines 127-148)
checks `error.message` first, before `.issues`. For a real `ZodError`
this is not a short summary: Zod's own `get message()` (confirmed in the
installed package, `node_modules/zod/v3/ZodError.js:105-107`) is
`JSON.stringify(this.issues, ..., 2)` — the full, pretty-printed array of
**every** failing issue, each carrying its own `path`. `mcp.js`'s
`validateToolInput` (lines 166-181) interpolates this directly into the
thrown `McpError`'s message: `` `Input validation error: Invalid
arguments for tool ${toolName}: ${errorMessage}` ``.

Confirmed empirically, not just by reading source — built a real
`McpServer` with `registerTool()` and a two-field Zod schema
(`{ email: z.string().email(), age: z.number() }`), sent both fields
wrong, and printed the actual result text for both Zod v4 (the
package's default) and `zod/v3` (imported explicitly, since the SDK
supports both via `zod-compat.js`). Both render every issue's `path` as
literal `"path": ["email"]` / `"path": ["age"]` JSON inside the message
string — not a flattened English sentence, not first-issue-only.

### 2. Structured error reachability

**Only the rendered string reaches this library, in the common case.**
`validateToolInput` calls `getParseErrorMessage(error)` and only ever
constructs an `McpError` from the resulting *string* — the live
`ZodError` (with a real `.issues` array) never escapes that function.
By the time `wrapToolCallHandler` sees anything, it is always text. A
low-level `Server` author *could* throw the raw `ZodError` directly,
bypassing the SDK's own wrapping, making the structured object
reachable — but that depends entirely on their own code, not on
anything this library or the SDK guarantees.

### 3. The make-or-break question: does McpServer's `isError: true` conversion lose the path?

**No — confirmed empirically.** Ran the real `McpServer` example above
through `mcpServer.server._requestHandlers.get('tools/call')` and
printed `result.content[0].text`: the full `"path": [...]` JSON is
present, character for character. `createToolError()` (ADR 007's Phase
3 verification already established this) wraps `error.message` — which
already contains the JSON — verbatim into `content[0].text`. **This is
reachable for McpServer users, not only low-level Server users**, and
by the same mechanism ADR 007's disguised-protocol-failure recovery
already relies on.

### An unplanned but decisive finding: the fingerprint already mostly does this, by accident

Before designing anything new, this investigation checked whether
`computeFingerprint()` already behaves differently for "same field
repeatedly" vs. "different field each time," since property names
survive `normalizeMessage()`'s stripping patterns untouched (none of the
UUID/email/timestamp/hex/opaque-ID patterns in
`fingerprint/normalize/patterns.js` match a short field name like
`"email"` or `"age"`).

Verified with the real `computeFingerprint()`, not assumed:

- **Same field, same issue shape, across attempts → identical
  fingerprint.** Confirmed for type mismatches, enum mismatches, literal
  mismatches, and custom `.refine()` failures — none of Zod's default
  issue messages echo the specific bad *value*, only the rule that was
  violated, so the rendered text (and therefore the fingerprint) is
  stable across attempts even when the agent tries different wrong
  values for the same field.
- **A different field failing on the next attempt → a different
  fingerprint.** The issues array's content differs, so the normalized
  message differs, so the hash differs.

**This means the core distinction this ADR was asked to investigate is
already mostly captured today, as a side effect of hashing the whole
rendered message — not by deliberate design.** `ThrashDetector` already
accumulates count correctly for "same field, ambiguous schema" (same
fingerprint, ordinary `protocol.input` thrash counting applies) and
already fails to accumulate for "different field each attempt, agent
converging" (fresh fingerprint each time, never crosses `inputThreshold`
via that path). The problem is real, but narrower and more subtle than
"currently indistinguishable" — it's more precisely: **currently
distinguished by accident, not by design, and with real gaps.**

The gaps that remain:

- **Partial convergence breaks continuity.** If attempt 1 fails on two
  fields and attempt 2 fails on only one (the agent fixed the other),
  the issues array's *length* changes, so the whole blob — and the
  fingerprint — changes too, even though the *same* first field is still
  failing. The current accidental mechanism cannot see that continuity;
  it just looks like a fresh, unrelated failure.
- **No queryable signal for operators.** Even where the fingerprint
  *does* correctly distinguish same-field from different-field, nothing
  is exposed that says so directly — an operator would have to notice
  that several spans carry different `mcp.failure.fingerprint` values
  and manually infer why, with no attribute to group or filter on.
- **Not a guaranteed contract.** The accidental behavior depends
  entirely on Zod's current message-rendering choices (JSON with `path`,
  no value-echoing in default messages). Nothing obligates that to stay
  true — a future Zod version, or a tool author who hand-writes their
  own generic "invalid arguments" error with no path info at all, would
  silently collapse this back to the original problem with no warning.
- **Reliability differs sharply by server API.** For `McpServer`, path
  extraction is the *expected* case, since `registerTool()`'s
  `inputSchema` is itself a Zod raw shape — the SDK's own validation
  path is exercised on every call. For a low-level `Server`, there is no
  such convention at all; extraction success depends entirely on
  whether that author's own code happens to produce a similarly-shaped
  message, which nothing guarantees.

### 4. Where would extraction belong, and the cardinality risk

**Not in the fingerprint hash.** The path is already implicitly part of
the hash input (via the normalized message) — adding it again would be
redundant for grouping purposes. What's actually missing is a queryable,
explicit signal, which argues for a **separate span attribute**
(something like `mcp.failure.validation_paths`, a list, since a single
failure can name more than one bad field), populated by parsing the
rendered message — not by being handed a structured error object, since
Q2 established that object is essentially never reachable. Parsing here
means locating and `JSON.parse()`-ing the embedded array (more robust
than bare substring/prefix matching, since a successful `JSON.parse()`
is self-validating — it either cleanly yields real path arrays or
cleanly fails, never a wrong confident answer) rather than a
`getParseErrorMessage`-style prefix match. This inherits the same
SDK-version coupling ADR 007 already flagged for `-32602` sub-case
matching, compounded here by also depending on Zod's specific
`ZodError.message` JSON-rendering behavior specifically (two independent
things that would each have to keep holding).

**Cardinality: span-only, never a metric label — matching existing
precedent.** Field names are bounded *per tool* (a schema has a small,
fixed set of top-level fields) but unbounded *across tools*, and
unbounded again across the many independent deployments a shared metrics
backend might aggregate — the same reasoning `METRIC_SAFE_ATTRIBUTES`
(`fingerprint/attributes.js`) already applies to keep
`mcp.failure.fingerprint`/`signature`/`error_class` off metric labels.
Extracted field paths should join that same excluded set, not
`METRIC_SAFE_ATTRIBUTES`.

## Recommendation

**Build it, but scoped narrowly as a diagnostic attribute plus an
explicit hardening of the existing accidental behavior — not a new
"convergence detector" state machine.** Given how much of the value is
already realized by accident today, a whole new detection mechanism
would mostly duplicate what fingerprint identity already does, at the
cost of the SDK-coupling fragility described above. The concrete,
justified scope:

1. A best-effort `extractValidationPaths(failure)` function (mirroring
   `classifyFailureChannel()`'s structure and never-throw discipline),
   producing a `readonly string[][]` (one path array per failing issue,
   `[]` when nothing could be confidently extracted — never guessed) by
   locating and `JSON.parse()`-ing the embedded issues array out of the
   rendered message. Reachable via the same recovery path
   `classifyFailureChannel()` already uses for McpServer's disguised
   `isError: true` results, so this benefits McpServer users the same
   way that fix did.
2. Surfaced as `mcp.failure.validation_paths`, span-only, additive, not
   hashed — same category as `mcp.failure.channel`.
3. **Fix the partial-convergence gap explicitly** rather than leaving it
   to accident: when thrash detection sees consecutive `protocol.input`
   failures on the same tool, compare extracted path *sets* (not just
   fingerprint equality) — a shrinking or changing set is a stronger,
   intentional "agent is converging" signal than incidental fingerprint
   inequality, and a stable, unchanging set reinforces the thrash count
   with actual evidence instead of just accumulated occurrences.
4. Do **not** attempt this for low-level `Server` users beyond
   best-effort — there is no convention to lean on there, and the
   feature should degrade to "nothing extracted" silently rather than
   claim reliability it doesn't have.

This recommendation is conditional on accepting the fragility already
named: it is coupled to Zod's current message format on top of the
`-32602` sub-case coupling ADR 007 already accepted, and should be
tested against the exact installed SDK/Zod versions the same way ADR
007's `-32602` disambiguation already is.

## Alternatives rejected

- **A dedicated field-convergence state machine independent of
  fingerprinting.** Rejected — would re-derive, with more code and more
  SDK coupling, distinctions the existing fingerprint hash already
  mostly captures as a side effect; the actual gap is narrower
  (partial-convergence continuity, and the lack of a queryable signal),
  not the broad "currently indistinguishable" framing the original
  report assumed.
- **Hashing extracted paths into `FingerprintInputs`.** Rejected —
  redundant; the path text is already implicit in the hashed normalized
  message, and ADR 007 already established the precedent of keeping new
  dimensions out of the hash to avoid breaking existing consumers'
  fingerprint-keyed alerts.
- **Requiring the structured `ZodError` object.** Rejected as the
  primary mechanism — Q2 established it's essentially never reachable
  for McpServer users, which are most users; a design that depended on
  it would be unreachable for the common case, the same mistake Phase 0
  of ADR 007 almost made before the McpServer reachability finding.

## Addendum: SDK 1.30.0 broke the JSON-array assumption this ADR was built on

An `npm audit fix` bumped `@modelcontextprotocol/sdk` from 1.29.0 to 1.30.0
(a minor version, within `packages/ui/package.json`'s existing `^1.29.0`
range — no `package.json` edit required to pull it in). All four tests
covering `extractValidationPaths()` started failing: `[]` where a real
McpServer + real Zod validation failure previously produced populated
paths. Zod itself was unchanged (`4.4.3` before and after) — this is
entirely an SDK-side change.

**What changed.** Confirmed by pulling the 1.29.0 tarball from npm and
diffing `server/zod-compat.js` against the installed 1.30.0 copy:
`getParseErrorMessage()` used to check `error.message` first — which for a
real `ZodError` is `JSON.stringify(this.issues, null, 2)`, the full JSON
array this ADR's Q1 documented and `extractValidationPaths()` was built to
parse. As of 1.30.0, it checks `'issues' in error` *first* and builds its
own human-readable string instead: `` `${issue.message} at ${dotPath}` ``,
one per issue, joined by `\n` (nested paths dotted, array indices
bracketed, root-level issues dropping the `" at "` suffix entirely).
`error.message` is no longer consulted at all when `.issues` is present.
This reads as a deliberate SDK improvement for human readability (a new
`getDotPath()` helper was added specifically to produce it), not a
regression — but it silently invalidates the JSON-array assumption Q1 and
Q4 of this ADR were built on, for every McpServer user on 1.30.0+.

**The `"MCP error {code}: "` wrapper and the `"Input validation error:"` /
`"Output validation error:"` prefixes this ADR's Q3 and ADR 007's channel
classification depend on are unchanged** — confirmed against a real
McpServer, both before and after this addendum's fix. Only the innermost
ZodError-derived tail changed shape. `classifyFailureChannel()`
(`fingerprint/classify/channel.js`) never inspects that tail at all, so
ADR 007's channel dimension was, and remains, unaffected by this SDK
change — checked directly rather than assumed, given a silent
misclassification wouldn't fail a test the same visible way a missing
array does.

**The path data was never gone, only reshaped.** `extractValidationPaths()`
now tries the JSON-array parse first (unchanged, for SDK <=1.29.0 and any
low-level `Server` author who throws a raw, unrendered `ZodError`), and
falls back to parsing the rendered `"<message> at <path>"` format — gated
on the same `Input validation error:` / `Output validation error:` marker
`classify/channel.js` already trusts, since unlike the JSON array this
format is not self-validating (an arbitrary business-logic sentence ending
in "at <word>" would otherwise look plausible). Array-index segments
(`items[3]`) are normalized to dots (`items.3`) to match the JSON path's
existing `path.join('.')` convention, so the two extraction paths agree on
canonical form for the same logical field rather than producing two
different-looking strings for the same thing depending on which SDK
version or server API produced the failure.

**Fragility, restated more sharply than the original Recommendation:**
this feature is now coupled to *two* independent SDK message-rendering
choices instead of one, on top of the `-32602` sub-case coupling ADR 007
already accepted. A third rendering in some future SDK version breaks this
again, exactly how 1.30.0 broke the JSON-only version — and the failure
mode stays silent: `extractValidationPaths()` returns `[]`, no exception,
no warning, nothing in CI unless a test happens to exercise the exact
shape that changed. `test/fingerprint/classify.validation-paths.test.js`
now pins the exact installed SDK version (`1.30.0`) this file's two
formats were verified against — an exact-equality check, not a range
check, specifically because 1.29.0 -> 1.30.0 was itself a minor bump that
broke this silently with no deprecation notice. A version bump failing
that pin test is the intended signal to re-run this ADR's empirical
checks against the new version before moving it, not a nuisance to
suppress.
