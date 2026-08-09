/**
 * @module registry/instance-registry
 *
 * Phase 1 of the `instanceKey` design (ADR 012, Option C,
 * docs/adr/012-tracker-lifecycle-and-shared-state.md — "Registry bounds:
 * must be a BoundedTtlMap, not an unbounded global"). This module is the
 * keyed lookup-or-create registry itself, in isolation: no wiring into
 * `instrumentMcpServer()`, no `instanceKey` option, no config surface, no
 * `diag.warn`. Those are later phases. What exists here is the generic
 * mechanism a later phase will use to look up or construct the four
 * ADR-012 trackers (`ThrashDetector`, the budget tracker,
 * `ToolOutcomeCounter`, `SchemaDriftDetector`) by a host-supplied string
 * key, instead of constructing them unconditionally as local variables —
 * so repeated `instrumentMcpServer()` calls sharing a key can share their
 * state.
 *
 * Deliberately generic over the cached value's shape (this module knows
 * nothing about trackers) — same reasoning `src/thrash/store.js`'s own
 * docblock already gives for keeping `BoundedTtlMap` itself free of any
 * thrash-specific logic: this class exists purely to answer "have I
 * already built something for this key, in this process?", which is a
 * useful question independent of what "something" is.
 *
 * Built on `BoundedTtlMap` (`src/thrash/store.js`), reused as-is rather
 * than duplicated — that module already is the bounded, lazily-expiring,
 * no-timer store this needs, and ADR 012 explicitly rejected inventing a
 * second one. Imported across the `thrash/` directory boundary the same
 * way `src/thrash/emitter.js` already imports from `../fingerprint/attributes.js`
 * and `src/schema-drift/emitter.js` imports from `../attributes.js` — this
 * codebase already treats a specific, deliberately-generic module as
 * reusable across feature directories, not as private to the directory it
 * happens to live in.
 *
 * Defaults: `maxSize` 1000, `ttlMs` 86_400_000 (24h). ADR 012 proposes
 * both explicitly, in the same range as `thrashDetection.maxTrackedKeys`/
 * `schemaDrift.maxTrackedTools` (1000) for the cap, and a "day-scale
 * default... a defensible starting point, explicitly a starting point
 * pending real deployment feedback, not a value this design derives from
 * first principles" for the TTL — carried over here verbatim, not
 * re-decided. Both remain overridable via the constructor for whichever
 * later phase adds a config surface.
 */

import { BoundedTtlMap } from '../thrash/store.js';

/** @type {number} See module docblock — ADR 012's proposed default, same range as thrashDetection.maxTrackedKeys/schemaDrift.maxTrackedTools. */
export const DEFAULT_MAX_INSTANCES = 1000;

/** @type {number} 24 hours. See module docblock — ADR 012's proposed "day-scale... starting point" default. */
export const DEFAULT_TTL_MS = 86_400_000;

/**
 * `V` must never be `undefined` — `getOrCreate()` uses `undefined` (the
 * same convention `BoundedTtlMap.get()`/`Map.get()` already use) as its
 * own "nothing here" signal, so a factory that legitimately produces
 * `undefined` would be indistinguishable from a miss and get rebuilt on
 * every call. Not enforced at runtime (matching this codebase's general
 * preference for documented contracts over defensive runtime checks on
 * internal-only modules); the four ADR-012 trackers a later phase will
 * cache here are always plain objects/class instances, never `undefined`.
 *
 * @template V
 */
export class InstanceRegistry {
  /** @type {BoundedTtlMap<string, V>} */
  #store;

  /**
   * @param {object} [options]
   * @param {number} [options.maxSize] - @default DEFAULT_MAX_INSTANCES
   * @param {number} [options.ttlMs] - @default DEFAULT_TTL_MS
   * @param {() => number} [options.clock] - Injectable for deterministic tests; forwarded to BoundedTtlMap, defaults to Date.now there.
   */
  constructor({ maxSize = DEFAULT_MAX_INSTANCES, ttlMs = DEFAULT_TTL_MS, clock } = {}) {
    this.#store = clock !== undefined ? new BoundedTtlMap(maxSize, ttlMs, clock) : new BoundedTtlMap(maxSize, ttlMs);
  }

  /**
   * Removes every entry. Not part of normal operation (nothing in this
   * module's own logic ever calls it) — added for host/test code that
   * needs to explicitly reset a registry instance (e.g. a module-level
   * singleton reused across many tests in one file). Implemented via
   * `entries()` + `delete()` rather than reaching into `BoundedTtlMap`
   * directly, so this stays a pure consumer of that module's existing
   * public surface, same as every other method here.
   */
  clear() {
    for (const [key] of this.#store.entries()) {
      this.#store.delete(key);
    }
  }

  /** Current entry count. Forwards BoundedTtlMap's own caveat: may include not-yet-swept expired entries. */
  get size() {
    return this.#store.size;
  }

  /**
   * Looks up `key`. If a live (non-expired) entry exists, its TTL is
   * renewed — `.set()` is called again with the SAME value — and the
   * existing value is returned, without calling `factory`. If absent or
   * expired, `factory()` is called to construct a fresh value, which is
   * then stored under `key` and returned.
   *
   * This re-`set()`-on-hit behavior is the point ADR 012 calls out by
   * name as "the subtle correctness point": `BoundedTtlMap`'s own
   * documented semantics are TTL-from-`set()`-time, `get()` alone
   * refreshes LRU order but NOT expiry. Reused as a plain get-then-set,
   * a busy, continuously-used key would still expire on a fixed schedule
   * from its first `set()`, regardless of how often it's subsequently
   * hit — exactly undermining the point of giving it a stable key. This
   * method is the wiring ADR 012 specifies to fix that: the hit branch
   * below calls `.set()` unconditionally, not only the miss branch,
   * producing sliding-window "used it, so keep it" expiry at the call
   * site without needing to modify `BoundedTtlMap` itself.
   *
   * Never throws due to this method's own lookup/renewal/insert
   * bookkeeping — a failure in any of those steps (e.g. a broken
   * `clock`) is treated as a cache miss and falls through to `factory()`,
   * matching this codebase's fail-open discipline for every other
   * tracker (see `src/cost/budget.js`'s `recordAndCheck()`, which applies
   * the same standard to its own bookkeeping). `factory()` itself is
   * deliberately NOT caught here: it is the caller's own construction
   * logic, there is no safe substitute value this registry could invent
   * in its place, and silently swallowing a broken factory would hide a
   * real bug behind a misleadingly-plain `undefined` return instead of
   * surfacing it. If `factory()` throws, that exception propagates to
   * the caller unchanged.
   *
   * Eviction (LRU cap pressure, or the renewed TTL genuinely elapsing) is
   * NOT distinguished from "never seen this key before" — both are a
   * miss, and both silently construct fresh via `factory()`. This is
   * ADR 012's own decision, not an oversight: "Whether the registry
   * should also distinguish 'brand-new key' from 'key seen before but
   * since evicted' (and warn differently for each) was considered and is
   * deliberately left open... a considered enhancement for whoever
   * implements this, not a requirement." An evicted-then-re-requested key
   * losing its accumulated state is the original ADR-012 bug, in
   * miniature — a real, accepted reduction in blast radius (it now
   * requires actual TTL-scale idleness or cap pressure to trigger,
   * instead of firing on every call), not a closure of the failure mode.
   *
   * @param {string} key
   * @param {() => V} factory
   * @returns {V}
   */
  getOrCreate(key, factory) {
    try {
      const existing = this.#store.get(key);
      if (existing !== undefined) {
        this.#store.set(key, existing); // renew TTL on hit — see method docblock
        return existing;
      }
    } catch {
      // Never throw due to this registry's own bookkeeping — treat as a
      // miss and fall through to factory(). See method docblock.
    }

    const created = factory();

    try {
      this.#store.set(key, created);
    } catch {
      // Caching failed, but factory() already succeeded — still hand the
      // caller a usable value rather than losing it to a store-layer bug.
    }

    return created;
  }
}
