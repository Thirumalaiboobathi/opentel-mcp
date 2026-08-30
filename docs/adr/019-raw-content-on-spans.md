# ADR 019: Raw content on spans — framing, and designs for the two open channels

**Status:** Proposed — design only, no implementation.

**Found by:** direct follow-on from `docs/known-gaps.md` entry 10 (a
raw-content audit of every attribute/event this package emits). That
entry's own two low-risk items — `mcp.failure.validation_paths` format 1
and `mcp.failure.error_class` — were already fixed directly (redaction
gate; 128-char cap) without needing a design decision first, because
neither involved a real tradeoff: a redacted placeholder or a length cap
costs legitimate use nothing. The two items left open — `recordException`/
`setStatus({ message })` and `mcp.tool.model`/`gen_ai.response.model` — do
involve a real tradeoff each, which is exactly why entry 10 declined to
patch them and pointed here instead. This ADR is that decision.

## Context

Quoting entry 10's own closing paragraph, the reason a patch was refused:

> Scrubbing or gating `recordException`/`setStatus` would diverge from the
> exception-recording behavior every other OTel-instrumented library in a
> user's stack already produces for the exact same kind of error...
> Capping or allowlisting `mcp.tool.model` changes what
> `applyCostAttribution()` accepts as a valid model identifier, which has
> direct, non-cosmetic consequences for cost/budget attribution... Both
> need their own scoped decision.

Two genuinely different problems, addressed as two separate parts below,
after first settling the question that determines how to weigh both:
whose problem is this, actually.

## Part 0: Whose problem is this?

The framing question, because it decides everything downstream. If the
answer is "the tool's bug, we just report faithfully," the remedy is
documentation — tell operators what they're exposed to and let them
choose. If the answer is "our problem, because we're the wire," the
remedy leans toward scrubbing by default. Argued both ways below, then
checked against what OpenTelemetry's own semantic conventions already say
— per this investigation's instruction, that existing guidance is followed
rather than an independent position being invented.

### Position A: it's the tool's bug

An instrumentation library's whole job is to faithfully record what the
instrumented code produced. If a tool's handler throws `new Error('user '
+ email + ' not found')`, the defect is in the tool — it put PII in a
message that was always going to end up somewhere (application logs, an
APM, a support ticket) even before this library existed. Every other
instrumentation in the same process — an HTTP client, a DB driver, a
queue consumer — records `err.message`/`err.stack` verbatim via the exact
same `recordException()` call. If this library alone scrubs, its spans
behave differently from every other span in the same trace for the exact
same class of event, which is its own kind of confusing: an operator
correlating a `mcp.tool.call` span with an adjacent `pg.query` span in the
same trace would see one exception scrubbed and the other raw, with no
signal explaining why. Silently rewriting content also has a real cost of
its own — a scrubbed `<EMAIL> not found` is measurably less useful to
whoever is debugging the actual incident than `jane@example.com not
found`, and this library has no way to know whether a given deployment
values that debugging fidelity more or less than the exposure.

### Position B: it's this library's problem, because it's the wire

The counter-argument is not about fault, it's about *leverage* and
*trust boundary*. The tool author who wrote that error message was almost
certainly not reasoning about OpenTelemetry export at all — MCP tools are
frequently third-party servers the operator running `instrumentMcpServer()`
did not write and has not audited line-by-line for what its error paths
put in message text. A first-party microservice's own team choosing to
`recordException()` their own code's errors is a single party making an
informed tradeoff about its own content. `instrumentMcpServer()` sits
between two parties who did not coordinate on this: a tool author who
never considered that their thrown text would be serialized to a
third-party tracing backend the *operator* chose (self-hosted, SaaS,
whatever retention/access policy that backend has), and an operator who
adopted this library for tool-call observability, not to newly pipe every
tool's internal error text to an external system. Nobody in that chain
made a deliberate choice that raw tool-error content should leave the
process boundary — this library is simply the only party mechanically
positioned to intervene before it does.

### What OpenTelemetry's own semantic conventions say

Checked directly against the spec
([`exceptions-spans.md`](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/),
[source](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/exceptions/exceptions-spans.md)),
not inferred:

- `exception.message` — Stable, `Conditionally Required` (required if
  `exception.type` is absent, Recommended otherwise) — carries exactly
  one line of guidance on sensitivity, verbatim: **"This attribute may
  contain sensitive information."** No mandate to redact, filter, or gate
  it. No opt-in requirement attached to that warning.
- `exception.stacktrace` — Stable, `Recommended` — carries **no
  sensitivity footnote at all** in the attribute registry, unlike
  `exception.message`. The spec authors evidently didn't consider stack
  traces the same category of risk as message text — a distinction this
  ADR's Part 1 (stack trace treatment, below) independently arrives at
  from this codebase's own existing stack-normalization design, before
  even finding this asymmetry in the spec.
- The spec's only configuration knob in this area,
  `OTEL_SEMCONV_EXCEPTION_SIGNAL_OPT_IN`, controls whether exceptions are
  emitted as span events, log records, or both — a signal-*shape*
  migration mechanism (part of the broader Events-as-Logs effort), not a
  content-redaction one. It says nothing about *what* goes in
  `exception.message` once the event fires, and confirms the spec expects
  exception content to be emitted **by default** — the migration knob is
  about where it goes, not whether sensitive content is filtered on the
  way out.

Read plainly: upstream OpenTelemetry has already answered "whose problem
is this" for the ecosystem at large, and the answer is **recording is the
default, sensitivity is disclosed via documentation, and redaction is
delegated to a layer downstream of the instrumentation** — a Collector
`redaction`/`attributes`/`transform` processor, or the application not
throwing sensitive content to begin with. Position A's ecosystem-
consistency argument is the position the spec itself takes.

### Decision

**Both positions are right about different things, and the resolution
follows from separating them rather than picking one.** Position A is
right about *default behavior*: this library should not unilaterally
diverge from what every other OTel-instrumented library in the same
trace does for the same kind of event, and the spec's own stance confirms
that's not just convention but the documented expectation. Position B is
right about *why this library specifically should still offer a control
most peer instrumentations don't bother providing*: the third-party,
often-unaudited-by-the-operator trust boundary `instrumentMcpServer()`
sits on is real and is not the trust boundary the spec's general guidance
was written against (first-party application code choosing its own
`recordException()` behavior). "Record it, but make redaction a first-
class, well-documented, easy-to-reach option" — not "delegate entirely to
a Collector processor most self-hosted or small deployments won't have
configured" — is the synthesis: match the ecosystem default, exceed the
ecosystem's typical level of operator control. This is the framing Part 1
is designed against.

## Part 1: `recordException` / `setStatus({ message })`

### Current behavior

Both thrown-exception paths, unconditionally, regardless of
`fingerprinting`:

```js
// src/instrument.js:1458-1459 (tools/call) and :1583-1584 (tools/list)
span.recordException(err);
span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
```

`recordException()` adds an `exception` span event with `exception.type`
(`err.name`), `exception.message` (`err.message`), and
`exception.stacktrace` (`err.stack`) — all verbatim, no length cap.
`setStatus`'s `message` duplicates `err.message` a second time as the
span status description. Neither call is gated on
`fingerprintingEnabled`; both run even when fingerprinting — and its
`normalizeMessage()` scrubbing — is fully disabled. `error.type`
(`instrument.js:1460-1461`, `errorType = err?.name ?? 'Error'`) is a
third, independent read of `err.name`, uncapped — ADR 004's update note
(added alongside the entry-10 fix) already flags this as deliberately
left open.

### The tension

`recordException()` is not this library's own mechanism — it's the OTel
JS SDK's own `Span` method, with a spec-defined event shape every
backend/dashboard that renders exceptions (Tempo, Honeycomb, Datadog, the
`opentel-mcp-ui` package in this repo) already knows how to display.
Changing what lands in `exception.message` changes what every one of
those renders, silently, for anyone who upgrades this library without
reading a changelog closely — "my traces used to show the real error and
now they show `<EMAIL>`" is a support complaint nobody will think to
attribute to opentel-mcp specifically, because `recordException()` isn't
supposed to be a place a wrapping library gets to edit content. This is
exactly the asymmetry Part 0 identified: the fix has to be something an
operator *opts into*, not something that changes by default underneath
existing deployments.

### Design: `errorRecording.mode` — `'full'` | `'normalized'` | `'none'`

A new top-level `InstrumentOptions` field, sibling to `fingerprinting` /
`costTracking` / `thrashDetection` / `schemaDrift`
(`src/config.js`):

```js
/**
 * @typedef {object} ErrorRecordingOptions
 * @property {'full' | 'normalized' | 'none'} [mode='full']
 */
```

Resolved via a `resolveErrorRecordingConfig()` helper matching the
existing `resolveThrashConfig()`/`resolveSchemaDriftConfig()` shape
(individual-field-defaults-on-partial-object), threaded into
`wrapToolCallHandler`/`wrapToolsListHandler` alongside `costTracking`
today, and read at both of the two call sites above.

**`'full'` (current behavior, unchanged byte-for-byte).**
`span.recordException(err); span.setStatus({ code: ERROR, message:
err?.message })`, exactly as today. No new code path taken.

**`'none'`.** Skip `recordException()` entirely; call
`span.setStatus({ code: SpanStatusCode.ERROR })` with no `message` —
*not a new pattern*, this is the exact call already used for the
tool-level `isError: true` branch (`instrument.js:1387`) today. Debugging
still has something: `error.type` (capped, see below),
`mcp.failure.category`/`mcp.failure.fingerprint`/`mcp.failure.signature`
(when fingerprinting is on — already hashed/normalized), and
`mcp.failure.channel`. What's lost is the free-text detail; what's kept
is everything this library already treats as safe to emit unconditionally.

**`'normalized'` — reuses `normalizeMessage()`, does not reinvent it.**
`exception.message` and the status `message` are set to
`normalizeMessage(err.message)` (`src/fingerprint/normalize/message.js`,
already exported) instead of `err.message` directly — the exact same
UUID/email/URL/IP/timestamp/path/hex/quoted-id scrubbing that already
runs before hashing into `mcp.failure.fingerprint`, including its
existing 2048-char pre-scrub truncation, for free. No new scrubbing logic
to design, review, or keep in sync with a second copy — one pipeline,
two call sites (fingerprinting's hash input, and now this).

Because `err` is rethrown after this in both call sites (the caller's own
try/catch or the MCP transport needs the *original*, unmodified error),
`'normalized'` mode must **not** mutate `err.message`/`err.stack` in
place. The exception event is constructed via `span.addEvent('exception',
{...})` directly with the same three keys `recordException()` itself
would set (`exception.type`, `exception.message`,
`exception.stacktrace`) — so a consumer reading the span data cannot
structurally tell which mode produced it, only the content differs. This
also means fingerprinting's own `computeFingerprint()` call, a few lines
later in both handlers, is untouched: it already runs `normalizeMessage()`
against `err.message` independently, on the real unmutated object.

### Does the stack trace need separate treatment? Yes — reuse `parseAndNormalizeStack()`, not `normalizeMessage()`

Running `exception.stacktrace` through `normalizeMessage()`'s
`NORMALIZE_STEPS` would be actively counterproductive, not just
unnecessary. That pipeline's `PATH` pattern
(`/(?:[\w.-]+\/)+[\w.-]*|.../`, `normalize/patterns.js`) replaces *every*
filesystem path with the literal placeholder `<PATH>` — applied to a
multi-frame stack trace, every single line's file reference collapses to
`at <PATH>:12:34`, which is worthless for exactly the purpose a stack
trace exists to serve (which function, which file, which line broke).

The premise stated in this investigation's own framing is right: a stack
trace's file paths are **code locations**, not free-text user data — a V8
`Error.stack` structurally cannot embed a runtime *value* (an email, an
id, a credential) the way a message string can; it only ever contains
function names and file:line locations. This codebase already has a
purpose-built normalizer for exactly this distinction:
`parseAndNormalizeStack()` (`src/fingerprint/normalize/stack.js`,
already exported), which strips the `cwd` prefix
(`normalizeCwdPath()`) and collapses `node_modules` package versions
(`normalizeNodeModulesPath()`) while **keeping the path meaningful** —
because it's source-tree identity, not sensitive content, and the
fingerprinting pipeline has trusted that distinction since v0.4.0.

One real, narrow leak this reasoning does surface: `recordException(err)`
today uses the **raw** `err.stack` string directly — it never goes
through `parseAndNormalizeStack()`'s `cwd`-stripping at all, unlike the
fingerprint pipeline's own stack handling. On a local/dev deployment, an
absolute path's leading segment can be a real OS username or a
developer's home directory (`/Users/jane.doe/project/...`,
`/home/jsmith/...`) — a minor but real identity leak distinct from
message-text PII, and specific to the stack channel. `'normalized'`
mode's stack handling should therefore be: run `err.stack` through
`parseAndNormalizeStack()`, then reconstruct a full (not the 60-char-
capped, top-N-only `signature`) multi-line stack string from the returned
`frames` — `${fn}@${file}:${line}` per frame, joined by newlines — so the
cwd-stripping and node_modules-version-collapsing both apply, and the
result stays useful for debugging (still names every function/file/line)
while dropping the one piece of environment-identifying information
(`cwd`) that a stack trace's *path prefix*, specifically, can carry and a
fingerprint's own hashed signature never surfaces raw either.

### `error.type` — closing ADR 004's open note as part of this design

`instrument.js:1460`'s `errorType = err?.name ?? 'Error'` is a third,
independent read of the same `err.name` value `mcp.failure.error_class`
already caps at 128 characters (`fingerprint/compose.js`'s
`MAX_ERROR_CLASS_LENGTH`, added alongside this entry's other fix). ADR
004's update note left this open specifically as "a separate, unscoped
change." This ADR is that scope: cap `error.type`/`exception.type` at the
same 128 characters, **unconditionally, regardless of
`errorRecording.mode`** — unlike message/stack content, a length cap on a
class-identifier field costs a well-behaved tool nothing (the same
asymmetry Part 2 makes explicitly for `mcp.tool.model`, below), so there
is no default-behavior tension here to gate behind a config value the way
message/stack content genuinely has. Both `error.type` (`instrument.js`)
and `exception.type` (inside the `recordException`/`addEvent` payload)
should read from one shared, capped value.

### Argue the default

Two real options — default to `'full'` (today's behavior, unchanged) or
default to `'normalized'` (the safer choice, but a behavior change on the
single most-exercised failure path in the library).

**Default stays `'full'` at `0.x`.** Three independent reasons converge
on the same answer:

1. **Part 0's decision, applied literally.** The synthesis above was
   "match the ecosystem default, exceed the ecosystem's typical level of
   control" — not "override the ecosystem default." Defaulting to
   `'normalized'` would make this library's exception spans behave
   differently from every other span in the same trace *by default*,
   exactly the inconsistency Position A warned about, for every existing
   deployment, without anyone opting in.
2. **This project's own established discipline for exactly this kind of
   change.** ADR 004 tracks "breaking attribute renames... in release
   notes rather than silently shipped"; ADR 018 deliberately shipped as
   design-only rather than folding into an already-fixed release scope;
   entry 10 itself declined to patch this exact pair of items without a
   decision first. A silent default flip on the single highest-traffic
   failure path in the library is a bigger behavior change than any of
   the precedents above, not a smaller one.
3. **Nothing about the exposure is new in this release** — `recordException`/
   `setStatus` have carried raw `err.message`/`err.stack` since the
   earliest instrumentation (entry 10's own finding). Shipping the config
   surface *at all* is the improvement being made now; shipping it
   pre-enabled is a second, independent decision this ADR is not
   forcing through on the back of the first.

**The default should flip to `'normalized'` at the next major version
(1.0), not before.** A major version is precisely the point this project
already treats as license to change a default with a clear, loud signal
(changelog, migration notes) rather than a minor-version surprise — the
same reasoning ADR 004 states for future semconv-driven renames. Recorded
here as the intended direction, not decided in this ADR: whoever ships
1.0 should treat "does `errorRecording.mode` still default to `'full'`"
as an explicit line item to revisit, not something this ADR pre-commits
past the point where the tradeoff can be re-examined against whatever the
ecosystem looks like by then.

## Part 2: `mcp.tool.model` / `gen_ai.response.model`

### Current behavior

`readModel()` (`src/cost/extractor.js:83-97`) reads `result.model`,
`result.usage.model`, or `result._meta.model` — including from JSON
parsed out of `result.content[0].text` — gated by nothing beyond `typeof
candidate === 'string' && candidate.trim() !== ''`. `applyCostAttribution()`
(`src/instrument.js:816-819`) sets both attributes from that value
unmodified whenever it's present:

```js
if (usage.model) {
  span.setAttribute(ATTR_MCP_TOOL_MODEL, usage.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, usage.model);
}
```

### What real model identifiers actually look like — verified, not assumed

This investigation's own instruction was to check the pricing table's
actual keys before assuming a character set, rather than guessing from
general knowledge of provider naming. Done directly against
`src/cost/pricing.js`'s `DEFAULT_PRICING`: **every one of its ~20 keys**
(`claude-sonnet-5`, `gpt-4o`, `o3-mini`, `text-embedding-3-large`,
`amazon-nova-pro`, `deepseek-r1`, ...) **uses only lowercase letters,
digits, and `-`.** No dot, no colon, no slash, no underscore appears
anywhere in the table.

Read naively, that would suggest a narrow `[a-z0-9-]` allowlist. **That
conclusion is wrong**, caught by checking one more thing this same
investigation flagged: `normalizeModelName()` (`src/cost/calculator.js:15-19`),
the function that looks a detected model up against this very table,
documents and tests (`test/cost/calculator.test.js`'s "does not strip a
second slash beyond the first prefix") a **required** input shape none of
`DEFAULT_PRICING`'s own keys contain — a `provider/model` prefix (its own
docblock's example: `"Anthropic/Claude-Opus-4-7"` →
`"claude-opus-4-7"`), stripped before lookup. The pricing table's keys
are the **post-strip** form; `usage.model` — the actual field this gate
would validate — is documented and tested to legitimately arrive in the
**pre-strip** form, containing a `/` the table itself never shows. Judging
the input character set purely from the table's own keys would have
rejected input this library already advertises support for.

That single check is enough to establish the real requirement is broader
than the table alone suggests, and general knowledge of the wider
provider landscape — not independently verified live against provider
docs in this investigation, flagged honestly as such — points the same
direction: AWS Bedrock model identifiers conventionally look like
`anthropic.claude-3-sonnet-20240229-v1:0` (dot separating vendor from
model, colon separating version) or, as a full ARN, embed both `:` and
`/` (`arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-...`);
some providers version-suffix with `@` (e.g. Vertex AI's `text-bison@001`
convention). None of these need to *resolve* to a `DEFAULT_PRICING`
entry to be a legitimate value worth naming on the span —
`mcp.tool.pricing_status: "unknown"` already exists precisely to
represent "we saw a real model name, we just don't have a price for it"
(ADR 016 point 4) — so the character allowlist's job is to admit
real-world model-identifier shapes, not just the narrower set this
table's own entries happen to use.

**Proposed allowlist:** `/^[A-Za-z0-9._:/@-]{1,256}$/` — alphanumerics
plus `.`, `_`, `:`, `/`, `@`, `-`. Generous by design: the failure mode
this section's own instruction warns against (silently dropping a
legitimate model and reporting nothing) is far more costly than the
failure mode of admitting a few characters no currently-known provider
convention actually uses. **256 characters**, not `error_class`'s 128 —
chosen to comfortably fit a full Bedrock ARN (~85 chars for the example
above) with headroom, while still bounding worst-case length by two full
orders of magnitude against an arbitrary injected blob.

### CRITICAL: rejection must not be a silent drop

The instruction driving this section is explicit, and it's the single
most important constraint in this part of the design: a rejected value
must not just vanish. Silently omitting `mcp.tool.model` for a rejected
string reintroduces exactly the "confidently wrong zero" disease
`docs/known-gaps.md` entry 9 already diagnosed and fixed for a different
gap in the same subsystem — a call whose usage extraction genuinely
succeeded quietly contributing nothing, with no signal anywhere that
anything was withheld.

The design that avoids this needs almost no new state, because the
**existing unknown-model machinery already does exactly the right thing**
for "no usable model" — it was built for "no model detected at all," but
"a model-shaped field existed and was rejected" is the same downstream
case in every way that matters. Concretely: gate entry into today's
`if (usage.model)` block (`instrument.js:816`) with the new validity
check —

```js
const modelIsValid = typeof usage.model === 'string' && MODEL_ID_RE.test(usage.model);
if (modelIsValid) {
  span.setAttribute(ATTR_MCP_TOOL_MODEL, usage.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, usage.model);
}
```

— and change every later `if (usage.model)` check in the same function
(the `calculateCost()` gate, `pricingOverrideKeys.has(...)`) to key off
`modelIsValid` instead. Everything downstream already handles the
"no valid model" case correctly with **zero further changes**:
`pricingStatus` already resolves to `MCP_TOOL_PRICING_STATUS_UNKNOWN`
whenever `costUsd === null` (`instrument.js:830-835`, ADR 016 point 4);
`budgetTracker.recordUnpriced(usage.model)` already fires
(`instrument.js:856`) — note it's still passed the *raw* rejected
`usage.model`, which matters for the warning design below — and a
configured budget guardrail already gets its one-time
`docs/known-gaps.md` entry 9 warning naming the situation. Token counts
(`mcp.tool.tokens.*`) are set before this gate (`instrument.js:813-815`)
and stay unaffected either way, exactly as they already do for the
existing "no model detected" case.

**One new diagnostic, and it must not re-leak what it's warning about.**
`recordUnpriced()`'s existing warning (`cost/budget.js:188-`) is gated on
a budget actually being configured and describes a different, later-
stage condition ("didn't resolve to a price"). This gate's rejection is
an earlier, different condition ("looked hostile/malformed before a price
lookup was even attempted") an operator should be able to tell apart from
a legitimately-unpriced real model — so it needs its own one-time
`diag.warn()`, unconditional on budget configuration (any
`costTracking.enabled` deployment benefits from knowing this happened,
not just ones with a budget). The one thing it must **not** do is print
the rejected string itself: `diag.warn()` output routinely gets piped
into a deployment's own logging pipeline, and a warning that helpfully
echoes the very content this whole gate exists to keep off a span would
just relocate the leak from spans to logs — a worse outcome than doing
nothing, since it would look like a fix while introducing a second,
undocumented channel for the exact same problem. The warning should
report shape, not content: length, and which check failed (length vs.
character class) — e.g. *"a tool result's model field failed validation
(length 8452, expected ≤256 identifier-shaped characters) and was
excluded from mcp.tool.model / cost attribution; pricing_status set to
'unknown'"* — never a substring or preview of the value.

### Scope: `costTracking.pricing`/`pricingTable` keys are untouched

This gate applies only to `usage.model` — content read out of a tool
*result*. An operator's own `costTracking.pricing`/`pricingTable`
override keys (ADR 016) are config the operator authored themselves, a
categorically different trust level than tool-result content; nothing
about this design touches them, and no version of this gate should ever
reject a configured override key.

### Ships default-on, no config knob — unlike Part 1

Deliberately asymmetric with Part 1's config surface, and the asymmetry
is load-bearing, not an inconsistency: Part 1 is a genuine fidelity-
versus-exposure *tradeoff* with legitimate deployments wanting either
extreme, so it needs an operator-chosen mode with a non-breaking default.
A 256-character, identifier-shaped allowlist on a field whose entire
documented purpose is "a short model identifier" has no such tradeoff — a
well-behaved tool result is never affected, and the cases it does affect
are, by construction, not legitimate model identifiers. It ships
unconditionally, the same way `error_class`'s 128-char cap and
`validation_paths`'s `<KEY>` redaction (entry 10's direct fixes) both
shipped default-on with no toggle — a length/shape hardening gate is not
the same category of decision as a content-scrubbing policy, and does not
need to wait for a major version or an opt-in.

## Documenting the threat model: README, not (only) this ADR

**Both, but for different audiences, matching this project's own
established pattern.** Every prior ADR whose decision has a real
user-facing consequence gets a corresponding README section that states
the *consequence* in operator-facing language, separate from the ADR that
argues the *decision*: ADR 016's pricing/staleness reasoning surfaces as
README's "Pricing accuracy and staleness"; ADR 010's schema-drift
decisions surface as its "Known limitations"; ADR 011's sampling decision
surfaces as the "Cost-aware trace sampling" recipe. This ADR is where the
framing argument and the two designs live, for future readers asking "why
does it work this way." A plain-language threat-model paragraph is what
an operator deciding whether to adopt this library — or how to configure
`errorRecording` — actually needs, and it belongs in `packages/core/README.md`,
written when the implementation lands (not now — this ADR is design only).

Specified precisely enough to implement directly once accepted, the
section should state, plainly and without hedging:

1. This library forwards what tools and thrown exceptions actually
   produce; it does not invent, infer, or independently verify content.
2. Three concrete channels carry that content onto spans today:
   `recordException`/`setStatus` (raw by default; `errorRecording.mode`
   controls it), `mcp.tool.model`/`gen_ai.response.model` (length/shape-
   gated, but not scrubbed — a legitimate-shaped but still-arbitrary
   string from a tool result reaches the span), and — noted for
   completeness even though already fixed — `mcp.failure.error_class`
   (length-capped) and `mcp.failure.validation_paths` (dynamic keys
   redacted).
3. This is not unique to opentel-mcp: cite the same OpenTelemetry
   semantic-conventions language this ADR cites (`exception.message`
   "may contain sensitive information," recorded by default across the
   ecosystem) so operators understand the baseline they're already
   working with in every other instrumented span in the same trace, and
   what this library additionally offers on top of it.
4. Name the controls this ADR adds and their tradeoffs in one line each,
   linking to the fuller "Cost & Token Attribution" / new "Error
   recording" README sections for detail.

## Constraints accepted

- **Part 1's default does not change in this ADR.** `errorRecording`
  defaults to `'full'` — behavior-identical to every release before it —
  until a future major version revisits the default explicitly. This ADR
  authorizes shipping the config surface, not pre-enabling it.
- **`'normalized'` mode must not mutate the original `err`.** Both call
  sites rethrow it; the exception event is built via `addEvent()` with
  independently-normalized content, never by editing `err.message`/
  `err.stack` in place.
- **The model-field allowlist is deliberately generous.** Any future
  tightening needs its own evidence (a real, verified provider
  convention it would break), not a guess in the other direction — the
  instruction driving this section was explicit that a false rejection
  is the worse failure mode.
- **The rejection warning names shape, never content.** No
  implementation of this ADR's Part 2 may print, truncate-and-print, or
  otherwise echo the rejected `usage.model` value into `diag.warn()`
  output — doing so relocates entry 10's exact problem rather than fixing
  it.
- **`costTracking.pricing`/`pricingTable` keys are out of scope for Part
  2**, unconditionally — operator-authored config, not tool-result
  content.

## Alternatives rejected

- **Scrub `recordException`/`setStatus` by default, today.** Rejected —
  Part 0's decision and the default-argument above both land on this
  being the wrong default for a `0.x` release: an invisible behavior
  change on the highest-traffic failure path, breaking an ecosystem-wide
  expectation the OTel spec itself endorses as the baseline.
- **Route `mcp.tool.model` through `normalizeMessage()`'s PII patterns
  instead of a dedicated allowlist.** Rejected — a model identifier is
  not free text; email/UUID/URL-shaped scrubbing is solving a problem
  this field doesn't have, and would either false-positive on a
  legitimately colon/dot-bearing model id (an IP-shaped or timestamp-
  shaped false match is plausible against some real identifiers) or pass
  through arbitrary non-identifier content the patterns don't happen to
  match. A positive allowlist is the correct shape for a field with a
  known, bounded expected format; a scrubbing pipeline is the correct
  shape for free text. Using the wrong one for either field was itself
  worth naming, not just picking correctly by default.
- **Silently drop a rejected `mcp.tool.model` with no signal.** Rejected
  outright — this is the literal disease `docs/known-gaps.md` entry 9
  already diagnosed and fixed once in this same subsystem; reintroducing
  it one field over would be a regression on a lesson this codebase has
  already paid for.
- **Treat `exception.stacktrace` with the same scrubbing as
  `exception.message`.** Rejected — argued in Part 1: it destroys the
  signal a stack trace exists to provide, for a threat model
  (embedded runtime values) that JS stack traces structurally don't have,
  while missing the one real leak they do have (an unstripped `cwd`
  prefix) — which `normalizeMessage()`'s patterns don't address either,
  since a bare absolute path with no `@`/UUID-shaped content simply
  doesn't match any of `NORMALIZE_STEPS`. `parseAndNormalizeStack()`'s
  existing, purpose-built normalization is the correct tool for this
  specific channel.

## Versioning: target v0.13.0 for both parts, default-flip deferred to 1.0

Both parts originate from the same entry-10 investigation and are
naturally paired for one release, but are independently implementable —
either could ship without the other with no coupling between them. Part 2
(the model-field gate) is small and self-contained, comparable in scope
to entry 10's own direct fixes; Part 1 (the `errorRecording` config
surface, its two new call-site branches across both handlers, the
stack-normalization reuse, and the README threat-model section) is
larger, comparable to ADR 016/017's scope, and needs its own test
coverage across both `tools/call` and `tools/list`. Recommended as one
paired release, `v0.13.0`, rather than splitting across two minors —
nothing about landing them separately reduces review surface, and
shipping them together tells the same coherent entry-10 story in one
changelog entry rather than two partial ones. The `'normalized'`-becomes-
default question is explicitly **not** part of this target — flagged
above as a decision for whoever plans `1.0`, not pre-committed here.

## Consequences

- No code changes from this ADR. `instrument.js`, `cost/extractor.js`,
  and `cost/calculator.js` are all unchanged today.
- `docs/known-gaps.md` entry 10 already carries an appended "Update"
  note pointing here, added alongside this ADR rather than deferred to
  acceptance — the same precedent ADR 018 set by appending its own note
  to ADR 012 at design time, not editing that entry's original text in
  place.
- Sets up two independently-implementable, precisely-specified follow-ups:
  a new `errorRecording` config option plus two new branches in
  `wrapToolCallHandler`/`wrapToolsListHandler` and a reused
  `parseAndNormalizeStack()` call for stack content (Part 1); and a
  validity gate plus one new one-time warning in `applyCostAttribution()`
  (Part 2) — both leaving every other line of `docs/known-gaps.md` entry
  10's remaining scope untouched.
