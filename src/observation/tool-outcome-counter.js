/**
 * @module observation/tool-outcome-counter
 *
 * A new, unconditional, process-lifetime counter of tool-call outcomes
 * (ADR 008, docs/adr/008-observation-liveness.md — "Update (2026-08-05):
 * The two-axis reframe", Finding 3). Backs the `ToolOutcome` half of the
 * two-axis observation contract. Phase 1 of the rollout: this counter
 * only — no `ObservationIntegrity` detection (Phase 2), no
 * `getObservationState()` accessor (a later phase), no wiring into
 * `instrumentMcpServer()`/`wrapToolCallHandler` (a later phase).
 *
 * Deliberately NOT built on `ThrashDetector`/`getThrashSummary()`: that
 * bookkeeping only records anything when a fingerprint was computed
 * (`instrument.js`'s `applyThrashDetection()`, gated on
 * `fingerprintingEnabled`), so with `fingerprinting: false` — a fully
 * supported, documented configuration, not an edge case — it would
 * silently report zero failures regardless of how many actually
 * occurred. That's the exact silent-success failure mode this whole
 * feature exists to close, just relocated into the "fix." This counter
 * has no constructor options and no method parameters referencing
 * `fingerprinting`, `thrashDetection`, or `enableMetrics` at all — there
 * is structurally no way for any of those flags to reach it. The only
 * thing that can stop it from counting a call is instrumentation being
 * disabled entirely (`resolved.enabled === false`), and that is enforced
 * by whichever future wiring phase decides not to construct or call this
 * counter at all in that case — not by anything in this module.
 *
 * In-memory, process-lifetime, cumulative — no per-session or per-tool
 * breakdown in this phase. No OTel emission here either; this is the
 * pure bookkeeping layer only.
 */

/** @typedef {import('./types.d.ts').ToolOutcomeCounts} ToolOutcomeCounts */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ToolOutcomeCounter {
  #success = 0;
  #failure = 0;
  #unknown = 0;

  /**
   * Records the outcome of a tool call whose handler threw or rejected —
   * always FAILURE, unconditionally. A thrown/rejected call is
   * unambiguous evidence of failure regardless of what shape the thrown
   * value has, so nothing about the error itself needs inspecting.
   * Incrementing a private class field cannot throw, so — unlike
   * recordResult() below — this method needs no defensive try/catch;
   * there is nothing here that can fail.
   *
   * @returns {void}
   */
  recordThrown() {
    this.#failure++;
  }

  /**
   * Records the outcome of a tool call whose handler resolved with
   * `result`. Never throws.
   *
   * Classification — PROPOSED, flagged for confirmation (see this
   * module's own docblock and the accompanying report): the ADR
   * specifies reusing `wrapToolCallHandler`'s existing
   * `isToolResultError(result)` check (`result?.isError === true`) for
   * the FAILURE/SUCCESS distinction, but does not pin down a concrete
   * trigger for UNKNOWN beyond "the bookkeeping mechanism itself
   * couldn't run." This implementation adds exactly one new branch
   * beyond that existing check:
   *
   *   - `result` is a plain object with `isError === true` -> FAILURE
   *     (mirrors `isToolResultError()` exactly).
   *   - `result` is a plain object without `isError === true` -> SUCCESS
   *     (mirrors `isToolResultError()` exactly).
   *   - `result` is NOT a plain object (`null`, `undefined`, a
   *     primitive, an array) -> UNKNOWN. A value that couldn't possibly
   *     be a real `CallToolResult` at all is genuinely ambiguous, not
   *     confidently a success — silently defaulting it to SUCCESS (which
   *     `isToolResultError()` alone would do, since `null?.isError` is
   *     `undefined`, not `true`) would be exactly the "imply success by
   *     omission" failure mode this whole feature exists to close.
   *
   * A malformed `result` whose `isError` getter itself throws (e.g. a
   * pathological Proxy) is caught by the try/catch below and also counts
   * as UNKNOWN — the one case where this method's own logic, not just
   * the tool's result shape, could fail.
   *
   * @param {unknown} result
   * @returns {void}
   */
  recordResult(result) {
    try {
      if (!isPlainObject(result)) {
        this.#unknown++;
        return;
      }

      if (result.isError === true) {
        this.#failure++;
      } else {
        this.#success++;
      }
    } catch {
      this.#unknown++;
    }
  }

  /**
   * @returns {ToolOutcomeCounts} Cumulative counts since construction.
   */
  getCounts() {
    return { success: this.#success, failure: this.#failure, unknown: this.#unknown };
  }
}
