import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import {
  assessFreshness,
  resolveStalenessConfig,
  FRESHNESS_META_KEY,
  FUTURE_SKEW_TOLERANCE_MS,
  ATTR_MCP_TOOL_FRESHNESS_CLOCK_SKEW_MS,
} from '../src/staleness.js';
import { SHAPES, createHarness, lastToolSpan } from './helpers/security-harness.js';

/** ADR 027 amendment (0.18.0): mcp.tool.freshness.clock_skew_ms and staleness.clockSkewToleranceMs. */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const withFresh = (f) => ({ content: [{ type: 'text', text: 'ok' }], _meta: { [FRESHNESS_META_KEY]: f } });

describe('assessFreshness: clock skew', () => {
  it('within tolerance: verdict as before (age clamps to 0) and the skew is recorded', () => {
    expect(assessFreshness({ asOf: NOW + 4_000, maxAgeMs: 10_000 }, undefined, NOW)).toEqual({
      verdict: 'fresh',
      dataAgeMs: 0,
      maxAgeMs: 10_000,
      limitSource: 'max_age_ms',
      clockSkewMs: 4_000,
    });
  });

  it('exactly at the tolerance is still within it (strict "<" is unchanged)', () => {
    const a = assessFreshness({ asOf: NOW + FUTURE_SKEW_TOLERANCE_MS, maxAgeMs: 10_000 }, undefined, NOW);
    expect(a.verdict).toBe('fresh');
    expect(a.clockSkewMs).toBe(5_000);
  });

  it('beyond tolerance: unknown / future_as_of, skew still recorded', () => {
    const a = assessFreshness({ asOf: NOW + 9_000, maxAgeMs: 10_000 }, undefined, NOW);
    expect(a.verdict).toBe('unknown');
    expect(a.unknownReason).toBe('future_as_of');
    expect(a.clockSkewMs).toBe(9_000);
    expect(a.dataAgeMs).toBeUndefined();
  });

  it('no skew field when asOf is in the past, now, or ahead by less than half a millisecond', () => {
    for (const asOf of [NOW - 1, NOW, NOW + 0.4]) {
      expect('clockSkewMs' in assessFreshness({ asOf, maxAgeMs: 10 }, undefined, NOW)).toBe(false);
    }
  });

  it('skew is also recorded on unknown verdicts that have an asOf (missing window)', () => {
    const a = assessFreshness({ asOf: NOW + 1_000 }, undefined, NOW);
    expect(a).toMatchObject({ verdict: 'unknown', unknownReason: 'missing_window', clockSkewMs: 1_000 });
  });

  it('a custom tolerance moves the boundary; 0 means no tolerance', () => {
    expect(assessFreshness({ asOf: NOW + 1_500, maxAgeMs: 10 }, undefined, NOW, 2_000).verdict).toBe('fresh');
    expect(assessFreshness({ asOf: NOW + 2_500, maxAgeMs: 10 }, undefined, NOW, 2_000).unknownReason).toBe('future_as_of');
    expect(assessFreshness({ asOf: NOW + 1, maxAgeMs: 10 }, undefined, NOW, 0).unknownReason).toBe('future_as_of');
    expect(assessFreshness({ asOf: NOW, maxAgeMs: 10 }, undefined, NOW, 0).verdict).toBe('fresh');
  });

  it('the warning states the configured tolerance, not a hard-coded 5 s', () => {
    expect(assessFreshness({ asOf: NOW + 99_000, maxAgeMs: 10 }, undefined, NOW, 3_000).warning).toContain('3000 ms');
  });

  it('a skew far in the future stays a safe integer', () => {
    const a = assessFreshness({ asOf: 8.64e15, maxAgeMs: 10 }, undefined, NOW);
    expect(Number.isSafeInteger(a.clockSkewMs)).toBe(true);
  });
});

describe('resolveStalenessConfig: clockSkewToleranceMs', () => {
  let warn;
  beforeEach(() => {
    warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  });
  afterEach(() => diag.disable());

  it('defaults to 5000 with no warning', () => {
    expect(resolveStalenessConfig(undefined).clockSkewToleranceMs).toBe(5_000);
    expect(resolveStalenessConfig({}).clockSkewToleranceMs).toBe(5_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts 0 and positive finite numbers', () => {
    expect(resolveStalenessConfig({ clockSkewToleranceMs: 0 }).clockSkewToleranceMs).toBe(0);
    expect(resolveStalenessConfig({ clockSkewToleranceMs: 250.5 }).clockSkewToleranceMs).toBe(250.5);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Infinity, -Infinity, '5000', null, {}, [], true])(
    'invalid value %j: one warning, default used, never throws',
    (bad) => {
      let c;
      expect(() => (c = resolveStalenessConfig({ clockSkewToleranceMs: bad }))).not.toThrow();
      expect(c.clockSkewToleranceMs).toBe(5_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('clockSkewToleranceMs');
    },
  );

  it('a throwing getter degrades to the default without throwing', () => {
    const hostile = {
      get clockSkewToleranceMs() {
        throw new Error('boom');
      },
    };
    let c;
    expect(() => (c = resolveStalenessConfig(hostile))).not.toThrow();
    expect(c.clockSkewToleranceMs).toBe(5_000);
  });
});

describe('clock skew on real tools/call spans', () => {
  let h;
  beforeEach(() => {
    h = createHarness();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.teardown();
  });

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('sets the attribute when asOf is ahead, within tolerance, and keeps the verdict and status', async () => {
        const t = shape.build({}, () => withFresh({ asOf: NOW + 3_000, maxAgeMs: 60_000 }));
        await t.call();
        const span = lastToolSpan(h);
        expect(span.attributes[ATTR_MCP_TOOL_FRESHNESS_CLOCK_SKEW_MS]).toBe(3_000);
        expect(span.attributes['mcp.tool.freshness.verdict']).toBe('fresh');
        expect(span.attributes['mcp.tool.freshness.data_age_ms']).toBe(0);
        expect(span.status.code).toBe(1);
      });

      it('beyond tolerance: unknown/future_as_of with the skew recorded', async () => {
        const t = shape.build({}, () => withFresh({ asOf: NOW + 60_000, maxAgeMs: 60_000 }));
        await t.call();
        const span = lastToolSpan(h);
        expect(span.attributes[ATTR_MCP_TOOL_FRESHNESS_CLOCK_SKEW_MS]).toBe(60_000);
        expect(span.attributes['mcp.tool.freshness.verdict']).toBe('unknown');
        expect(span.attributes['mcp.tool.freshness.unknown_reason']).toBe('future_as_of');
      });

      it('honours staleness.clockSkewToleranceMs', async () => {
        const t = shape.build({ staleness: { clockSkewToleranceMs: 1_000 } }, () => withFresh({ asOf: NOW + 3_000, maxAgeMs: 60_000 }));
        await t.call();
        expect(lastToolSpan(h).attributes['mcp.tool.freshness.unknown_reason']).toBe('future_as_of');
      });

      it('no attribute when asOf is in the past: spans match 0.17 exactly', async () => {
        const t = shape.build({}, () => withFresh({ asOf: NOW - 1_000, maxAgeMs: 60_000 }));
        await t.call();
        const attrs = lastToolSpan(h).attributes;
        expect(ATTR_MCP_TOOL_FRESHNESS_CLOCK_SKEW_MS in attrs).toBe(false);
        expect(attrs['mcp.tool.freshness.data_age_ms']).toBe(1_000);
      });

      it('is span-only: no metric carries the skew', async () => {
        const t = shape.build({}, () => withFresh({ asOf: NOW + 3_000, maxAgeMs: 60_000 }));
        await t.call();
        const all = await h.allMetrics();
        expect(JSON.stringify(all)).not.toContain('clock_skew');
      });

      it('not recorded when staleness is disabled', async () => {
        const t = shape.build({ staleness: { enabled: false } }, () => withFresh({ asOf: NOW + 3_000, maxAgeMs: 60_000 }));
        await t.call();
        expect(ATTR_MCP_TOOL_FRESHNESS_CLOCK_SKEW_MS in lastToolSpan(h).attributes).toBe(false);
      });
    });
  }

  it('hostile freshness values never throw or leak: cyclic object, getter that throws, huge numbers', async () => {
    const CANARY = 'CANARY-SKEW-9d1c';
    const cyclic = { asOf: NOW + 2_000, maxAgeMs: 10, note: CANARY };
    cyclic.self = cyclic;
    const thrower = {
      get asOf() {
        throw new Error(CANARY);
      },
    };
    for (const f of [cyclic, thrower, { asOf: Number.MAX_VALUE, maxAgeMs: 1 }, { asOf: -Infinity }, { asOf: NOW + 1_000, maxAgeMs: Number.MAX_VALUE }]) {
      const t = SHAPES[2].build({}, () => withFresh(f));
      await expect(t.call()).resolves.toBeDefined();
    }
    const dump = JSON.stringify(h.spans().map((s) => [s.name, s.attributes, s.events])) + h.diagLines.join('\n') + JSON.stringify(await h.allMetrics());
    expect(dump).not.toContain(CANARY);
  });
});
