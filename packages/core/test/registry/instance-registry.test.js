import { describe, it, expect, vi } from 'vitest';
import { InstanceRegistry, DEFAULT_MAX_INSTANCES, DEFAULT_TTL_MS } from '../../src/registry/instance-registry.js';

/** A mutable, injectable clock: `now.value += x` advances it deterministically, no real waiting. */
function makeClock(start = 0) {
  const state = { now: start };
  return { clock: () => state.now, state };
}

describe('InstanceRegistry', () => {
  describe('lookup-or-create identity', () => {
    it('returns the same instance for the same key, without calling factory again', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      const factory = vi.fn(() => ({ id: 'a' }));

      const first = registry.getOrCreate('key-1', factory);
      const second = registry.getOrCreate('key-1', factory);

      expect(second).toBe(first);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('returns different instances for different keys, calling factory once per key', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      const factoryA = vi.fn(() => ({ id: 'a' }));
      const factoryB = vi.fn(() => ({ id: 'b' }));

      const a = registry.getOrCreate('key-a', factoryA);
      const b = registry.getOrCreate('key-b', factoryB);

      expect(a).not.toBe(b);
      expect(a).toEqual({ id: 'a' });
      expect(b).toEqual({ id: 'b' });
      expect(factoryA).toHaveBeenCalledTimes(1);
      expect(factoryB).toHaveBeenCalledTimes(1);
    });

    it('a fresh registry has size 0, and size grows by one per distinct key', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      expect(registry.size).toBe(0);
      registry.getOrCreate('a', () => ({}));
      expect(registry.size).toBe(1);
      registry.getOrCreate('b', () => ({}));
      expect(registry.size).toBe(2);
      registry.getOrCreate('a', () => ({})); // repeat key — hit, not a new entry
      expect(registry.size).toBe(2);
    });
  });

  describe('cache hit renews TTL — the subtle correctness point ADR 012 names explicitly', () => {
    it('a hit before expiry extends the entry past its ORIGINAL expiry, proving renewal actually happened', () => {
      const { clock, state } = makeClock(0);
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock });
      const factory = vi.fn(() => ({ id: 'a' }));

      const first = registry.getOrCreate('key-1', factory); // set() at t=0, naive expiry would be t=1000

      state.now = 900; // before original expiry — this must be a hit
      const second = registry.getOrCreate('key-1', factory);
      expect(second).toBe(first);
      expect(factory).toHaveBeenCalledTimes(1); // still a hit, factory not called again

      // The critical assertion: advance PAST the original t=1000 expiry, but
      // before the RENEWED expiry (900 + 1000 = 1900). A non-renewing
      // implementation (plain get()-then-nothing) would have expired this
      // entry at t=1000 and rebuilt it here. A renewing one must not.
      state.now = 1500;
      const third = registry.getOrCreate('key-1', factory);
      expect(third).toBe(first);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('repeated hits keep sliding the expiry forward indefinitely, as long as the gap between hits stays under the TTL', () => {
      const { clock, state } = makeClock(0);
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock });
      const factory = vi.fn(() => ({ id: 'a' }));
      const first = registry.getOrCreate('key-1', factory);

      // Ten renewing hits, each 800ms apart — always under the 1000ms TTL
      // relative to the PREVIOUS hit, but the cumulative elapsed time
      // (8000ms) is far past a single, non-renewed TTL window.
      for (let i = 1; i <= 10; i++) {
        state.now = i * 800;
        const hit = registry.getOrCreate('key-1', factory);
        expect(hit).toBe(first);
      }

      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('expiry after TTL, with no renewing hit in between', () => {
    it('creates a fresh instance once the TTL has elapsed since the last set()', () => {
      const { clock, state } = makeClock(0);
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock });
      const factory = vi.fn(() => ({ created: state.now }));

      const first = registry.getOrCreate('key-1', factory);
      state.now = 1001; // past TTL, no hit in between
      const second = registry.getOrCreate('key-1', factory);

      expect(second).not.toBe(first);
      expect(second).toEqual({ created: 1001 });
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('an entry just before expiry is still a hit', () => {
      const { clock, state } = makeClock(0);
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock });
      const factory = vi.fn(() => ({}));

      const first = registry.getOrCreate('key-1', factory);
      state.now = 999;
      const second = registry.getOrCreate('key-1', factory);

      expect(second).toBe(first);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  describe('eviction at cap (LRU)', () => {
    it('evicts the least-recently-used key once maxSize is exceeded', () => {
      const registry = new InstanceRegistry({ maxSize: 2, ttlMs: 1_000_000, clock: () => 0 });
      const a = registry.getOrCreate('a', () => ({ id: 'a' }));
      registry.getOrCreate('b', () => ({ id: 'b' }));
      registry.getOrCreate('c', () => ({ id: 'c' })); // over capacity — 'a' is LRU, should be evicted

      expect(registry.size).toBe(2);

      const factoryA = vi.fn(() => ({ id: 'a-rebuilt' }));
      const aAgain = registry.getOrCreate('a', factoryA);
      expect(aAgain).not.toBe(a); // evicted, rebuilt
      expect(factoryA).toHaveBeenCalledTimes(1);
    });

    it('many distinct keys keep the registry bounded at maxSize', () => {
      const registry = new InstanceRegistry({ maxSize: 100, ttlMs: 10_000_000, clock: () => 0 });
      for (let i = 0; i < 10_000; i++) {
        registry.getOrCreate(`key-${i}`, () => ({ id: i }));
      }
      expect(registry.size).toBe(100);

      // Most recently created keys survive; earliest ones don't.
      const lastKeyFactory = vi.fn(() => ({ id: 'rebuilt' }));
      const last = registry.getOrCreate('key-9999', lastKeyFactory);
      expect(lastKeyFactory).not.toHaveBeenCalled(); // still cached, a hit
      expect(last).toEqual({ id: 9999 });

      const firstKeyFactory = vi.fn(() => ({ id: 'rebuilt' }));
      registry.getOrCreate('key-0', firstKeyFactory);
      expect(firstKeyFactory).toHaveBeenCalledTimes(1); // long evicted, a miss
    });
  });

  describe('a key evicted then re-requested creates fresh state — the known limitation, pinned explicitly', () => {
    it('an evicted key loses its accumulated state: re-requesting it builds a NEW instance, not the old one', () => {
      const registry = new InstanceRegistry({ maxSize: 1, ttlMs: 1_000_000, clock: () => 0 });

      const original = registry.getOrCreate('service-a', () => ({ callsSeen: 0 }));
      original.callsSeen += 5; // simulate accumulated tracker state

      // A different key forces eviction of 'service-a' under maxSize: 1.
      registry.getOrCreate('service-b', () => ({ callsSeen: 0 }));
      expect(registry.size).toBe(1);

      // Re-requesting the SAME key ('service-a') that was evicted must not
      // resurrect the original, accumulated object — this is the original
      // ADR-012 bug, in miniature, and the registry does not hide it.
      const rebuilt = registry.getOrCreate('service-a', () => ({ callsSeen: 0 }));

      expect(rebuilt).not.toBe(original);
      expect(rebuilt.callsSeen).toBe(0); // accumulated state (5) is genuinely gone
    });

    it('the same holds for TTL-driven eviction, not just LRU cap pressure', () => {
      const { clock, state } = makeClock(0);
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock });

      const original = registry.getOrCreate('service-a', () => ({ callsSeen: 0 }));
      original.callsSeen += 5;

      state.now = 1001; // TTL elapsed, no renewing hit in between
      const rebuilt = registry.getOrCreate('service-a', () => ({ callsSeen: 0 }));

      expect(rebuilt).not.toBe(original);
      expect(rebuilt.callsSeen).toBe(0);
    });
  });

  describe('never throws', () => {
    it('a broken clock is treated as a miss, not a thrown error', () => {
      const brokenClock = () => {
        throw new Error('clock is broken');
      };
      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock: brokenClock });
      const factory = vi.fn(() => ({ id: 'a' }));

      expect(() => registry.getOrCreate('key-1', factory)).not.toThrow();
      expect(factory).toHaveBeenCalledTimes(1);

      // Every call degrades to a miss when the clock is broken — caching
      // itself can't work, but getOrCreate() still hands back a usable value.
      expect(() => registry.getOrCreate('key-1', factory)).not.toThrow();
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('a throwing factory is NOT swallowed — there is no safe substitute value to invent', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      const brokenFactory = () => {
        throw new Error('tracker construction failed');
      };

      expect(() => registry.getOrCreate('key-1', brokenFactory)).toThrow('tracker construction failed');
    });
  });

  describe('no timers', () => {
    it('never registers setInterval or setTimeout', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const registry = new InstanceRegistry({ maxSize: 10, ttlMs: 1000, clock: () => 0 });
      for (let i = 0; i < 200; i++) {
        registry.getOrCreate(`key-${i}`, () => ({ id: i }));
      }
      registry.getOrCreate('key-100', () => ({})); // a hit, exercises the renew path too

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });
  });

  describe('clear()', () => {
    it('removes every entry, so a subsequent lookup rebuilds via factory', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      const a = registry.getOrCreate('a', () => ({ id: 'a' }));
      registry.getOrCreate('b', () => ({ id: 'b' }));
      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);

      const factoryA = vi.fn(() => ({ id: 'a-rebuilt' }));
      const aAgain = registry.getOrCreate('a', factoryA);
      expect(aAgain).not.toBe(a);
      expect(factoryA).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on an already-empty registry', () => {
      const registry = new InstanceRegistry({ clock: () => 0 });
      expect(() => registry.clear()).not.toThrow();
      expect(registry.size).toBe(0);
    });
  });

  describe('defaults', () => {
    it('exports DEFAULT_MAX_INSTANCES (1000) and DEFAULT_TTL_MS (24h) per ADR 012', () => {
      expect(DEFAULT_MAX_INSTANCES).toBe(1000);
      expect(DEFAULT_TTL_MS).toBe(86_400_000);
    });

    it('uses the defaults when constructed with no options', () => {
      const registry = new InstanceRegistry();
      // Not directly introspectable (maxSize/ttlMs are private), so this
      // confirms behavior at the boundary instead: fewer than
      // DEFAULT_MAX_INSTANCES keys never evict.
      for (let i = 0; i < 10; i++) {
        registry.getOrCreate(`key-${i}`, () => ({ id: i }));
      }
      expect(registry.size).toBe(10);
    });
  });
});
