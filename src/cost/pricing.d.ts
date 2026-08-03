import type { PricingTable } from './types.d.ts';

/**
 * Static per-model token pricing used to estimate MCP tool-call cost, in USD
 * per 1M tokens. A best-effort snapshot — callers who need accurate cost
 * attribution should supply their own {@link PricingTable}.
 */
export const DEFAULT_PRICING: PricingTable;
