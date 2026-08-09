/**
 * @module schema-drift/store
 *
 * A bounded, access-order LRU map — no TTL, no timers. Deliberately
 * simpler than thrash/store.js's `BoundedTtlMap`: that store needs
 * time-based expiry because session ids are numerous and effectively
 * unbounded over a long-lived stdio process (see its own docblock). A
 * (scope, toolName) entry here never goes "stale" on its own — the same
 * tool keeps having *a* current schema for as long as it's registered —
 * so there is no notion of an idle entry to reclaim by TTL, only a hard
 * cap on total entry count.
 *
 * ADR 010 (docs/adr/010-schema-drift.md, Q4) found that, for the normal
 * case, a plain unbounded `Map` would already be safe — a server's own
 * tool count is small and bounded by its own registry, unlike session
 * ids. The cap here is defense-in-depth on top of that finding, not a
 * response to an expected failure mode: same bounded-state discipline
 * this project applies to every other long-lived per-server store
 * (thrash detection, cost budgets), not a sign this one is expected to
 * need it in practice.
 */

export class BoundedMap {
  /** @type {Map<K, V>} */
  #map = new Map();
  #maxSize;

  /** @param {number} maxSize - Hard cap on entry count. Least-recently-used entries are evicted past this. */
  constructor(maxSize) {
    this.#maxSize = maxSize;
  }

  /** Current entry count. */
  get size() {
    return this.#map.size;
  }

  /**
   * @param {K} key
   * @returns {V | undefined}
   */
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    // Access-order LRU: re-inserting moves this key to the end of Map's
    // iteration order (its most-recently-used position) — same technique
    // as thrash/store.js's BoundedTtlMap.get().
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  /**
   * @param {K} key
   * @param {V} value
   * @returns {void}
   */
  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);

    while (this.#map.size > this.#maxSize) {
      const oldestKey = this.#map.keys().next().value;
      this.#map.delete(oldestKey);
    }
  }

  /**
   * @param {K} key
   * @returns {boolean} Whether the key was present (and is now removed).
   */
  delete(key) {
    return this.#map.delete(key);
  }
}
