/**
 * @module cost/calculator
 * Cost calculation for MCP tool-call token usage against a {@link
 * import('./pricing.js').PricingTable}.
 */

/**
 * Normalizes a model name for pricing-table lookup: lowercases it and
 * strips a leading "provider/" prefix (e.g. "Anthropic/Claude-Opus-4-7"
 * -> "claude-opus-4-7").
 *
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelName(model) {
  const lower = model.toLowerCase();
  const slashIndex = lower.indexOf('/');
  return slashIndex === -1 ? lower : lower.slice(slashIndex + 1);
}

// ADR 019 Part 2 (docs/adr/019-raw-content-on-spans.md, v0.13.0 Phase 2):
// usage.model is tool-RESULT content, not library-computed metadata like
// everything else applyCostAttribution() (instrument.js) puts on a span —
// so it's gated through this allowlist before it can ever reach
// mcp.tool.model/gen_ai.response.model or a metric label (metrics.js's
// recordTokens()/recordCost() both key a label off it too, so an
// unvalidated value would be a metric-cardinality hazard, not just a span
// content one).
//
// Verified empirically against two real contracts, not assumed from
// provider docs: (1) every DEFAULT_PRICING key (pricing.js) matches a
// narrower `[a-z0-9-]` set, but (2) normalizeModelName() above already
// documents AND tests (test/cost/calculator.test.js) a REQUIRED
// "provider/model" input shape ("Anthropic/Claude-Opus-4-7") that no
// DEFAULT_PRICING key itself contains — a narrow, table-derived allowlist
// would reject input this library already advertises support for. `.`/
// `:`/`@` are additionally admitted for real-world provider conventions
// this investigation did not verify live (Bedrock's
// `anthropic.claude-3-sonnet-20240229-v1:0` / ARN form, Vertex AI's
// `text-bison@001`) — deliberately generous: silently rejecting a
// legitimate model is a worse failure mode than admitting a few
// characters no currently-known convention actually uses. See
// isValidModelId()'s only caller (instrument.js's applyCostAttribution())
// for what "rejected" actually does, which is never a silent drop.
export const MODEL_ID_MAX_LENGTH = 256;
const MODEL_ID_RE = new RegExp(`^[A-Za-z0-9._:/@-]{1,${MODEL_ID_MAX_LENGTH}}$`);

/**
 * Whether `value` is shaped like a real model identifier: a non-empty
 * string, at most {@link MODEL_ID_MAX_LENGTH} characters, containing only
 * alphanumerics and `.`/`_`/`:`/`/`/`@`/`-` — see this module's own
 * comment above `MODEL_ID_MAX_LENGTH` for why this specific set. Does NOT
 * check whether `value` resolves to a `DEFAULT_PRICING` entry —
 * `mcp.tool.pricing_status: "unknown"` already exists to represent a
 * real, valid model name with no known price (ADR 016 point 4); this
 * function is a shape gate, not a pricing-table membership check.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidModelId(value) {
  return typeof value === 'string' && MODEL_ID_RE.test(value);
}

/**
 * Describes, in shape-only terms, why `value` failed {@link isValidModelId}
 * — a length, or "not a string"/"empty string" — and NEVER the value
 * itself. Used only for a one-time diagnostic (instrument.js's
 * applyCostAttribution(), ADR 019 Part 2): echoing the rejected value
 * there would relocate this whole gate's problem from spans into logs
 * instead of closing it, so this deliberately returns shape and nothing
 * else — see that function's own warnRejectedModel() for the full
 * reasoning.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeInvalidModelId(value) {
  if (typeof value !== 'string') return 'not a string';
  if (value.length === 0) return 'empty string';
  if (value.length > MODEL_ID_MAX_LENGTH) {
    return `length ${value.length}, expected 1-${MODEL_ID_MAX_LENGTH} identifier-shaped characters`;
  }
  return `length ${value.length}, contains a disallowed character`;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Calculates the USD cost of a request from its input/output token counts,
 * a model name, and a pricing table. Never throws: an unrecognized model,
 * an invalid token count, or a malformed pricing entry all resolve to
 * `null` rather than an exception, matching this library's fail-open
 * philosophy (see instrument.js) — the last of those three is a Phase 1
 * (ADR 016) addition, since `pricingTable`/`pricing` (src/config.js) can
 * now carry caller-supplied entries this function previously never had to
 * distrust.
 *
 * Branches on the resolved entry's `pricingKind` (ADR 016 point 1): a
 * `'chat'` entry (or an entry with no recognized `pricingKind` at all —
 * see below) uses the original two-term formula; an `'embedding'` entry
 * only ever charges for `inputTokens` — `outputTokens` is still validated
 * (must be a non-negative finite number, same as ever) but never
 * contributes to the cost, since embeddings have no output-token price to
 * multiply it by.
 *
 * A pricing entry with no `pricingKind` field is treated as `'chat'` —
 * this is what lets a caller's pre-v0.11.0 custom pricing table (typed and
 * written before `pricingKind` existed) keep working unchanged; see ADR
 * 016 point 1 for why the type is stricter than the runtime here.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} model - Matched against `pricingTable` after
 *   lowercasing and stripping a "provider/" prefix.
 * @param {import('./pricing.js').PricingTable} pricingTable
 * @returns {number | null} Cost in USD rounded to 6 decimals, or `null` if
 *   `model` isn't in `pricingTable`, its pricing entry is malformed, or a
 *   token count is negative, non-numeric, or non-finite.
 */
export function calculateCost(inputTokens, outputTokens, model, pricingTable) {
  if (!isNonNegativeFiniteNumber(inputTokens) || !isNonNegativeFiniteNumber(outputTokens)) {
    return null;
  }

  const pricing = pricingTable?.[normalizeModelName(model)];
  if (!pricing || typeof pricing !== 'object') {
    return null;
  }
  if (!isNonNegativeFiniteNumber(pricing.inputPer1M)) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;

  if (pricing.pricingKind === 'embedding') {
    return Math.round(inputCost * 1e6) / 1e6;
  }

  // 'chat', or no recognized pricingKind — see docblock above.
  if (!isNonNegativeFiniteNumber(pricing.outputPer1M)) {
    return null;
  }
  const cost = inputCost + (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Math.round(cost * 1e6) / 1e6;
}
