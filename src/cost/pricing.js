/**
 * @module cost/pricing
 * Static per-model token pricing used to estimate MCP tool-call cost.
 *
 * This module is data plus two shared type shapes — no network calls, no
 * provider SDK dependency. `DEFAULT_PRICING` is a best-effort snapshot;
 * pricing changes frequently and varies by region/contract, so callers who
 * need accurate cost attribution should supply their own `PricingTable`
 * rather than rely on this one being current.
 */

/**
 * @typedef {Object} ModelPricing
 * @property {number} inputPer1M - USD cost per 1,000,000 input tokens.
 * @property {number} outputPer1M - USD cost per 1,000,000 output tokens.
 * @property {'USD'} currency
 */

/**
 * @typedef {Record<string, ModelPricing>} PricingTable
 */

// Prices in USD per 1M tokens. Last verified: 2026-07-29. Users should
// override via config for accuracy — Anthropic does not guarantee this
// table stays current.
/** @type {PricingTable} */
export const DEFAULT_PRICING = {
  // Anthropic
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },
  'claude-sonnet-5': { inputPer1M: 3.0, outputPer1M: 15.0, currency: 'USD' },
  'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0, currency: 'USD' },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0, currency: 'USD' },
  'claude-opus-4-5': { inputPer1M: 5.0, outputPer1M: 25.0, currency: 'USD' },

  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0, currency: 'USD' },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, currency: 'USD' },
  'gpt-5': { inputPer1M: 1.25, outputPer1M: 10.0, currency: 'USD' },
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2.0, currency: 'USD' },
  o3: { inputPer1M: 2.0, outputPer1M: 8.0, currency: 'USD' },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4, currency: 'USD' },

  // Google
  'gemini-2-5-pro': { inputPer1M: 1.25, outputPer1M: 10.0, currency: 'USD' },
  'gemini-2-5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, currency: 'USD' },

  // AWS Bedrock (Amazon Nova)
  'amazon-nova-pro': { inputPer1M: 0.8, outputPer1M: 3.2, currency: 'USD' },
  'amazon-nova-lite': { inputPer1M: 0.06, outputPer1M: 0.24, currency: 'USD' },
  'amazon-nova-micro': { inputPer1M: 0.035, outputPer1M: 0.14, currency: 'USD' },

  // DeepSeek
  'deepseek-v3': { inputPer1M: 0.27, outputPer1M: 1.1, currency: 'USD' },
  'deepseek-r1': { inputPer1M: 0.55, outputPer1M: 2.19, currency: 'USD' },
};
