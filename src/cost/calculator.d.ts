import type { PricingTable } from './types.d.ts';

/**
 * Calculates the USD cost of a request from its input/output token counts, a
 * model name, and a pricing table. Never throws: an unrecognized model or an
 * invalid token count resolves to `null` rather than an exception.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricingTable: PricingTable,
): number | null;
