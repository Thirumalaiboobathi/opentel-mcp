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
function normalizeModelName(model) {
  const lower = model.toLowerCase();
  const slashIndex = lower.indexOf('/');
  return slashIndex === -1 ? lower : lower.slice(slashIndex + 1);
}

/**
 * Calculates the USD cost of a request from its input/output token counts,
 * a model name, and a pricing table. Never throws: an unrecognized model or
 * an invalid token count resolves to `null` rather than an exception,
 * matching this library's fail-open philosophy (see instrument.js).
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} model - Matched against `pricingTable` after
 *   lowercasing and stripping a "provider/" prefix.
 * @param {import('./pricing.js').PricingTable} pricingTable
 * @returns {number | null} Cost in USD rounded to 6 decimals, or `null` if
 *   `model` isn't in `pricingTable` or a token count is negative,
 *   non-numeric, or non-finite.
 */
export function calculateCost(inputTokens, outputTokens, model, pricingTable) {
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return null;
  }

  const pricing = pricingTable[normalizeModelName(model)];
  if (!pricing) {
    return null;
  }

  const cost = (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Math.round(cost * 1e6) / 1e6;
}
