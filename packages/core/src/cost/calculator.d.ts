import type { PricingTable } from './types.d.ts';

/**
 * Calculates the USD cost of a request from its input/output token counts, a
 * model name, and a pricing table. Never throws: an unrecognized model, an
 * invalid token count, or a malformed pricing entry all resolve to `null`
 * rather than an exception. Branches on the resolved entry's `pricingKind` —
 * `'embedding'` entries are priced on `inputTokens` only. See ADR 016
 * (`docs/adr/016-pricing-override-and-staleness.md`).
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricingTable: PricingTable,
): number | null;

/**
 * Lowercases `model` and strips a leading "provider/" prefix, for
 * pricing-table lookup. Exported for internal reuse (e.g. computing
 * `mcp.tool.pricing_status`'s `'known'` vs `'user_override'` distinction
 * against the same normalized key `calculateCost` itself looks up) — not
 * re-exported from the package root.
 */
export function normalizeModelName(model: string): string;
