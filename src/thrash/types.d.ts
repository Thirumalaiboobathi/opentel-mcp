/**
 * Shared type definitions for Agent Thrash Detection (v0.6.0).
 *
 * This is a hand-written declaration file, not a compiled build artifact —
 * this project ships plain JS with no TypeScript build step (see
 * CONTRIBUTING.md). It exists purely so TypeScript consumers (and editors)
 * get accurate types; the `.js` files in this directory carry their own
 * JSDoc `@typedef {import('./types.d.ts').Foo}` references back into this
 * file, the same pattern `src/fingerprint/types.d.ts` and
 * `src/cost/types.d.ts` already use.
 */

/**
 * Composite key identifying one (session, tool, failure-fingerprint) loop
 * candidate inside the bounded store (src/thrash/store.ts). Format:
 * `${sessionId}|${toolName}|${fingerprint}`.
 */
export type ThrashKey = string;

/** Tracked state for one {@link ThrashKey}, held in the bounded store. */
export interface ThrashEntry {
  /** How many consecutive same-fingerprint failures have been recorded in the current window/episode. */
  count: number;
  /** Epoch ms of the first failure in the current episode. */
  firstSeenAt: number;
  /** Epoch ms of the most recent failure in the current episode. */
  lastSeenAt: number;
  /** Span id of the first failure — anchors ThrashDetectedEvent back to where the loop started. */
  firstSpanId: string;
  /** Trace id of the first failure. */
  firstTraceId: string;
  /** Cumulative input tokens across every failure in the current episode. */
  tokensIn: number;
  /** Cumulative output tokens across every failure in the current episode. */
  tokensOut: number;
  /** Cumulative estimated USD cost across every failure in the current episode. */
  costUsd: number;
  /** Whether a {@link ThrashDetectedEvent} has already fired at least once for this episode. */
  emitted: boolean;
}

/** Result of a {@link ThrashKey} crossing a detection threshold — see src/thrash/detector.ts. */
export interface ThrashDetectedEvent {
  toolName: string;
  fingerprint: string;
  /** Number of consecutive same-fingerprint failures that make up this loop, at the moment of emission. */
  loopLength: number;
  /** Cumulative input tokens burned across the whole loop so far. */
  wastedTokensIn: number;
  /** Cumulative output tokens burned across the whole loop so far. */
  wastedTokensOut: number;
  /** Cumulative estimated USD cost burned across the whole loop so far. */
  wastedCostUsd: number;
  /** Elapsed ms between the loop's first and most recent failure. */
  durationMs: number;
  /** Span id of the loop's first failure. */
  firstSpanId: string;
  /** Trace id of the loop's first failure. */
  firstTraceId: string;
}
