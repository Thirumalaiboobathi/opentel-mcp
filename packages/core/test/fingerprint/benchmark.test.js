import { describe, it, expect } from 'vitest';
import { hashInputs } from '../../src/fingerprint/hash.js';

/**
 * Manual micro-benchmark rather than vitest's `bench()` API: `bench()` is
 * built for comparison reports under the separate `vitest bench` runner,
 * not for asserting a hard budget inside the normal `npm test` suite. This
 * runs its own timed loop with `performance.now()` and asserts on the
 * resulting percentiles instead, so the perf budget is enforced on every
 * `npm test` run, not just an opt-in bench command.
 *
 * @param {() => void} fn
 * @param {number} iterations
 * @returns {{ p50: number, p95: number, p99: number }} microseconds
 */
function measure(fn, iterations) {
  const durationsUs = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    durationsUs[i] = (performance.now() - start) * 1000;
  }
  durationsUs.sort((a, b) => a - b);
  const at = (p) => durationsUs[Math.min(iterations - 1, Math.floor(iterations * p))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

// Scaffold (Phase 1): benchmarks the pieces that exist so far. Extended in
// Phase 5, once compose.js's computeFingerprint() exists, to cover the
// full end-to-end pipeline and assert the project's p99 < 200µs budget.
describe('fingerprint hashing perf', () => {
  it('hashInputs() stays well under the 200µs per-error budget', () => {
    const input = 'v1|TypeError|internal|thrown|null|Cannot read properties of <UUID>|foo@bar.js:12|baz@qux.js:34';

    const { p50, p95, p99 } = measure(() => hashInputs(input), 10_000);
    // eslint-disable-next-line no-console
    console.log(`hashInputs(): p50=${p50.toFixed(1)}µs p95=${p95.toFixed(1)}µs p99=${p99.toFixed(1)}µs`);

    expect(p99).toBeLessThan(200);
  });
});
