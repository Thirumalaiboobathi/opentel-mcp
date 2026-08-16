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
