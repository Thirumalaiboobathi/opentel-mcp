/**
 * @module thrash/store
 * A bounded, access-order LRU map with lazy TTL expiry.
 *
 * Generic — no OTel, no MCP, no thrash-detection logic lives here. Exists
 * solely so Agent Thrash Detection (v0.6.0) can hold per-(session, tool,
 * fingerprint) state without an unbounded map: long-lived stdio MCP
 * servers run for weeks, so anything keyed by session id must have both a
 * hard cap (LRU eviction) and a way to reclaim idle entries (TTL) without
 * ever registering a timer that would keep the process's event loop
 * alive. See the "Bounded memory" invariant in the v0.6.0 design notes.
 */

const SWEEP_EVERY_N_SETS = 64;

/**
 * @template K, V
 */
export class BoundedTtlMap {
  /** @type {Map<K, { value: V, expiresAt: number }>} */
  #map = new Map();
  #maxSize;
  #ttlMs;
  #clock;
  #setCount = 0;

  /**
   * @param {number} maxSize - Hard cap on entry count. Least-recently-used entries are evicted past this.
   * @param {number} ttlMs - Time-to-live from the moment an entry is set() (get() refreshes LRU order, not TTL).
   * @param {() => number} [clock] - Returns "now" in epoch ms. Injectable for deterministic tests; defaults to Date.now.
   */
  constructor(maxSize, ttlMs, clock = () => Date.now()) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  /** Current entry count. Not lazily purged — may include not-yet-swept expired entries; see get(). */
  get size() {
    return this.#map.size;
  }

  /**
   * @param {K} key
   * @returns {V | undefined} undefined if absent, or present but expired (in which case it's also deleted).
   */
  get(key) {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;

    if (this.#clock() >= entry.expiresAt) {
      this.#map.delete(key);
      return undefined;
    }

    // Access-order LRU: re-inserting moves this key to the end of Map's
    // iteration order (its most-recently-used position). The oldest
    // (least-recently-used) key is always map.keys().next().value.
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  /**
   * @param {K} key
   * @param {V} value
   * @returns {void}
   */
  set(key, value) {
    // Delete-then-set even for an existing key, so it moves to the MRU
    // end rather than keeping its old position with an updated value.
    this.#map.delete(key);
    this.#map.set(key, { value, expiresAt: this.#clock() + this.#ttlMs });

    this.#setCount++;
    // Amortized sweep, not a timer: piggybacks on set() traffic so a
    // low-traffic long-lived process doesn't hold dead keys forever, but
    // nothing here schedules callbacks or keeps the event loop alive.
    if (this.#setCount % SWEEP_EVERY_N_SETS === 0) {
      this.#sweep();
    }

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

  /** Removes every entry whose TTL has passed as of clock(). */
  #sweep() {
    const now = this.#clock();
    for (const [key, entry] of this.#map) {
      if (now >= entry.expiresAt) {
        this.#map.delete(key);
      }
    }
  }
}
