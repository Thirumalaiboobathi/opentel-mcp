import { describe, it, expect } from 'vitest';
import type { SerializedSpan } from '../../src/types.d.ts';
import { describeStaleness, formatAge, getFreshness, hasFreshnessSignal, isStale } from './freshness';

const span = (attributes: SerializedSpan['attributes']): SerializedSpan => ({
  id: 'a',
  traceId: 'b',
  name: 'tools/call t',
  toolName: 't',
  startTimeMs: 0,
  durationMs: 1,
  status: 'OK',
  attributes,
});

describe('freshness helpers', () => {
  it('reads the verdict, age and limit', () => {
    const s = span({ 'mcp.tool.freshness.verdict': 'stale', 'mcp.tool.freshness.data_age_ms': 240_000, 'mcp.tool.freshness.max_age_ms': 5_000 });
    expect(getFreshness(s)).toEqual({ verdict: 'stale', dataAgeMs: 240_000, maxAgeMs: 5_000 });
    expect(isStale(s)).toBe(true);
    expect(describeStaleness(getFreshness(s)!)).toBe('data 4m old · limit 5s');
  });

  it('no attributes (an older core, or a tool that does not opt in): null, and no signal', () => {
    expect(getFreshness(span({}))).toBeNull();
    expect(hasFreshnessSignal([span({}), span({ other: 1 })])).toBe(false);
  });

  it('ignores junk values', () => {
    expect(getFreshness(span({ 'mcp.tool.freshness.verdict': 'bogus' }))).toBeNull();
    expect(getFreshness(span({ 'mcp.tool.freshness.verdict': 'fresh', 'mcp.tool.freshness.data_age_ms': 'x' }))).toEqual({
      verdict: 'fresh',
      dataAgeMs: undefined,
      maxAgeMs: undefined,
    });
  });

  it('formatAge', () => {
    expect([0, 850, 1_000, 2_450, 12_400, 59_999, 60_000, 240_000, 3_600_000, 4_800_000, 86_400_000, 90_000_000].map(formatAge)).toEqual([
      '0ms', '850ms', '1s', '2.5s', '12s', '60s', '1m', '4m', '1h', '1h 20m', '1d', '1d 1h',
    ]);
    expect(formatAge(Number.NaN)).toBe('?');
    expect(formatAge(-1)).toBe('?');
  });

  it('describeStaleness without a limit or age', () => {
    expect(describeStaleness({ verdict: 'unknown', dataAgeMs: 1_500 })).toBe('data 1.5s old');
    expect(describeStaleness({ verdict: 'unknown' })).toBe('data age unknown');
  });
});
