/**
 * Shared type definitions for the cost & token attribution feature.
 *
 * This is a hand-written declaration file, not a compiled build artifact —
 * this project ships plain JS with no TypeScript build step (see
 * CONTRIBUTING.md). It exists purely so TypeScript consumers (and editors)
 * get accurate types; the `.js` files in this directory carry their own
 * JSDoc `@typedef {import('./types.d.ts').Foo}` references back into this
 * file, the same pattern `src/fingerprint/types.d.ts` and `src/index.d.ts`
 * already use.
 */

/** One model's per-million-token pricing. See src/cost/pricing.js. */
export interface ModelPricing {
  /** USD cost per 1,000,000 input tokens. */
  readonly inputPer1M: number;
  /** USD cost per 1,000,000 output tokens. */
  readonly outputPer1M: number;
  readonly currency: 'USD';
}

/** Maps a normalized model name (see calculateCost() in src/cost/calculator.js) to its pricing. */
export type PricingTable = Record<string, ModelPricing>;

/** Result of a successful {@link UsageExtractor} call — see src/cost/extractor.js. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** inputTokens + outputTokens. */
  readonly totalTokens: number;
  /** Present only when the extractor found a model name (result.model / result.usage.model / result._meta.model). */
  readonly model?: string;
}

/**
 * Pulls token usage out of an MCP tool result. Must never throw — return
 * `null` for any result shape you don't recognize. See
 * `defaultExtractor` in src/cost/extractor.js for the reference
 * implementation and the conventions it already recognizes.
 */
export type UsageExtractor = (toolResult: unknown) => TokenUsage | null;

/** costTracking.budget — see src/cost/budget.js. Both limits are independent and both optional. */
export interface BudgetConfig {
  /** Cumulative-cost limit (USD) per MCP session id. Calls with no session id are never tracked. */
  readonly perSessionUsd?: number;
  /** Cumulative-cost limit (USD) per tool name. */
  readonly perToolUsd?: number;
}

/** Options for {@link instrumentMcpServer}'s `costTracking` field. */
export interface CostTrackingOptions {
  /**
   * Set to `false` to disable cost/token span attributes and the
   * `mcp.tool.tokens.total` / `mcp.tool.cost.total` metrics entirely.
   *
   * @default true
   */
  enabled?: boolean;

  /**
   * Overrides `DEFAULT_PRICING`. Supply your own table to price models it
   * doesn't know about, or to correct stale pricing — see
   * src/cost/pricing.js's docblock.
   *
   * @default DEFAULT_PRICING
   */
  pricingTable?: PricingTable;

  /**
   * Overrides `defaultExtractor`. Supply your own to recognize a tool
   * result shape it doesn't.
   *
   * @default defaultExtractor
   */
  extractor?: UsageExtractor;

  /**
   * Per-session and per-tool cumulative-cost guardrails. Observability
   * only — crossing a limit adds `mcp.tool.cost.budget_exceeded` /
   * `mcp.tool.cost.budget_scope` span attributes; it never blocks or
   * throws. Omit to disable budget tracking (the default).
   */
  budget?: BudgetConfig;
}
