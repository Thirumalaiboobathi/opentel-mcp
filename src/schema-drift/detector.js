/**
 * @module schema-drift/detector
 *
 * Pure tool schema drift detection logic — no OTel emission, no MCP
 * wiring (ADR 010, docs/adr/010-schema-drift.md — Phase 2: detection
 * logic only). Composes Phase 1's capture/canonicalization
 * (compose.js's captureToolSchema()) with structural diffing (diff.js)
 * into "does this tool's inputSchema differ from what we last saw for
 * it," entirely as plain function calls testable in isolation — same
 * shape as thrash/detector.js's ThrashDetector.
 *
 * State is per-server, not per-session (ADR 010, Q4): `capture()` takes
 * an explicit `scope` argument rather than a session id, and nothing in
 * this module computes or requires anything session-shaped. ADR 010
 * found that keying by session would be actively wrong here (not just
 * unnecessary) — every client session connected to one server instance
 * sees the exact same tool registry, so a session-keyed store would
 * produce a spurious "cold start" for every new session and could
 * silently swallow drift that happened between two sessions. The real
 * value a later wiring phase passes for `scope` is expected to be
 * constant for the lifetime of one instrumented server (this module
 * doesn't decide or assume what that value is — it only requires that
 * whatever's passed identifies "this server" consistently across calls);
 * `scope` is an explicit parameter here (rather than hardcoded) so this
 * class stays testable without needing a real server instance per test.
 */

import { captureToolSchema } from './compose.js';
import { diffSchemas } from './diff.js';
import { BoundedMap } from './store.js';

/** @typedef {import('./diff.js').SchemaDriftKind} SchemaDriftKind */
/** @typedef {import('./types.d.ts').SchemaDriftEvent} SchemaDriftEvent */
/** @typedef {import('./types.d.ts').SchemaDriftDetectorOptions} SchemaDriftDetectorOptions */

// Defense-in-depth cap, not a response to an expected failure mode — see
// store.js's docblock. A server's own tool count is normally small; this
// exists so a pathological number of distinct (scope, tool) pairs can't
// grow this store's memory unbounded, mirroring thrash/config.js's
// maxTrackedKeys default for the same reason.
const DEFAULT_MAX_TRACKED_TOOLS = 1000;

/**
 * @param {string} scope
 * @param {string} toolName
 * @returns {string}
 */
function keyFor(scope, toolName) {
  return `${scope}|${toolName}`;
}

export class SchemaDriftDetector {
  /** @type {BoundedMap<string, import('./types.d.ts').ToolSchemaSnapshot>} */
  #store;

  /** @param {SchemaDriftDetectorOptions} [options] */
  constructor(options = {}) {
    const maxTrackedTools = options.maxTrackedTools ?? DEFAULT_MAX_TRACKED_TOOLS;
    this.#store = new BoundedMap(maxTrackedTools);
  }

  /**
   * Captures one tool's current `inputSchema` and returns a
   * {@link SchemaDriftEvent} when it differs from the last-seen schema
   * for this exact `(scope, toolName)`, else `null`. Never throws — any
   * unexpected input or internal error resolves to `null`, the same
   * fail-open philosophy `ThrashDetector.record()` (thrash/detector.js)
   * and `computeFingerprint()` (fingerprint/compose.js) already follow.
   *
   * Cold start is not drift (ADR 010): the first time a given
   * `(scope, toolName)` is captured, there is nothing to compare against
   * yet, so it's recorded silently and this returns `null`. A tool that
   * stops being captured for a while (removed from a tools/list
   * response) and later reappears is compared against whatever was last
   * stored for it, not treated as a fresh cold start — this falls out
   * naturally from the store never being cleared between captures, not
   * from any special-case removal/re-add handling.
   *
   * @param {string} scope - Identifies which server this capture belongs
   *   to (ADR 010, Q4) — never a session id. See this module's docblock.
   * @param {{ name?: unknown, inputSchema?: unknown }} tool - One entry
   *   from a tools/list response's `tools` array.
   * @returns {SchemaDriftEvent | null}
   */
  capture(scope, tool) {
    try {
      const snapshot = captureToolSchema(tool);
      if (snapshot === null) return null;

      const key = keyFor(scope, snapshot.toolName);
      const previous = this.#store.get(key);

      if (previous === undefined) {
        // First observation ever for this (scope, toolName) — cold
        // start, not drift.
        this.#store.set(key, snapshot);
        return null;
      }

      if (previous.hash === snapshot.hash) {
        // Unchanged. previous was already moved to the MRU position by
        // the #store.get() above; nothing else to update.
        return null;
      }

      let diff;
      try {
        diff = diffSchemas(JSON.parse(previous.canonical), JSON.parse(snapshot.canonical));
      } catch {
        diff = { kind: 'unknown', addedFields: [], removedFields: [], changedFields: [], requiredChanged: false };
      }

      this.#store.set(key, snapshot);

      return {
        scope,
        toolName: snapshot.toolName,
        previousHash: previous.hash,
        currentHash: snapshot.hash,
        kind: diff.kind,
        addedFields: diff.addedFields,
        removedFields: diff.removedFields,
        changedFields: diff.changedFields,
        requiredChanged: diff.requiredChanged,
      };
    } catch {
      return null;
    }
  }

  /** Current number of distinct (scope, toolName) pairs being tracked. Bounded by maxTrackedTools. */
  get size() {
    return this.#store.size;
  }
}
