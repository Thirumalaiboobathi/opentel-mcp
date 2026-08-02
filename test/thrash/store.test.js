import { describe, it, expect, vi } from 'vitest';
import { BoundedTtlMap } from '../../src/thrash/store.js';

/** A mutable, injectable clock: `now.value += x` advances it deterministically, no real waiting. */
function makeClock(start = 0) {
  const state = { now: start };
  return { clock: () => state.now, state };
}

describe('BoundedTtlMap', () => {
  describe('basic get/set/delete', () => {
    it('returns undefined for a key that was never set', () => {
      const store = new BoundedTtlMap(10, 1000, () => 0);
      expect(store.get('missing')).toBeUndefined();
    });

    it('set() then get() round-trips the value', () => {
      const store = new BoundedTtlMap(10, 1000, () => 0);
      store.set('a', 42);
      expect(store.get('a')).toBe(42);
    });

    it('delete() removes an entry and returns true; returns false for a missing key', () => {
      const store = new BoundedTtlMap(10, 1000, () => 0);
      store.set('a', 1);
      expect(store.delete('a')).toBe(true);
      expect(store.get('a')).toBeUndefined();
      expect(store.delete('a')).toBe(false);
    });

    it('size reflects the current entry count', () => {
      const store = new BoundedTtlMap(10, 1000, () => 0);
      expect(store.size).toBe(0);
      store.set('a', 1);
      store.set('b', 2);
      expect(store.size).toBe(2);
      store.delete('a');
      expect(store.size).toBe(1);
    });
  });

  describe('LRU eviction at capacity', () => {
    it('evicts the least-recently-used key when inserting past maxSize', () => {
      const store = new BoundedTtlMap(3, 1_000_000, () => 0);
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);
      store.set('d', 4); // over capacity — 'a' is oldest/untouched, should go

      expect(store.size).toBe(3);
      expect(store.get('a')).toBeUndefined();
      expect(store.get('b')).toBe(2);
      expect(store.get('c')).toBe(3);
      expect(store.get('d')).toBe(4);
    });

    it('get() refreshes recency, changing which key is evicted next', () => {
      const store = new BoundedTtlMap(3, 1_000_000, () => 0);
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);
      store.get('a'); // 'a' is now most-recently-used; 'b' becomes the new LRU
      store.set('d', 4); // should evict 'b', not 'a'

      expect(store.get('b')).toBeUndefined();
      expect(store.get('a')).toBe(1);
      expect(store.get('c')).toBe(3);
      expect(store.get('d')).toBe(4);
    });

    it('set() on an existing key also refreshes recency', () => {
      const store = new BoundedTtlMap(3, 1_000_000, () => 0);
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);
      store.set('a', 100); // re-set 'a' — should move it to MRU, same as get()
      store.set('d', 4); // should evict 'b', not 'a'

      expect(store.get('b')).toBeUndefined();
      expect(store.get('a')).toBe(100);
    });
  });

  describe('lazy TTL expiry', () => {
    it('get() on an expired entry returns undefined', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(10, 1000, clock);
      store.set('a', 1);
      state.now = 1001; // past the 1000ms TTL
      expect(store.get('a')).toBeUndefined();
    });

    it('get() on an entry just before expiry still returns the value', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(10, 1000, clock);
      store.set('a', 1);
      state.now = 999;
      expect(store.get('a')).toBe(1);
    });

    it('an expired entry is removed from size once get() lazily deletes it', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(10, 1000, clock);
      store.set('a', 1);
      expect(store.size).toBe(1);
      state.now = 2000;
      store.get('a');
      expect(store.size).toBe(0);
    });

    it('TTL is anchored to set() time, not extended by get()', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(10, 1000, clock);
      store.set('a', 1);
      state.now = 500;
      expect(store.get('a')).toBe(1); // still alive, and touched
      state.now = 1001; // 1001ms after the original set(), past TTL
      expect(store.get('a')).toBeUndefined();
    });
  });

  describe('amortized sweep', () => {
    it('purges expired entries after 64 set() calls, without any get()', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(1000, 500, clock);
      store.set('a', 1); // expiresAt = 500
      state.now = 600; // 'a' is now expired

      for (let i = 0; i < 63; i++) {
        store.set(`k${i}`, i); // fresh entries, not expired; this is the 2nd..64th set() call
      }

      // 64 total set() calls have happened — the sweep threshold — and 'a'
      // was never touched via get(), so only the amortized sweep could
      // have removed it.
      expect(store.size).toBe(63);
      expect(store.get('a')).toBeUndefined();
    });

    it('does not sweep before the 64th set() call', () => {
      const { clock, state } = makeClock(0);
      const store = new BoundedTtlMap(1000, 500, clock);
      store.set('a', 1);
      state.now = 600;

      for (let i = 0; i < 62; i++) {
        store.set(`k${i}`, i); // total so far: 63 set() calls — one short of the sweep
      }

      // size still counts the (not-yet-swept) expired 'a' entry: 1 (a) + 62 (k0..k61) = 63.
      expect(store.size).toBe(63);
    });
  });

  describe('memory bound', () => {
    it('holds size at maxSize after inserting far more keys than capacity', () => {
      const store = new BoundedTtlMap(1000, 10_000_000, () => 0);
      for (let i = 0; i < 100_000; i++) {
        store.set(`key-${i}`, i);
      }
      expect(store.size).toBe(1000);
      // The most recently inserted keys are the ones that survived.
      expect(store.get('key-99999')).toBe(99999);
      expect(store.get('key-0')).toBeUndefined();
    });
  });

  describe('no timers', () => {
    it('never registers setInterval or setTimeout across get/set/delete', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const store = new BoundedTtlMap(10, 1000, () => 0);
      for (let i = 0; i < 200; i++) {
        store.set(`k${i}`, i);
      }
      store.get('k100');
      store.delete('k50');

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });
  });
});
