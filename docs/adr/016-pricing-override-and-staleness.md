# ADR 016: Pricing table override and staleness signalling

**Status:** Accepted — implemented in v0.11.0 (Phase 1 of a two-phase
pricing subsystem rework; Phase 2 is out of scope for this ADR).

## Context

`DEFAULT_PRICING` (`src/cost/pricing.js`) is a hardcoded, best-effort
snapshot of per-model USD pricing, baked into the package and dated only
by a docblock comment. This has the exact failure mode this whole
library exists to eliminate elsewhere: when a provider changes list
price, or when an enterprise pays a negotiated rate instead of list
price, `calculateCost()` keeps producing a confident, precise-looking
number with zero signal that it might be wrong. A cost dashboard built
on `mcp.tool.cost.usd` cannot distinguish "this is accurate" from "this
is six months stale" from "this model isn't even in the table, we
silently priced it as if it cost nothing to show up at all."

Four concrete gaps, all with the same shape — silent wrongness instead
of a signal:

1. **No embedding support.** Embedding calls are real MCP tool-call
   costs (RAG pipelines especially), and are input-token-only — there is
   no "output" to price. Nothing in `ModelPricing` says so.
2. **No override merge.** `costTracking.pricingTable` fully replaces
   `DEFAULT_PRICING` when supplied (`config.js`:
   `rawCostTracking.pricingTable ?? DEFAULT_PRICING`). Overriding one
   model's price today means manually spreading the entire default table
   yourself (see the README's existing example) — easy to do once, easy
   to silently drift once `DEFAULT_PRICING` gains new entries the user's
   copy-pasted spread doesn't know about.
3. **No staleness visibility.** `DEFAULT_PRICING`'s "last verified" date
   lives in a comment nobody sees at runtime.
4. **No unpriced-spend visibility.** An unrecognized model already
   correctly omits `mcp.tool.cost.usd` (never fabricates a `$0`), but
   there's no positive signal a dashboard can group by to answer "what
   fraction of our tool calls are running through models we can't
   price at all?" — only the absence of a fact, which is
   indistinguishable from "this call simply didn't produce any cost."

This ADR covers the design decisions behind fixing all four. Scope is
deliberately Phase 1 only, per the v0.11.0 plan: pricing data model,
override merge semantics, staleness signalling, and the
`pricing_status` attribute. Phase 2 (not designed here) is a separate,
later unit of work.

## Decision

### 1. `pricingKind` discriminator, not an implicit zero

`ModelPricing` becomes a discriminated union on a new required
`pricingKind` field:

```ts
interface ChatModelPricing {
  readonly pricingKind: 'chat';
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly currency: 'USD';
}
interface EmbeddingModelPricing {
  readonly pricingKind: 'embedding';
  readonly inputPer1M: number;
  readonly currency: 'USD';
}
type ModelPricing = ChatModelPricing | EmbeddingModelPricing;
```

An embedding entry has **no `outputPer1M` field at all** — not
`outputPer1M: 0`. The brief for this feature states the reasoning
directly and it's worth repeating as the record: a `0` is
indistinguishable from a data-entry bug or a genuinely free tier: was
this deliberately priced at zero, or did whoever entered it forget the
number? Omitting the field entirely removes the ambiguity — there is no
number to have gotten wrong, because the concept doesn't apply.

Every entry in `DEFAULT_PRICING` gets an explicit `pricingKind` — five
new embedding entries (OpenAI `text-embedding-3-small`,
`text-embedding-3-large`, `text-embedding-ada-002`; Cohere
`cohere-embed-v3`; Bedrock `amazon-titan-embed-v2`) plus `pricingKind:
'chat'` added to every existing entry.

`calculateCost()` (`cost/calculator.js`) branches on `pricingKind`:
`'embedding'` computes `(inputTokens / 1e6) * inputPer1M` and never reads
`outputTokens` in the cost formula at all (a nonzero `outputTokens` on an
embedding call is not an error this function can distinguish from a
caller simply not knowing better — it validates the number is present
and finite, same as ever, but doesn't let it contribute to cost); `'chat'`
is the existing two-term formula, unchanged.

**Backward compatibility, deliberately asymmetric between type and
runtime:** the *type* requires `pricingKind`; the *runtime* does not. A
user's existing custom `pricingTable`/`pricing` entries written before
this release have no `pricingKind` field. `calculateCost()` treats a
missing or unrecognized `pricingKind` as `'chat'` — the exact behavior
those entries already had. This is the same split this codebase already
draws elsewhere between compile-time contracts and the runtime's
never-throw discipline (see `extractor.js`'s docblock): the type
describes the shape new code should produce; the runtime degrades
gracefully for shapes it merely receives. A future TypeScript consumer
upgrading will see a type error pointing at exactly the entries that
need a `pricingKind` added — a compile-time nudge, not a runtime break.

### 2. New `pricing` option: partial, per-model merge over defaults

`CostTrackingOptions` gains a new field, `pricing?: Partial<PricingTable>`,
resolved as:

```js
const base = rawCostTracking.pricingTable ?? DEFAULT_PRICING;
const effectivePricingTable = { ...base, ...rawCostTracking.pricing };
```

This is a **per-model merge**: each key in `pricing` replaces that one
model's entire `ModelPricing` object in the effective table; every other
key from `base` is untouched. It is not a deep/field-level merge inside
one `ModelPricing` (supplying `{ inputPer1M: 1.5 }` alone for a model
does not "partially" adjust just the input price of an existing entry —
it replaces that model's whole pricing record, so a caller overriding a
model must supply a complete, valid `ModelPricing`). Per-model, not
field-level, matches the existing `PricingTable` shape
(`Record<model, ModelPricing>`) exactly — no new merge primitive is
introduced beyond a single object spread, keeping this defensible and
easy to reason about instead of writing a general deep-merge.

**`pricingTable` (existing option) keeps its current full-replace
semantics, unchanged.** This was a deliberate choice, not an oversight —
see "Alternatives rejected" below for why changing its existing behavior
was rejected. `pricing` is additive: the common case ("I want to correct
three models' prices and leave everything else as shipped") now needs
three lines instead of a full-table spread; the existing, less common
case ("I want a pricing table that contains *only* my own models, and
nothing this package ships") still works exactly as it does today via
`pricingTable`.

### 3. Staleness: a `lastVerified` constant, surfaced once

`pricing.js` gains `DEFAULT_PRICING_LAST_VERIFIED = '2026-08-13'` (an
ISO date string, updated whenever `DEFAULT_PRICING`'s numbers are
next revised) alongside a pure, injectable-`now` helper:

```js
export function isDefaultPricingStale(now = new Date(), thresholdDays = 90) { ... }
```

Surfaced two ways, matching the brief's "resource attribute or single
init-time log — pick one" with a reason to actually do both, not
arbitrarily:

- **Always:** a one-time `diag.warn()` at `instrumentMcpServer()` setup
  time, gated by a module-level flag exactly like the existing
  `warnedServiceNameIgnored` pattern in `config.js` (same
  `__reset*ForTests` escape hatch for test isolation). This is the
  general-case signal — it reaches every deployment, including the
  majority (per this package's own documented default) that never call
  `setupNodeSdk: true` and therefore have no resource the second
  mechanism could attach to at all.
- **Additionally, when `setupNodeSdk: true`:** a
  `mcp.pricing.default_table_last_verified` resource attribute, added to
  the same `resourceFromAttributes()` call `setupTracer()` already makes
  for `service.name`. This path already owns and constructs its own
  resource, so attaching one more attribute is free and gives that
  subset of users a queryable dimension (e.g. "alert if any served
  instance is running pricing data older than N days") that a log line
  cannot provide.

Both are gated on the same condition: **only when `DEFAULT_PRICING` is
actually contributing to the effective table**, i.e. `rawCostTracking.
pricingTable` was not supplied. A user who fully replaced the pricing
table isn't using our defaults at all, so a warning about our defaults'
staleness would be actively misleading. (A user relying only on
`pricing`, layered over `DEFAULT_PRICING`, still gets the warning — the
base table, and everything not named in their override, is still ours.)

Threshold: 90 days. Chosen as a round, conservative number for a
domain (LLM provider pricing) that changes on the order of months, not
days — not derived from any provider's actual revision cadence, since
none is published; documented here as a judgment call, not a measured
constant, so a future revision has a clear place to record why it
changed.

### 4. `pricing_status`: known / unknown / user_override

A new span + metric attribute, `mcp.tool.pricing_status`
(`ATTR_MCP_TOOL_PRICING_STATUS`), set whenever token usage was extracted
at all (i.e. the same gating as the existing `mcp.tool.tokens.*`
attributes — present even when no model was detected), with exactly
three well-known values:

- `'unknown'` — no model was detected, or a model was detected but
  didn't resolve to a cost (unrecognized, or its pricing entry was
  malformed enough that `calculateCost()` degraded to `null` — see
  Constraint below).
- `'known'` — the model resolved against an entry that came from
  `DEFAULT_PRICING` (untouched by the caller's `pricing`/`pricingTable`).
- `'user_override'` — the model resolved against an entry the caller
  supplied via `pricing` or `pricingTable`.

**Provenance-based, not value-based.** `'user_override'` means "this
model's key was present in the caller's override surface," not "the
resolved numbers differ from what `DEFAULT_PRICING` would have said."
Determining the latter would mean deep-comparing `ModelPricing` objects
on every priced call — extra work, on the hot path, to answer a question
nobody asked. If a caller's `pricing`/`pricingTable` happens to redeclare
a model with numbers identical to our default (e.g. by spreading
`...DEFAULT_PRICING` the way the README used to recommend), it still
reports `user_override` — which is honest: the caller told this package
that model's price is theirs to own, and the source of truth for it
going forward is their config, not ours, whether or not the numbers
happen to currently agree.

This is computed once, in `resolveOptions()`, as a `Set` of normalized
model keys drawn from `rawCostTracking.pricing` and
`rawCostTracking.pricingTable` (when either is supplied) — not
recomputed per call.

**Where it's emitted:** the span attribute is unconditional (same
gating as the token attributes). The metric attribute is added to both
`mcp.tool.tokens.total` (every value, since `pricing_status` is always
computable once usage exists) and `mcp.tool.cost.total` (only `'known'`/
`'user_override'` ever reach this counter, by construction — it's never
recorded when `costUsd` is `null`, so `'unknown'` never appears as a
label there).

**Cardinality:** a fixed, closed 3-value enum — well inside this
package's existing metric-label discipline. It does **not** go into
`fingerprint/attributes.js`'s `METRIC_SAFE_ATTRIBUTES` — that list
governs the `mcp.failure.*` domain specifically (its own docblock scopes
it to that), and `schema-drift/attributes.js` already establishes the
precedent that a different domain gets its *own*, separately-justified
list rather than borrowing an unrelated one (mixing domains there would
obscure which ADR/reasoning covers which attribute, and — since neither
list is a general-purpose "here is what's safe on any metric" registry —
would be actively confusing about what governs what). Cost gets its own,
`src/attributes.js`-local `COST_METRIC_SAFE_ATTRIBUTES = [
ATTR_MCP_TOOL_PRICING_STATUS]`, internal (not re-exported from
`index.js`, matching `schema-drift`'s own not-publicly-exported
precedent) but exercised by a test the same way `schema-drift/
emitter.test.js` already exercises its own list. `mcp.tool.model`
remains governed the way it already was — an inline cardinality
justification comment in `metrics.js`, not a list entry — since that
attribute's boundedness argument ("however many distinct models a
deployment actually calls") is different in kind from a fixed enum and
doesn't fit a closed-list mechanism cleanly.

### 5. Bedrock region: document loudly, don't key on it

Bedrock pricing genuinely varies by region, and the existing three Nova
entries (and the new Titan embedding entry) are, and remain, us-east-1
list prices. **Decision: document it, don't key on it.**

Keying the table on region was rejected for a concrete, checkable
reason, not a vague "too much work": `defaultExtractor()`
(`cost/extractor.js`) has no region field in any of the conventions it
recognizes (Anthropic/OpenAI/Bedrock usage shapes, the MCP `_meta`
extension, JSON-in-text) — Bedrock's own `usage` object
(`{inputTokens, outputTokens}`) carries no region either. A
region-keyed table (`'amazon-nova-pro/us-west-2'` or similar) would need
a region value from *somewhere*, and there is no somewhere: it would
require either a new, provider-specific extraction convention this
package would have to invent and maintain (fragile — AWS doesn't
document region appearing in Bedrock's client-facing usage response),
or pushing the burden onto every Bedrock caller to supply region
out-of-band, defeating the "zero-config quick-start" this feature
already documents as its primary path. A caller who *does* need
region-accurate Bedrock pricing already has the tool for it, shipped
this same release: `pricing: { 'amazon-nova-pro': { ...their real
regional numbers } }`.

## Constraints accepted

- **Never-throw holds throughout.** `calculateCost()` gains defensive
  validation it didn't need before, specifically because `pricing` makes
  it newly reachable with attacker- or typo-controlled shapes it
  previously wasn't (a hand-typed `DEFAULT_PRICING` was always
  well-formed by construction; a user's `pricing` object is not): a
  missing/non-numeric/negative `inputPer1M`, or (for a `'chat'`-kind
  entry) a missing/non-numeric/negative `outputPer1M`, now makes that
  model resolve to `null` — same "degrade to `null`, never throw" contract
  the function already had for unknown models and invalid token counts,
  extended to cover invalid *pricing* entries, not just invalid inputs or
  absent entries. A malformed override entry therefore surfaces as
  `pricing_status: 'unknown'` for that model, not a crash and not a
  fabricated cost.
- **No runtime network calls — reaffirmed, not merely inherited.**
  Nothing in this ADR fetches anything. `pricing`/`pricingTable` are
  synchronous, caller-supplied JS objects; `isDefaultPricingStale()`
  reads a hardcoded constant against `Date.now()` (or an injected `now`
  for testability) and nothing else. The staleness signal exists
  specifically *instead of* the tempting alternative — checking a live
  pricing feed at startup — which this package's own "tracing library
  making network calls in the request path is an outage waiting to
  happen" principle rules out categorically, not just for this feature.
- **`METRIC_SAFE_ATTRIBUTES` cardinality discipline respected**, per
  point 4 above — verified against the existing domain-scoped pattern
  rather than assumed to mean "the one list in `fingerprint/
  attributes.js`."
- **Types updated alongside implementation** — `cost/types.d.ts` gains
  the `ChatModelPricing`/`EmbeddingModelPricing` union and the `pricing`
  field on `CostTrackingOptions`; `cost/pricing.d.ts` and
  `cost/calculator.d.ts` updated to match; both re-exported from
  `index.d.ts` exactly as their predecessors were.

## Alternatives rejected

- **Changing `pricingTable`'s existing behavior to merge instead of
  replace, rather than adding a new `pricing` field.** Rejected: this
  would silently change behavior for every existing caller who passes
  `pricingTable` today expecting a full replace — including the
  legitimate case of a caller who deliberately does *not* want
  `DEFAULT_PRICING`'s entries in their effective table at all (e.g. an
  internal-only deployment that wants unpriced-but-not-Anthropic'd
  models to correctly show `pricing_status: 'unknown'` rather than
  silently regaining a default entry the caller never asked for). A
  same-release breaking change to an existing option, for a benefit
  fully achievable by an additive new field, has no offsetting upside.
- **A field-level (deep) merge inside one model's `ModelPricing`**, so
  `pricing: { 'claude-sonnet-5': { inputPer1M: 2.5 } }` would adjust
  just the input price and inherit `outputPer1M`/`currency` from the
  default entry. Rejected: implicit inheritance of half a pricing record
  is exactly the kind of "looks complete, silently isn't" gap this whole
  ADR exists to close elsewhere (see the `pricingKind`/zero-cost
  reasoning above) — a caller who forgets `outputPer1M` should see a
  type error or a `pricing_status: 'unknown'` degradation, not a silently
  inherited number they didn't actually verify.
- **Value-diffing for `user_override` vs `known`** (comparing the
  resolved `ModelPricing` against `DEFAULT_PRICING`'s own entry to decide
  the status). Rejected as unnecessary hot-path work for a distinction
  provenance already answers — see point 4 above.
- **Keying `DEFAULT_PRICING` on Bedrock region.** Rejected — no reliable
  region signal exists anywhere in this package's extraction path to key
  a lookup on; see point 5.
- **Fetching a live pricing feed at `instrumentMcpServer()` setup time**
  (or lazily, on first cost calculation) to eliminate staleness instead
  of merely signalling it. Rejected outright, no real consideration
  given beyond confirming it violates this package's no-network-calls
  constraint — a tracing/instrumentation library initiating outbound
  HTTP calls, especially ones a misbehaving or rate-limiting upstream
  could stall, is a new failure mode this package has never had and this
  feature does not justify introducing.

## Consequences

- `ModelPricing` is now a breaking *type* change for any TypeScript
  consumer with an existing custom `pricingTable`/`pricing` object typed
  against the old single-shape interface — they'll see a compile error
  requiring `pricingKind` on each entry. Runtime behavior for those same
  objects is unchanged (defaults to `'chat'` — see point 1). Called out
  plainly in the CHANGELOG, matching this repo's existing precedent for
  flagging behavior/type changes at the top of a release's entry (v0.9.0,
  v0.10.0).
- The common "override a few models' prices" path is now `pricing: {
  ... }` instead of spreading `DEFAULT_PRICING` by hand; the README's
  existing example is updated to lead with it, with the full-replace
  `pricingTable` path kept as the documented alternative for the
  narrower "I want only my own models" case.
- Every deployment using `DEFAULT_PRICING` for any part of its effective
  table gets exactly one `diag.warn()` at startup naming the table's
  `lastVerified` date once the 90-day threshold is crossed — dashboards
  built on `mcp.tool.pricing_status` can now express "N% of spend is
  running through models we can't price" as a direct query instead of an
  inference from missing data.
- Phase 2 (out of scope here) inherits a `PricingTable`/`ModelPricing`
  shape that already distinguishes chat from embedding pricing and
  already carries per-model override provenance — any follow-on work
  (e.g. additional `pricingKind`s, richer regional modeling) extends this
  discriminated-union shape rather than reworking it.
