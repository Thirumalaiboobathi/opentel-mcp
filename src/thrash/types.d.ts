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

/**
 * Resolved Agent Thrash Detection config — see src/thrash/config.js's
 * `resolveThrashConfig()`, which this mirrors field-for-field. All fields
 * are required here (this is the RESOLVED shape, after defaults/env vars
 * have been applied); {@link instrumentMcpServer}'s `thrashDetection`
 * option accepts `Partial<ThrashConfig>` — see src/index.d.ts.
 */
export interface ThrashConfig {
  /** `false` disables thrash detection entirely. @default true */
  enabled: boolean;
  /** Consecutive same-fingerprint failures required to trigger detection. @default 3 */
  threshold: number;
  /** Failures must fall inside this rolling window (ms) to count toward the same loop. @default 60000 */
  windowMs: number;
  /** LRU cap on the bounded store (src/thrash/store.js). @default 1000 */
  maxTrackedKeys: number;
  /** How long (ms) an idle tracked key survives before lazy/swept expiry. @default 900000 */
  entryTtlMs: number;
  /**
   * Re-emit every N further failures past `threshold` (e.g. threshold 3, reEmitAfter 3 -> emits at 3, 6,
   * 9, ...) instead of once per failure.
   *
   * @default 3
   */
  reEmitAfter: number;
  /**
   * `false` (the default) means the generated per-connection fallback session id is only used when the
   * transport is reliably determined to be single-connection (e.g. stdio — no `sessionId` property on
   * `server.transport`). Set to `true` to force-permit the fallback even when the transport can't be
   * determined — an explicit opt-in for deployments the auto-detection can't see (e.g. a custom Transport
   * implementation), where every connection is already known to be 1:1. See the README's "Agent Thrash
   * Detection" section — getting this wrong on a multi-client transport merges unrelated clients' failures
   * into false-positive loops.
   *
   * @default false
   */
  assumeSingleSession: boolean;
}

/**
 * Tracked state for one {@link ThrashKey}, held in the bounded store.
 * Internal — never part of the public API surface (not re-exported from
 * src/index.d.ts); documented here purely so this file stays an accurate
 * description of the actual runtime shape in src/thrash/detector.js.
 */
export interface ThrashEntry {
  /** Redundant with the ThrashKey (which embeds it), kept directly on the entry so getSummary() (v0.6.0) doesn't need to parse the key string. */
  toolName: string;
  /** Same reasoning as toolName above. */
  fingerprint: string;
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
  /**
   * getSummary() (v0.6.0) bookkeeping: tokensIn as of this episode's last
   * emission (0 before the first). Lets record() add only the DELTA to
   * ThrashSummary's cumulative totalWastedTokensIn on a re-emission,
   * rather than double-counting the same early calls on every re-emit.
   */
  contributedTokensIn: number;
  /** Same as contributedTokensIn, for tokensOut. */
  contributedTokensOut: number;
  /** Same as contributedTokensIn, for costUsd. */
  contributedCostUsd: number;
}

/** Result of a {@link ThrashKey} crossing a detection threshold — see src/thrash/detector.ts. */
export interface ThrashDetectedEvent {
  /** The session this loop belongs to — already part of the ThrashKey, just surfaced here too. */
  sessionId: string;
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

/** One entry in {@link ThrashSummary}'s `topOffenders` list — see `ThrashDetector.getSummary()`. */
export interface ThrashOffender {
  toolName: string;
  fingerprint: string;
  /** Consecutive same-fingerprint failures so far — this offender's current loop length. */
  loops: number;
  /** Cumulative estimated USD cost burned by this loop so far. */
  wastedCostUsd: number;
  /** Cumulative input tokens burned by this loop so far. */
  wastedTokensIn: number;
  /** Cumulative output tokens burned by this loop so far. */
  wastedTokensOut: number;
}

/**
 * Point-in-time, in-process summary returned by `ThrashDetector.getSummary()`
 * / `instrumentMcpServer()`'s returned `getThrashSummary()` — no OTel
 * involved, nothing sent anywhere. See the README's "Agent Thrash
 * Detection" → "In-process summary" section for the `activeLoops` vs.
 * `totalLoopsDetected` distinction (bounded-by-`maxTrackedKeys` snapshot
 * vs. cumulative, eviction/TTL-surviving counters).
 */
export interface ThrashSummary {
  /** Loops currently in the bounded store that have crossed the detection threshold. Bounded by `maxTrackedKeys` — NOT a complete history. */
  activeLoops: number;
  /** Cumulative count of distinct loop episodes detected since construction (or the last `reset()`). Survives LRU eviction and TTL expiry. */
  totalLoopsDetected: number;
  /** Cumulative estimated USD cost across every detected loop. Survives LRU eviction and TTL expiry. */
  totalWastedCostUsd: number;
  /** Cumulative input tokens across every detected loop. Survives LRU eviction and TTL expiry. */
  totalWastedTokensIn: number;
  /** Cumulative output tokens across every detected loop. Survives LRU eviction and TTL expiry. */
  totalWastedTokensOut: number;
  /** Up to N currently-active loops (see `activeLoops`), sorted by `wastedCostUsd` descending. @default N=5, see `getSummary({ topOffendersLimit })`. */
  topOffenders: readonly ThrashOffender[];
}
