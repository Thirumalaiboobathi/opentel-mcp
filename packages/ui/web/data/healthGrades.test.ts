import { describe, it, expect } from 'vitest';
import type { SerializedSpan } from '../../src/types.d.ts';
import { computeToolHealth, gradeTool, letterFor, percentile, MIN_CALLS, THRESHOLDS, THRASH_ATTRIBUTE } from './healthGrades';

let n = 0;
function span(overrides: Partial<SerializedSpan> = {}): SerializedSpan {
  n++;
  return {
    id: `s${n}`,
    traceId: `t${n}`,
    name: 'tools/call t',
    toolName: 't',
    startTimeMs: 0,
    durationMs: 10,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

const ok = (count: number, extra: Partial<SerializedSpan> = {}) => Array.from({ length: count }, () => span(extra));
const silent = (count: number) => ok(count, { status: 'ERROR', errorType: 'tool_error' });
const thrown = (count: number) => ok(count, { status: 'ERROR', errorType: 'TypeError' });

describe('letterFor -- exclusive upper bounds', () => {
  const bounds = THRESHOLDS.silentFailureRate; // [0.02, 0.05, 0.15, 0.3]
  it('a value exactly on a bound gets the worse letter', () => {
    expect(letterFor(0, bounds)).toBe('A');
    expect(letterFor(0.019, bounds)).toBe('A');
    expect(letterFor(0.02, bounds)).toBe('B');
    expect(letterFor(0.05, bounds)).toBe('C');
    expect(letterFor(0.15, bounds)).toBe('D');
    expect(letterFor(0.3, bounds)).toBe('F');
    expect(letterFor(1, bounds)).toBe('F');
  });

  it('thrash: 0 = A, 1 = C, 2-3 = D, 4+ = F (no B)', () => {
    const t = THRESHOLDS.thrashEpisodes;
    expect([0, 1, 2, 3, 4, 9].map((v) => letterFor(v, t))).toEqual(['A', 'C', 'D', 'D', 'F', 'F']);
  });
});

describe('percentile (nearest rank)', () => {
  it('handles empty, single and ordinary lists', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
    expect(percentile([5, 1, 3], 0.95)).toBe(5);
  });
});

describe('gradeTool -- sample size', () => {
  it('zero calls: Not enough data, never NaN', () => {
    const h = gradeTool('t', []);
    expect(h.grade).toBeNull();
    expect(h.signals).toBeNull();
    expect(h.explanation).toContain('0 calls');
  });

  it(`below ${MIN_CALLS} calls: Not enough data even if every call failed`, () => {
    const h = gradeTool('t', silent(MIN_CALLS - 1));
    expect(h.grade).toBeNull();
    expect(h.explanation).toContain(`at least ${MIN_CALLS}`);
  });

  it(`exactly ${MIN_CALLS} calls: graded`, () => {
    expect(gradeTool('t', ok(MIN_CALLS)).grade).toBe('A');
  });
});

describe('gradeTool -- formula', () => {
  it('all successes, fast: A with no drivers', () => {
    const h = gradeTool('t', ok(20));
    expect(h.grade).toBe('A');
    expect(h.drivers).toEqual([]);
    expect(h.explanation).toContain('Grade A');
  });

  it('all failures (silent): F, driven by silent failures at 100%', () => {
    const h = gradeTool('t', silent(12));
    expect(h.grade).toBe('F');
    expect(h.drivers).toEqual(['silentFailureRate']);
    expect(h.signals!.silentFailureRate.value).toBe(1);
    expect(h.explanation).toContain('silent failures 100% (F)');
  });

  it('all failures (thrown): F, driven by errors; silent rate stays A', () => {
    const h = gradeTool('t', thrown(12));
    expect(h.grade).toBe('F');
    expect(h.drivers).toEqual(['errorRate']);
    expect(h.signals!.silentFailureRate.grade).toBe('A');
  });

  it('the grade is the worst signal: 1 silent in 10 (10%, C) + fast = C', () => {
    const h = gradeTool('t', [...ok(9), ...silent(1)]);
    expect(h.grade).toBe('C');
    expect(h.drivers).toEqual(['silentFailureRate']);
  });

  it('boundary: 1 silent in 20 is exactly 5% -> C, not B', () => {
    expect(gradeTool('t', [...ok(19), ...silent(1)]).grade).toBe('C');
  });

  it('boundary: 1 silent in 50 is exactly 2% -> B, not A', () => {
    expect(gradeTool('t', [...ok(49), ...silent(1)]).grade).toBe('B');
  });

  it('two signals tied for worst are both named as drivers', () => {
    const h = gradeTool('t', [...ok(6), ...silent(2), ...thrown(2)]);
    expect(h.grade).toBe('D');
    expect(h.drivers).toEqual(['silentFailureRate', 'errorRate']);
  });

  it('thrash-flagged calls count as episodes', () => {
    const h = gradeTool('t', [...ok(9), span({ attributes: { [THRASH_ATTRIBUTE]: true } })]);
    expect(h.signals!.thrashEpisodes.value).toBe(1);
    expect(h.grade).toBe('C');
    expect(h.drivers).toEqual(['thrashEpisodes']);
  });

  it('latency alone can set the grade (p95 on the boundary is the worse letter)', () => {
    const h = gradeTool('t', ok(10, { durationMs: 2500 }));
    expect(h.signals!.p95LatencyMs.value).toBe(2500);
    expect(h.grade).toBe('C');
    expect(h.explanation).toContain('p95 latency 2.5 s (C)');
  });

  it('latency is capped at C: even a 60 s p95 with no failures is a C, never D or F', () => {
    const h = gradeTool('t', ok(10, { durationMs: 60_000 }));
    expect(h.signals!.p95LatencyMs.grade).toBe('C');
    expect(h.grade).toBe('C');
  });

  it('latency cap does not soften failure signals: slow and failing is still graded by the failures', () => {
    const h = gradeTool('t', [...ok(6, { durationMs: 60_000 }), ...silent(4).map((s) => ({ ...s, durationMs: 60_000 }))]);
    expect(h.signals!.p95LatencyMs.grade).toBe('C');
    expect(h.grade).toBe('F');
    expect(h.drivers).toEqual(['silentFailureRate']);
  });

  it('latency thresholds: < 1 s is A, < 2.5 s is B, anything slower is C', () => {
    const t = THRESHOLDS.p95LatencyMs;
    expect([0, 999, 1000, 2499, 2500, 9_999, 10_000, 1e9].map((v) => letterFor(v, t))).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'C', 'C']);
  });

  it('ignores a non-finite duration rather than producing NaN', () => {
    const h = gradeTool('t', [...ok(10), span({ durationMs: Number.NaN })]);
    expect(Number.isFinite(h.signals!.p95LatencyMs.value)).toBe(true);
  });
});

describe('computeToolHealth', () => {
  it('groups by tool, skips spans with no tool name, sorts worst first and ungraded last', () => {
    const spans = [
      ...ok(10).map((s) => ({ ...s, toolName: 'good' })),
      ...silent(10).map((s) => ({ ...s, toolName: 'bad' })),
      ...ok(3).map((s) => ({ ...s, toolName: 'rare' })),
      span({ toolName: undefined }),
    ];
    const health = computeToolHealth(spans);
    expect(health.map((h) => [h.toolName, h.grade])).toEqual([
      ['bad', 'F'],
      ['good', 'A'],
      ['rare', null],
    ]);
  });

  it('no spans: no rows', () => {
    expect(computeToolHealth([])).toEqual([]);
  });
});
