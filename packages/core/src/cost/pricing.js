/**
 * @module cost/pricing
 * Static per-model token pricing used to estimate MCP tool-call cost.
 *
 * This module is data plus two shared type shapes — no network calls, no
 * provider SDK dependency. `DEFAULT_PRICING` is a best-effort snapshot;
 * pricing changes frequently and varies by region/contract, so callers who
 * need accurate cost attribution should supply their own `pricing`
 * override (merged per-model over this table) or a full replacement
 * `pricingTable` — see `costTracking` in `src/config.js` and ADR 016
 * (`docs/adr/016-pricing-override-and-staleness.md`) for the merge
 * semantics and why staleness is signalled rather than silently trusted.
 */

/**
 * @typedef {Object} ChatModelPricing
 * @property {'chat'} pricingKind
 * @property {number} inputPer1M - USD cost per 1,000,000 input tokens.
 * @property {number} outputPer1M - USD cost per 1,000,000 output tokens.
 * @property {'USD'} currency
 */

/**
 * A model with no output-token cost at all — not `outputPer1M: 0`. See ADR
 * 016 point 1: a zero is indistinguishable from a data-entry bug or a
 * genuinely free tier; omitting the field removes the ambiguity because
 * there is no number to have gotten wrong.
 *
 * @typedef {Object} EmbeddingModelPricing
 * @property {'embedding'} pricingKind
 * @property {number} inputPer1M - USD cost per 1,000,000 input tokens.
 * @property {'USD'} currency
 */

/** @typedef {ChatModelPricing | EmbeddingModelPricing} ModelPricing */

/**
 * @typedef {Record<string, ModelPricing>} PricingTable
 */

// Prices in USD per 1M tokens. Last verified: see DEFAULT_PRICING_LAST_VERIFIED
// below — surfaced at runtime (a one-time diag.warn, plus a resource
// attribute when setupNodeSdk is true), not just in this comment. See ADR
// 016 point 3. Users should override via costTracking.pricing (merged
// per-model over this table) for accuracy — opentel-mcp does not guarantee
// this table stays current.
/** @type {PricingTable} */
export const DEFAULT_PRICING = {
  // Anthropic
  'claude-opus-4-7': { pricingKind: 'chat', inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },
  'claude-opus-4-6': { pricingKind: 'chat', inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },
  'claude-sonnet-5': { pricingKind: 'chat', inputPer1M: 3.0, outputPer1M: 15.0, currency: 'USD' },
  'claude-haiku-4-5': { pricingKind: 'chat', inputPer1M: 1.0, outputPer1M: 5.0, currency: 'USD' },
  'claude-sonnet-4-6': { pricingKind: 'chat', inputPer1M: 3.0, outputPer1M: 15.0, currency: 'USD' },
  'claude-opus-4-5': { pricingKind: 'chat', inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },

  // OpenAI
  'gpt-4o': { pricingKind: 'chat', inputPer1M: 2.5, outputPer1M: 10.0, currency: 'USD' },
  'gpt-4o-mini': { pricingKind: 'chat', inputPer1M: 0.15, outputPer1M: 0.6, currency: 'USD' },
  'gpt-5': { pricingKind: 'chat', inputPer1M: 1.25, outputPer1M: 10.0, currency: 'USD' },
  'gpt-5-mini': { pricingKind: 'chat', inputPer1M: 0.25, outputPer1M: 2.0, currency: 'USD' },
  o3: { pricingKind: 'chat', inputPer1M: 2.0, outputPer1M: 8.0, currency: 'USD' },
  'o3-mini': { pricingKind: 'chat', inputPer1M: 1.1, outputPer1M: 4.4, currency: 'USD' },

  // OpenAI — embeddings (input-token-only, see EmbeddingModelPricing above)
  'text-embedding-3-small': { pricingKind: 'embedding', inputPer1M: 0.02, currency: 'USD' },
  'text-embedding-3-large': { pricingKind: 'embedding', inputPer1M: 0.13, currency: 'USD' },
  'text-embedding-ada-002': { pricingKind: 'embedding', inputPer1M: 0.1, currency: 'USD' },

  // Google
  'gemini-2-5-pro': { pricingKind: 'chat', inputPer1M: 1.25, outputPer1M: 10.0, currency: 'USD' },
  'gemini-2-5-flash': { pricingKind: 'chat', inputPer1M: 0.3, outputPer1M: 2.5, currency: 'USD' },

  // Cohere — embeddings
  'cohere-embed-v3': { pricingKind: 'embedding', inputPer1M: 0.1, currency: 'USD' },

  // AWS Bedrock (Amazon Nova). us-east-1 list price assumed — Bedrock
  // pricing varies by region and this table is not region-keyed; see ADR
  // 016 point 5. Override via costTracking.pricing for a different region.
  'amazon-nova-pro': { pricingKind: 'chat', inputPer1M: 0.8, outputPer1M: 3.2, currency: 'USD' },
  'amazon-nova-lite': { pricingKind: 'chat', inputPer1M: 0.06, outputPer1M: 0.24, currency: 'USD' },
  'amazon-nova-micro': { pricingKind: 'chat', inputPer1M: 0.035, outputPer1M: 0.14, currency: 'USD' },

  // AWS Bedrock — Titan embeddings. Same us-east-1-assumed caveat as the
  // Nova entries above.
  'amazon-titan-embed-v2': { pricingKind: 'embedding', inputPer1M: 0.02, currency: 'USD' },

  // DeepSeek
  'deepseek-v3': { pricingKind: 'chat', inputPer1M: 0.27, outputPer1M: 1.1, currency: 'USD' },
  'deepseek-r1': { pricingKind: 'chat', inputPer1M: 0.55, outputPer1M: 2.19, currency: 'USD' },
};

/**
 * ISO date `DEFAULT_PRICING` was last checked against provider list
 * pricing. Read by `resolveOptions()` (`src/config.js`) to decide whether
 * to fire the one-time staleness `diag.warn()` / resource attribute — see
 * `isDefaultPricingStale()` below and ADR 016 point 3.
 *
 * @type {string}
 */
export const DEFAULT_PRICING_LAST_VERIFIED = '2026-08-13';

/**
 * True once `now` is more than `thresholdDays` past
 * `DEFAULT_PRICING_LAST_VERIFIED`. A pure function of its arguments — `now`
 * is injectable specifically so tests don't depend on wall-clock time
 * relative to a constant that will itself change on every pricing
 * revision.
 *
 * @param {Date} [now]
 * @param {number} [thresholdDays]
 * @returns {boolean}
 */
export function isDefaultPricingStale(now = new Date(), thresholdDays = 90) {
  const lastVerifiedMs = Date.parse(DEFAULT_PRICING_LAST_VERIFIED);
  const nowMs = now.getTime();
  if (!Number.isFinite(lastVerifiedMs) || !Number.isFinite(nowMs)) return false;

  const ageDays = (nowMs - lastVerifiedMs) / (1000 * 60 * 60 * 24);
  return ageDays > thresholdDays;
}
