/**
 * Shared type definitions for the `instanceKey` registry (ADR 012, Phase
 * 1 — docs/adr/012-tracker-lifecycle-and-shared-state.md).
 *
 * Hand-written, not a compiled build artifact — this project ships plain
 * JS with no TypeScript build step (see CONTRIBUTING.md). Exists purely
 * so TypeScript consumers (and editors) get accurate types for
 * `src/registry/instance-registry.js`, the same pattern
 * `src/thrash/types.d.ts` and `src/fingerprint/types.d.ts` already use.
 *
 * Internal — this module is not re-exported from `src/index.js`/
 * `src/index.d.ts`. Phase 1 only: no `instanceKey` option exists yet on
 * `instrumentMcpServer()`, so there is no public-facing type here either.
 */

/**
 * Constructor options for {@link InstanceRegistry}.
 */
export interface InstanceRegistryOptions {
  /** Hard cap on distinct keys. Least-recently-used keys are evicted past this. @default 1000 */
  maxSize?: number;
  /** Time-to-live (ms) from the moment a key's entry is last (re-)set — see `getOrCreate()`'s renew-on-hit behavior. @default 86400000 (24h) */
  ttlMs?: number;
  /** Returns "now" in epoch ms. Injectable for deterministic tests; defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * A bounded, TTL-evicting, lookup-or-create registry keyed by a
 * host-supplied string (the future `instanceKey` option). Generic over
 * the cached value's shape — see `src/registry/instance-registry.js`'s
 * own docblock for why this module knows nothing about trackers.
 *
 * @template V - Must never be `undefined` — see the `.js` module's docblock.
 */
export declare class InstanceRegistry<V> {
  constructor(options?: InstanceRegistryOptions);

  /** Current entry count. May include not-yet-swept expired entries — same caveat as `BoundedTtlMap.size`. */
  readonly size: number;

  /**
   * Looks up `key`; on a live hit, renews its TTL and returns the
   * existing value without calling `factory`. On a miss (absent,
   * expired, or evicted), calls `factory()`, stores the result under
   * `key`, and returns it. Never throws due to this method's own
   * lookup/renewal/insert bookkeeping; a throwing `factory` propagates
   * unchanged. See the `.js` module's docblock for the full contract,
   * including why evicted-vs-never-seen is deliberately undistinguished.
   */
  getOrCreate(key: string, factory: () => V): V;

  /** Removes every entry. Not used by this module's own logic — for host/test code that needs an explicit reset. */
  clear(): void;
}
