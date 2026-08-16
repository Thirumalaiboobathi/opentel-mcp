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

/** A chat/completion model's per-million-token pricing — has an output-token cost. See src/cost/pricing.js. */
export interface ChatModelPricing {
  readonly pricingKind: 'chat';
  /** USD cost per 1,000,000 input tokens. */
  readonly inputPer1M: number;
  /** USD cost per 1,000,000 output tokens. */
  readonly outputPer1M: number;
  readonly currency: 'USD';
}

/**
 * An embedding model's per-million-token pricing — input-token-only. No
 * `outputPer1M` field: embeddings have no output-token cost, and omitting
 * the field (rather than setting it to 0) makes that explicit instead of
 * indistinguishable from a data-entry bug. See ADR 016
 * (`docs/adr/016-pricing-override-and-staleness.md`) point 1.
 */
export interface EmbeddingModelPricing {
  readonly pricingKind: 'embedding';
  /** USD cost per 1,000,000 input tokens. */
  readonly inputPer1M: number;
  readonly currency: 'USD';
}

/** One model's per-million-token pricing. See src/cost/pricing.js. */
export type ModelPricing = ChatModelPricing | EmbeddingModelPricing;

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
   * Fully replaces `DEFAULT_PRICING` (or, if `pricing` below is also set,
   * replaces the *base* table `pricing` is then merged over) — supply your
   * own table when you want an effective pricing table that contains only
   * your own models, none of `DEFAULT_PRICING`'s. For the more common case
   * of correcting or adding a few models while keeping the rest of
   * `DEFAULT_PRICING`, prefer `pricing` instead. See ADR 016
   * (`docs/adr/016-pricing-override-and-staleness.md`) point 2 for why both
   * exist and how they compose.
   *
   * @default DEFAULT_PRICING
   */
  pricingTable?: PricingTable;

  /**
   * Partial pricing table, merged per-model OVER `pricingTable ??
   * DEFAULT_PRICING` — each key you supply replaces that one model's
   * entire `ModelPricing` entry; every model you don't name is untouched.
   * This is the recommended way to correct stale pricing or add a model
   * `DEFAULT_PRICING` doesn't know about, without having to spread the
   * whole default table yourself. A model priced via this option (or via
   * `pricingTable`) reports `pricing_status: 'user_override'` on
   * `mcp.tool.pricing_status` rather than `'known'`. See ADR 016 point 2.
   *
   * @default undefined
   */
  pricing?: Partial<PricingTable>;

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
