/**
 * @module tool-integrity/tracker
 *
 * Pure tool definition integrity tracking (ADR 029): no OTel, no MCP wiring. State is per server instance (not per
 * session; every session sees the same registry, ADR 010 Q4). Events are edge-triggered: they fire when a tool's
 * classification changes, so a persistent mismatch is reported once per distinct hash, not on every tools/list.
 */

import { computeToolDefinitionHash } from './hash.js';
import { MAX_TRACKED_TOOLS } from './config.js';

/**
 * @typedef {{ name: string, attributes: Record<string, string> }} IntegrityEvent
 * @typedef {object} Observation
 * @property {{ kind: 'changed' | 'pin_mismatch' | 'added' | 'removed', tool: string, oldHash?: string, newHash?: string, expected?: string, actual?: string }[]} findings
 * @property {string[]} violationTools - Tools that newly reported `changed` and/or `pin_mismatch` (once each).
 * @property {Record<string, string> | null} firstSnapshot - The hashes of the first observation that produced any; otherwise null.
 */

export class ToolIntegrityTracker {
  /** @type {Map<string, { first: string, last: string, reportedChanged: string | null, reportedPin: string | null }>} */
  #tools = new Map();
  /** Tool names of the last COMPLETE (unpaginated) listing, or null before one has been seen. */
  /** @type {Set<string> | null} */
  #present = null;
  /** @type {Map<string, string>} */
  #current = new Map();
  #snapshotTaken = false;
  #pins;

  /** @param {Map<string, string>} pins */
  constructor(pins) {
    this.#pins = pins;
  }

  /**
   * Observes one tools/list response. Never throws.
   *
   * @param {unknown} tools - `result.tools`
   * @param {boolean} complete - True when this response is the whole listing (no cursor in, no nextCursor out).
   * @returns {Observation}
   */
  observe(tools, complete) {
    /** @type {Observation} */
    const out = { findings: [], violationTools: [], firstSnapshot: null };
    try {
      const list = Array.isArray(tools) ? tools : [];
      const seenNow = new Set();
      const limit = Math.min(list.length, MAX_TRACKED_TOOLS);
      for (let i = 0; i < limit; i++) {
        const tool = list[i];
        let name;
        try {
          name = tool?.name;
        } catch {
          continue;
        }
        if (typeof name !== 'string' || name.length === 0) continue;
        const hash = computeToolDefinitionHash(tool);
        if (hash === null) continue;
        seenNow.add(name);
        this.#current.set(name, hash);

        let entry = this.#tools.get(name);
        if (!entry) {
          if (this.#tools.size >= MAX_TRACKED_TOOLS) continue;
          entry = { first: hash, last: hash, reportedChanged: null, reportedPin: null };
          this.#tools.set(name, entry);
        }

        let violated = false;
        if (hash !== entry.first) {
          if (hash !== entry.reportedChanged) {
            out.findings.push({ kind: 'changed', tool: name, oldHash: entry.first, newHash: hash });
            entry.reportedChanged = hash;
            violated = true;
          }
        } else {
          entry.reportedChanged = null;
        }

        const pin = this.#pins.get(name);
        if (pin !== undefined) {
          if (hash !== pin) {
            if (hash !== entry.reportedPin) {
              out.findings.push({ kind: 'pin_mismatch', tool: name, expected: pin, actual: hash });
              entry.reportedPin = hash;
              violated = true;
            }
          } else {
            entry.reportedPin = null;
          }
        }
        if (violated) out.violationTools.push(name);

        // Not in the previous complete listing (new, or back after being absent): added.
        if (complete && this.#present !== null && !this.#present.has(name)) {
          out.findings.push({ kind: 'added', tool: name, newHash: hash });
        }
        entry.last = hash;
      }

      if (complete) {
        if (this.#present !== null) {
          for (const name of this.#present) {
            if (!seenNow.has(name)) {
              out.findings.push({ kind: 'removed', tool: name, oldHash: this.#tools.get(name)?.last });
              this.#current.delete(name);
            }
          }
        }
        this.#present = seenNow;
      }

      if (!this.#snapshotTaken && complete && this.#current.size > 0) {
        this.#snapshotTaken = true;
        out.firstSnapshot = this.getHashes();
      }
    } catch {
      // never throw into tools/list
    }
    return out;
  }

  /** The current `{ toolName: hash }` map from the latest observations. */
  getHashes() {
    return Object.fromEntries(this.#current);
  }
}
