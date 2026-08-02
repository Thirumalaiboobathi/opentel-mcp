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

// Mirrors src/fingerprint/compose.js's buildFallback() — that module
// inlines the same literal rather than exporting it, so it's repeated
// here rather than importing across an unrelated internal. This value
// means "fingerprinting itself failed," not "a real, specific failure" —
// treating it as trackable would collapse every unrelated unfingerprintable
// failure across every tool/session into one bogus shared loop.
const FALLBACK_FINGERPRINT = '0000000000000000';

/**
 * @param {unknown} value
 * @returns {number} `value` if it's a finite number, else 0 — matches src/cost/budget.js's
 *   never-poison-the-total approach to bad accumulator input.
 */
function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class ThrashDetector {
  #config;
  #clock;
  /** @type {BoundedTtlMap<string, ThrashEntry>} */
  #store;
  /** @type {BoundedTtlMap<string, string>} keyed `${sessionId}|${toolName}` -> the fingerprint currently accumulating for it. */
  #activeFingerprint;

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

      /** @type {ThrashEntry} */
      let entry;
      if (existing === undefined || now - existing.firstSeenAt > this.#config.windowMs) {
        // Absent, or the window slid since the first failure in the old
        // episode — either way this is a fresh episode, not a continuation.
        entry = {
          count: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          firstSpanId: spanId,
          firstTraceId: traceId,
          tokensIn: toFiniteNumber(tokensIn),
          tokensOut: toFiniteNumber(tokensOut),
          costUsd: toFiniteNumber(costUsd),
          emitted: false,
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

      this.#store.set(key, entry);
      this.#activeFingerprint.set(`${sessionId}|${toolName}`, fingerprint);

      if (!shouldEmit) return null;

      return {
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

  /** Discards all tracked state. Never throws. */
  reset() {
    try {
      this.#store = new BoundedTtlMap(this.#config.maxTrackedKeys, this.#config.entryTtlMs, this.#clock);
      this.#activeFingerprint = new BoundedTtlMap(this.#config.maxTrackedKeys, this.#config.entryTtlMs, this.#clock);
    } catch {
      // Never throw — see record()'s docblock for why.
    }
  }
}
