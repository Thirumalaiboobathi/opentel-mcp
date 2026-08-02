/**
 * @module thrash/detector
 * Pure Agent Thrash Detection logic — no OTel emission, no MCP wiring.
 * Composes v0.4's failure fingerprinting (the `fingerprint` input) and
 * v0.5's token/cost tracking (`tokensIn`/`tokensOut`/`costUsd`) into "the
 * same tool failed with the same fingerprint N times in a row" detection,
 * entirely as plain function calls testable in isolation.
 *
 * State lives in two src/thrash/store.js BoundedTtlMap instances (bounded
 * memory — see that module's docblock), never a plain object/Map, so a
 * long-lived stdio server can't accumulate unbounded per-session state.
 */

import { BoundedTtlMap } from './store.js';

/** @typedef {import('./config.js').ThrashConfig} ThrashConfig */
/** @typedef {import('./types.d.ts').ThrashEntry} ThrashEntry */
/** @typedef {import('./types.d.ts').ThrashDetectedEvent} ThrashDetectedEvent */
/** @typedef {import('./types.d.ts').ThrashSummary} ThrashSummary */
/** @typedef {import('./types.d.ts').ThrashOffender} ThrashOffender */

/**
 * @typedef {object} ThrashRecordInput
 * @property {string} sessionId
 * @property {string} toolName
 * @property {string} fingerprint - mcp.failure.fingerprint (src/fingerprint/attributes.js).
 * @property {string} spanId
 * @property {string} traceId
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} costUsd
 */

/**
 * @typedef {object} GetSummaryOptions
 * @property {number} [topOffendersLimit=5] - Max entries in the returned topOffenders list.
 */

// Mirrors src/fingerprint/compose.js's buildFallback() — that module
// inlines the same literal rather than exporting it, so it's repeated
// here rather than importing across an unrelated internal. This value
// means "fingerprinting itself failed," not "a real, specific failure" —
// treating it as trackable would collapse every unrelated unfingerprintable
// failure across every tool/session into one bogus shared loop.
const FALLBACK_FINGERPRINT = '0000000000000000';

const DEFAULT_TOP_OFFENDERS_LIMIT = 5;

/**
 * @param {unknown} value
 * @returns {number} `value` if it's a finite number, else 0 — matches src/cost/budget.js's
 *   never-poison-the-total approach to bad accumulator input.
 */
function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @returns {ThrashSummary} All-zero summary — the disabled/error/never-recorded-anything shape. */
function zeroSummary() {
  return {
    activeLoops: 0,
    totalLoopsDetected: 0,
    totalWastedCostUsd: 0,
    totalWastedTokensIn: 0,
    totalWastedTokensOut: 0,
    topOffenders: [],
  };
}

export class ThrashDetector {
  #config;
  #clock;
  /** @type {BoundedTtlMap<string, ThrashEntry>} */
  #store;
  /** @type {BoundedTtlMap<string, string>} keyed `${sessionId}|${toolName}` -> the fingerprint currently accumulating for it. */
  #activeFingerprint;

  // Cumulative, process-lifetime counters for getSummary() — deliberately
  // NOT derived from #store (which is bounded and lazily-expiring, so a
  // live scan would silently lose evicted/expired episodes). Incremented
  // at emit time in record() below; see that method for how double-
  // counting across re-emissions of the same loop is avoided. reset()
  // zeroes these too, same as the store.
  #totalLoopsDetected = 0;
  #totalWastedTokensIn = 0;
  #totalWastedTokensOut = 0;
  #totalWastedCostUsd = 0;

  /**
   * @param {ThrashConfig} config
   * @param {() => number} [clock] - Returns "now" in epoch ms. Injectable for deterministic tests.
   */
  constructor(config, clock = () => Date.now()) {
    this.#config = config;
    this.#clock = clock;
    this.#store = new BoundedTtlMap(config.maxTrackedKeys, config.entryTtlMs, clock);
    this.#activeFingerprint = new BoundedTtlMap(config.maxTrackedKeys, config.entryTtlMs, clock);
  }

  /**
   * Records one tool-call failure and returns a {@link ThrashDetectedEvent}
   * when it just crossed a detection threshold, else `null`. Never throws
   * — any unexpected input or internal error resolves to `null`, matching
   * this library's fail-open philosophy (see src/cost/extractor.js and
   * src/fingerprint/compose.js for the same pattern elsewhere).
   *
   * @param {ThrashRecordInput} input
   * @returns {ThrashDetectedEvent | null}
   */
  record(input) {
    try {
      if (!this.#config.enabled) return null;

      const { sessionId, toolName, fingerprint, spanId, traceId, tokensIn, tokensOut, costUsd } = input ?? {};

      if (fingerprint === FALLBACK_FINGERPRINT) return null;

      const key = `${sessionId}|${toolName}|${fingerprint}`;
      const now = this.#clock();
      const existing = this.#store.get(key);
      // Captured before entry.emitted is (re)computed below: true only if
      // this key had ALREADY crossed the threshold in a prior call. Used
      // to count totalLoopsDetected once per distinct episode, not once
      // per re-emission — see below.
      const wasAlreadyEmitted = existing?.emitted ?? false;

      /** @type {ThrashEntry} */
      let entry;
      if (existing === undefined || now - existing.firstSeenAt > this.#config.windowMs) {
        // Absent, or the window slid since the first failure in the old
        // episode — either way this is a fresh episode, not a continuation.
        entry = {
          toolName,
          fingerprint,
          count: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          firstSpanId: spanId,
          firstTraceId: traceId,
          tokensIn: toFiniteNumber(tokensIn),
          tokensOut: toFiniteNumber(tokensOut),
          costUsd: toFiniteNumber(costUsd),
          emitted: false,
          contributedTokensIn: 0,
          contributedTokensOut: 0,
          contributedCostUsd: 0,
        };
      } else {
        entry = {
          ...existing,
          count: existing.count + 1,
          lastSeenAt: now,
          tokensIn: existing.tokensIn + toFiniteNumber(tokensIn),
          tokensOut: existing.tokensOut + toFiniteNumber(tokensOut),
          costUsd: existing.costUsd + toFiniteNumber(costUsd),
        };
      }

      const { threshold, reEmitAfter } = this.#config;
      const shouldEmit = entry.count >= threshold && (entry.count - threshold) % reEmitAfter === 0;
      entry.emitted = entry.emitted || shouldEmit;

      if (shouldEmit) {
        // Delta since this episode's last emission (0 for a first
        // emission, since contributed* starts at 0), not entry's full
        // cumulative total — a loop that re-emits at count 3, 6, 9 must
        // not have its first-3-calls cost added to the running total
        // three times over. getSummary()'s totalWasted* fields are meant
        // to answer "how much has actually been wasted across every
        // detected loop," not "sum of every emitted event's own
        // snapshot" (those two differ exactly by this double-counting).
        this.#totalWastedTokensIn += entry.tokensIn - entry.contributedTokensIn;
        this.#totalWastedTokensOut += entry.tokensOut - entry.contributedTokensOut;
        this.#totalWastedCostUsd += entry.costUsd - entry.contributedCostUsd;
        entry.contributedTokensIn = entry.tokensIn;
        entry.contributedTokensOut = entry.tokensOut;
        entry.contributedCostUsd = entry.costUsd;
        if (!wasAlreadyEmitted) this.#totalLoopsDetected++;
      }

      this.#store.set(key, entry);
      this.#activeFingerprint.set(`${sessionId}|${toolName}`, fingerprint);

      if (!shouldEmit) return null;

      return {
        sessionId,
        toolName,
        fingerprint,
        loopLength: entry.count,
        wastedTokensIn: entry.tokensIn,
        wastedTokensOut: entry.tokensOut,
        wastedCostUsd: entry.costUsd,
        durationMs: entry.lastSeenAt - entry.firstSeenAt,
        firstSpanId: entry.firstSpanId,
        firstTraceId: entry.firstTraceId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Called on a *successful* tool call — the loop broke. Clears the
   * tracked entry for whichever fingerprint was most recently accumulating
   * for this (sessionId, toolName) pair, so a later failure starts a fresh
   * episode (count 1) instead of continuing the old count.
   *
   * Only the most-recently-active fingerprint is cleared, not every
   * fingerprint ever seen for this tool+session: tracking a full history
   * would need an unbounded-in-the-worst-case set per (session, tool) pair
   * (fingerprints are not a small closed set — see the README's
   * "Cardinality" note on mcp.failure.fingerprint), which would violate
   * the bounded-memory invariant. Any other, less-recently-active
   * fingerprint's entry still expires on its own via TTL/LRU. In practice
   * a given tool is almost always retried under one fingerprint at a time,
   * so this covers the realistic thrash-loop-then-recovery case.
   *
   * Does NOT touch getSummary()'s cumulative totals: whatever was already
   * emitted for this episode was genuinely wasted regardless of the
   * eventual success, so it stays counted.
   *
   * Never throws.
   *
   * @param {string} sessionId
   * @param {string} toolName
   */
  clearOnSuccess(sessionId, toolName) {
    try {
      const indexKey = `${sessionId}|${toolName}`;
      const fingerprint = this.#activeFingerprint.get(indexKey);
      if (fingerprint === undefined) return;

      this.#store.delete(`${sessionId}|${toolName}|${fingerprint}`);
      this.#activeFingerprint.delete(indexKey);
    } catch {
      // Never throw — see record()'s docblock for why.
    }
  }

  /**
   * A point-in-time, in-process summary — no OTel involved, nothing sent
   * anywhere, safe to call from application code (e.g. a health-check
   * endpoint or a periodic console.log) or a debugger. Pure read: never
   * mutates #store/#activeFingerprint or the cumulative counters, and has
   * no effect on record()/clearOnSuccess()'s hot path. Never throws —
   * degrades to an all-zero summary (also what a detector constructed
   * with `enabled: false` naturally produces, since record() never writes
   * anything in that case) on any unexpected error.
   *
   * `activeLoops` and `topOffenders` reflect only what's CURRENTLY in the
   * bounded store — bounded by `maxTrackedKeys`, so a busy server can
   * silently be tracking more loops than the store has room to admit, and
   * TTL/LRU eviction can drop an old loop entirely (see
   * src/thrash/store.js). `totalLoopsDetected`/`totalWasted*` are
   * cumulative counters that survive both, by design (see record()).
   *
   * @param {GetSummaryOptions} [options]
   * @returns {ThrashSummary}
   */
  getSummary(options) {
    try {
      if (!this.#config.enabled) return zeroSummary();

      const rawLimit = options?.topOffendersLimit;
      const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 0
          ? Math.floor(rawLimit)
          : DEFAULT_TOP_OFFENDERS_LIMIT;

      let activeLoops = 0;
      /** @type {ThrashOffender[]} */
      const offenders = [];

      for (const [, entry] of this.#store.entries()) {
        if (!entry.emitted) continue; // hasn't crossed threshold — not (yet) an active loop
        activeLoops++;
        offenders.push({
          toolName: entry.toolName,
          fingerprint: entry.fingerprint,
          loops: entry.count,
          wastedCostUsd: entry.costUsd,
          wastedTokensIn: entry.tokensIn,
          wastedTokensOut: entry.tokensOut,
        });
      }

      offenders.sort((a, b) => b.wastedCostUsd - a.wastedCostUsd);

      return {
        activeLoops,
        totalLoopsDetected: this.#totalLoopsDetected,
        totalWastedCostUsd: this.#totalWastedCostUsd,
        totalWastedTokensIn: this.#totalWastedTokensIn,
        totalWastedTokensOut: this.#totalWastedTokensOut,
        topOffenders: offenders.slice(0, limit),
      };
    } catch {
      return zeroSummary();
    }
  }

  /** Discards all tracked state, including getSummary()'s cumulative counters. Never throws. */
  reset() {
    try {
      this.#store = new BoundedTtlMap(this.#config.maxTrackedKeys, this.#config.entryTtlMs, this.#clock);
      this.#activeFingerprint = new BoundedTtlMap(this.#config.maxTrackedKeys, this.#config.entryTtlMs, this.#clock);
      this.#totalLoopsDetected = 0;
      this.#totalWastedTokensIn = 0;
      this.#totalWastedTokensOut = 0;
      this.#totalWastedCostUsd = 0;
    } catch {
      // Never throw — see record()'s docblock for why.
    }
  }
}
