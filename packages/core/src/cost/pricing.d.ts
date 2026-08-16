import type { PricingTable } from './types.d.ts';

/**
 * Static per-model token pricing used to estimate MCP tool-call cost, in USD
 * per 1M tokens. A best-effort snapshot — callers who need accurate cost
 * attribution should supply {@link CostTrackingOptions.pricing} (merged
 * per-model over this table) or a full replacement
 * {@link CostTrackingOptions.pricingTable}.
 */
export const DEFAULT_PRICING: PricingTable;

/**
 * ISO date {@link DEFAULT_PRICING} was last checked against provider list
 * pricing. See `isDefaultPricingStale` and ADR 016
 * (`docs/adr/016-pricing-override-and-staleness.md`) point 3.
 */
export const DEFAULT_PRICING_LAST_VERIFIED: string;

/**
 * True once `now` is more than `thresholdDays` past
 * {@link DEFAULT_PRICING_LAST_VERIFIED}.
 *
 * @default thresholdDays 90
 */
export function isDefaultPricingStale(now?: Date, thresholdDays?: number): boolean;
