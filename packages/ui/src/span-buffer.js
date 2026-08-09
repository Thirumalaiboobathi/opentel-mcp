/**
 * @module span-buffer
 *
 * A fixed-capacity ring buffer of {@link import('./types.d.ts').SerializedSpan}
 * objects. Bounded memory by construction: once `capacity` is reached, the
 * oldest entry is evicted for every new one added — the buffer never grows
 * past `capacity` entries, however many spans are ever pushed into it over
 * the process's lifetime.
 *
 * Backed by a pre-sized plain array + a write cursor (classic ring-buffer
 * shape), not `Array.prototype.shift()` on an unbounded array — `shift()`
 * is O(n) per call, which would make ingestion cost scale with capacity
 * under sustained load; this stays O(1) per push.
 */

/** @typedef {import('./types.d.ts').SerializedSpan} SerializedSpan */

export const DEFAULT_SPAN_BUFFER_CAPACITY = 1000;

export class SpanBuffer {
  /** @type {(SerializedSpan | undefined)[]} */
  #entries;
  /** Index the NEXT push() will write to. */
  #writeIndex = 0;
  /** Entries pushed since the last clear() (or construction) -- resets on clear(), caps `size`/wrap detection. */
  #pushedSinceClear = 0;
  /** Total entries ever pushed, including evicted ones AND ones since clear()'d away -- a true lifetime counter, used for SSE sequence numbering. Never resets. */
  #totalPushed = 0;

  /**
   * @param {{ capacity?: number }} [options]
   */
  constructor({ capacity = DEFAULT_SPAN_BUFFER_CAPACITY } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SpanBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#entries = new Array(capacity);
  }

  /**
   * Current number of entries actually held (never exceeds `capacity`;
   * resets to 0 on `clear()`, unlike `totalPushed`).
   */
  get size() {
    return Math.min(this.#pushedSinceClear, this.capacity);
  }

  /** Total entries ever pushed, including evicted ones and ones since `clear()`'d away. Never resets -- used as a stable basis for SSE sequence numbers. */
  get totalPushed() {
    return this.#totalPushed;
  }

  /**
   * @param {SerializedSpan} span
   * @returns {void}
   */
  push(span) {
    this.#entries[this.#writeIndex] = span;
    this.#writeIndex = (this.#writeIndex + 1) % this.capacity;
    this.#pushedSinceClear++;
    this.#totalPushed++;
  }

  /**
   * All currently-held spans, oldest first. A snapshot (new array) — safe
   * for a caller to hold onto or serialize without the buffer mutating it
   * underneath them.
   *
   * @returns {SerializedSpan[]}
   */
  toArray() {
    const count = this.size;
    if (count === 0) return [];

    if (this.#pushedSinceClear <= this.capacity) {
      // Never wrapped since the last clear() -- entries [0, count) are in
      // push order already.
      return /** @type {SerializedSpan[]} */ (this.#entries.slice(0, count));
    }

    // Wrapped at least once: the oldest entry is the one #writeIndex is
    // about to overwrite next.
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.#entries[(this.#writeIndex + i) % this.capacity];
    }
    return /** @type {SerializedSpan[]} */ (out);
  }

  /**
   * Removes every entry. Capacity is unchanged; `totalPushed` is NOT
   * reset (it is a lifetime counter, not a size) -- `size` is.
   */
  clear() {
    this.#entries = new Array(this.capacity);
    this.#writeIndex = 0;
    this.#pushedSinceClear = 0;
  }
}
