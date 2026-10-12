import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, metrics, diag, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer as V2McpServer, Server as V2Server } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../src/instrument.js';
import { FRESHNESS_META_KEY as ROOT_FRESHNESS_META_KEY } from '../src/index.js';
import {
  FRESHNESS_META_KEY,
  FUTURE_SKEW_TOLERANCE_MS,
  ATTR_MCP_TOOL_FRESHNESS_VERDICT as VERDICT,
  ATTR_MCP_TOOL_FRESHNESS_DATA_AGE_MS as AGE,
  ATTR_MCP_TOOL_FRESHNESS_MAX_AGE_MS as MAX_AGE,
  ATTR_MCP_TOOL_FRESHNESS_LIMIT_SOURCE as SOURCE,
  ATTR_MCP_TOOL_FRESHNESS_UNKNOWN_REASON as REASON,
  VERDICTS,
  UNKNOWN_REASONS,
  LIMIT_SOURCES,
  assessFreshness,
  parseTimestamp,
  resolveStalenessConfig,
  applyStaleness,
  createStalenessState,
} from '../src/staleness.js';
import { METRIC_SAFE_ATTRIBUTES } from '../src/attributes.js';

/** ADR 027: staleness detection. */

const NOW = Date.parse('2026-10-12T14:30:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const FRESHNESS_ATTRS = [VERDICT, AGE, MAX_AGE, SOURCE, REASON];

describe('FRESHNESS_META_KEY', () => {
  it('is exported from the package root', () => {
    expect(ROOT_FRESHNESS_META_KEY).toBe(FRESHNESS_META_KEY);
  });

  it("complies with the MCP spec's _meta key-name rules and isn't reserved", () => {
    const [prefix, name] = FRESHNESS_META_KEY.split('/');
    const labels = prefix.split('.');
    for (const label of labels) expect(label).toMatch(/^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
    expect(['modelcontextprotocol', 'mcp']).not.toContain(labels[1]);
    expect(name).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  });
});

describe('parseTimestamp', () => {
  it.each([
    ['2026-10-12T14:30:00Z', NOW],
    ['2026-10-12T14:30:00.000Z', NOW],
    ['2026-10-12T14:30Z', NOW],
    ['2026-10-12T20:00:00+05:30', NOW],
    ['2026-10-12T14:30:00.123456Z', NOW + 123],
    [NOW, NOW],
  ])('%s parses', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  it.each([
    ['no timezone', '2026-10-12T14:30:00'],
    ['date only', '2026-10-12'],
    ['numeric string', String(NOW)],
    ['free text', 'yesterday'],
    ['RFC 2822', 'Mon, 12 Oct 2026 14:30:00 GMT'],
    ['too long', `2026-10-12T14:30:00.000Z${' '.repeat(60)}`],
    ['epoch seconds', Math.floor(NOW / 1000)],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['beyond Date range', 9e15],
    ['invalid month', '2026-13-12T14:30:00Z'],
    ['null', null],
    ['boolean', true],
    ['object', {}],
    ['Date object', new Date(NOW)],
  ])('%s is rejected', (_label, input) => {
    expect(parseTimestamp(input)).toBeNull();
  });
});

describe('assessFreshness', () => {
  describe('asOf + maxAgeMs', () => {
    it('fresh inside the window', () => {
      expect(assessFreshness({ asOf: NOW - 2_000, maxAgeMs: 5_000 }, undefined, NOW)).toEqual({
        verdict: 'fresh',
        dataAgeMs: 2_000,
        maxAgeMs: 5_000,
        limitSource: 'max_age_ms',
      });
    });

    it('exactly at the limit is still fresh', () => {
      expect(assessFreshness({ asOf: NOW - 5_000, maxAgeMs: 5_000 }, undefined, NOW).verdict).toBe('fresh');
    });

    it('stale past the window, with the age reported', () => {
      expect(assessFreshness({ asOf: iso(NOW - 240_000), maxAgeMs: 5_000 }, undefined, NOW)).toEqual({
        verdict: 'stale',
        dataAgeMs: 240_000,
        maxAgeMs: 5_000,
        limitSource: 'max_age_ms',
      });
    });

    it('maxAgeMs 0 is valid: fresh only at age 0', () => {
      expect(assessFreshness({ asOf: NOW, maxAgeMs: 0 }, undefined, NOW).verdict).toBe('fresh');
      expect(assessFreshness({ asOf: NOW - 1, maxAgeMs: 0 }, undefined, NOW).verdict).toBe('stale');
    });

    it('a huge finite maxAgeMs is effectively never stale, and the window stays finite', () => {
      const a = assessFreshness({ asOf: NOW - 1e12, maxAgeMs: Number.MAX_VALUE }, undefined, NOW);
      expect(a.verdict).toBe('fresh');
      expect(Number.isFinite(a.maxAgeMs)).toBe(true);
    });
  });

  describe('asOf + freshUntil', () => {
    const sessionClose = Date.parse('2026-10-12T20:00:00Z');
    const sessionOpen = Date.parse('2026-10-12T13:30:00Z');

    it('fresh before the deadline; window is reported as deadline minus asOf', () => {
      expect(assessFreshness({ asOf: iso(sessionOpen), freshUntil: iso(sessionClose) }, undefined, NOW)).toEqual({
        verdict: 'fresh',
        dataAgeMs: NOW - sessionOpen,
        maxAgeMs: sessionClose - sessionOpen,
        limitSource: 'fresh_until',
      });
    });

    it('stale after the deadline', () => {
      const yesterdayClose = sessionClose - 86_400_000;
      const a = assessFreshness({ asOf: yesterdayClose - 3_600_000, freshUntil: yesterdayClose }, undefined, NOW);
      expect(a.verdict).toBe('stale');
      expect(a.limitSource).toBe('fresh_until');
    });

    it('freshUntil equal to asOf is a zero-length window, not invalid', () => {
      expect(assessFreshness({ asOf: NOW - 10, freshUntil: NOW - 10 }, undefined, NOW).verdict).toBe('stale');
    });
  });

  describe('both maxAgeMs and freshUntil: the earlier deadline wins', () => {
    it('maxAgeMs earlier -> stale by maxAgeMs even though freshUntil is later', () => {
      const a = assessFreshness({ asOf: NOW - 10_000, maxAgeMs: 5_000, freshUntil: NOW + 3_600_000 }, undefined, NOW);
      expect(a).toMatchObject({ verdict: 'stale', limitSource: 'max_age_ms', maxAgeMs: 5_000 });
    });

    it('freshUntil earlier -> stale by freshUntil even though maxAgeMs is generous', () => {
      const a = assessFreshness({ asOf: NOW - 10_000, maxAgeMs: 3_600_000, freshUntil: NOW - 1 }, undefined, NOW);
      expect(a).toMatchObject({ verdict: 'stale', limitSource: 'fresh_until', maxAgeMs: 9_999 });
    });
  });

  describe('config override', () => {
    it('replaces the tool maxAgeMs', () => {
      const a = assessFreshness({ asOf: NOW - 3_000, maxAgeMs: 60_000 }, 2_000, NOW);
      expect(a).toEqual({ verdict: 'stale', dataAgeMs: 3_000, maxAgeMs: 2_000, limitSource: 'config' });
    });

    it('replaces freshUntil too', () => {
      const a = assessFreshness({ asOf: NOW - 3_000, freshUntil: NOW - 1 }, 60_000, NOW);
      expect(a).toMatchObject({ verdict: 'fresh', limitSource: 'config' });
    });

    it('supplies a window when the tool sent only asOf', () => {
      expect(assessFreshness({ asOf: NOW - 3_000 }, 2_000, NOW).verdict).toBe('stale');
    });

    it("doesn't read the tool's window at all, so a malformed one doesn't matter", () => {
      expect(assessFreshness({ asOf: NOW, maxAgeMs: -5, freshUntil: 'garbage' }, 1_000, NOW).verdict).toBe('fresh');
    });

    it("can't invent asOf", () => {
      expect(assessFreshness({ maxAgeMs: 1_000 }, 1_000, NOW)).toMatchObject({ verdict: 'unknown', unknownReason: 'invalid_as_of' });
    });
  });

  describe('edge cases (ADR 027 §4)', () => {
    it('asOf a little in the future (clock skew) clamps age to 0 and still gets a verdict', () => {
      const a = assessFreshness({ asOf: NOW + FUTURE_SKEW_TOLERANCE_MS, maxAgeMs: 1_000 }, undefined, NOW);
      expect(a).toMatchObject({ verdict: 'fresh', dataAgeMs: 0 });
    });

    it('asOf beyond the skew tolerance is unknown / future_as_of, with no age', () => {
      const a = assessFreshness({ asOf: NOW + FUTURE_SKEW_TOLERANCE_MS + 1, maxAgeMs: 1_000 }, undefined, NOW);
      expect(a).toMatchObject({ verdict: 'unknown', unknownReason: 'future_as_of' });
      expect(a.dataAgeMs).toBeUndefined();
    });

    it('epoch seconds is invalid_as_of, and the warning says why', () => {
      const a = assessFreshness({ asOf: Math.floor(NOW / 1000), maxAgeMs: 1_000 }, undefined, NOW);
      expect(a).toMatchObject({ verdict: 'unknown', unknownReason: 'invalid_as_of' });
      expect(a.warning).toMatch(/epoch seconds/);
    });

    it('asOf alone is missing_window, but the age is still known', () => {
      expect(assessFreshness({ asOf: NOW - 7 }, undefined, NOW)).toMatchObject({
        verdict: 'unknown',
        unknownReason: 'missing_window',
        dataAgeMs: 7,
      });
    });

    it.each([
      ['negative maxAgeMs', { maxAgeMs: -1 }],
      ['NaN maxAgeMs', { maxAgeMs: Number.NaN }],
      ['Infinity maxAgeMs', { maxAgeMs: Infinity }],
      ['string maxAgeMs', { maxAgeMs: '5000' }],
      ['null maxAgeMs', { maxAgeMs: null }],
      ['unparseable freshUntil', { freshUntil: 'tomorrow' }],
      ['freshUntil before asOf', { freshUntil: NOW - 60_000 }],
      ['valid maxAgeMs but malformed freshUntil', { maxAgeMs: 5_000, freshUntil: 'nope' }],
      ['valid freshUntil but malformed maxAgeMs', { maxAgeMs: -1, freshUntil: NOW + 60_000 }],
    ])('%s is unknown / invalid_window', (_label, window) => {
      expect(assessFreshness({ asOf: NOW - 1_000, ...window }, undefined, NOW)).toMatchObject({
        verdict: 'unknown',
        unknownReason: 'invalid_window',
      });
    });

    it('only ever returns the documented enum values', () => {
      for (const v of [{ asOf: NOW, maxAgeMs: 1 }, { asOf: 'x' }, { asOf: NOW + 1e9 }, { asOf: NOW, maxAgeMs: -1 }, 42]) {
        const a = assessFreshness(v, undefined, NOW);
        expect(VERDICTS).toContain(a.verdict);
        if (a.unknownReason) expect(UNKNOWN_REASONS).toContain(a.unknownReason);
        if (a.limitSource) expect(LIMIT_SOURCES).toContain(a.limitSource);
      }
    });
  });

  it('reads only asOf, maxAgeMs and freshUntil off the freshness object', () => {
    const read = new Set();
    const freshness = new Proxy(
      { asOf: NOW - 1, maxAgeMs: 10, note: 'secret', extra: { deep: 1 } },
      {
        get(target, prop) {
          read.add(prop);
          return target[prop];
        },
      },
    );
    assessFreshness(freshness, undefined, NOW);
    expect([...read].filter((p) => typeof p === 'string').sort()).toEqual(['asOf', 'freshUntil', 'maxAgeMs']);
  });
});

describe('resolveStalenessConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults: enabled, no overrides', () => {
    const c = resolveStalenessConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.overrides.size).toBe(0);
  });

  it('enabled: false turns it off; any other value leaves it on', () => {
    expect(resolveStalenessConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveStalenessConfig({ enabled: 'no' }).enabled).toBe(true);
    expect(resolveStalenessConfig('junk').enabled).toBe(true);
  });

  it('keeps valid overrides and drops invalid ones with one warn each', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const c = resolveStalenessConfig({
      tools: { get_quote: { maxAgeMs: 2_000 }, zero: { maxAgeMs: 0 }, neg: { maxAgeMs: -1 }, str: { maxAgeMs: '5' }, bare: 5 },
    });
    expect([...c.overrides.entries()]).toEqual([
      ['get_quote', 2_000],
      ['zero', 0],
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('never throws, even on a hostile options object', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(() => resolveStalenessConfig(hostile)).not.toThrow();
    expect(() => resolveStalenessConfig({ tools: hostile })).not.toThrow();
  });
});

describe('applyStaleness', () => {
  afterEach(() => vi.restoreAllMocks());

  const span = () => {
    const attrs = {};
    return { attrs, setAttribute: (k, v) => (attrs[k] = v) };
  };
  const config = resolveStalenessConfig(undefined);

  it('sets nothing when the result has no freshness key', () => {
    const s = span();
    for (const result of [{ content: [] }, { content: [], _meta: { other: 1 } }, undefined, null, 'x']) {
      applyStaleness(s, null, 't', result, config, createStalenessState(), NOW);
    }
    expect(s.attrs).toEqual({});
  });

  it('enabled: false sets nothing even with a freshness key', () => {
    const s = span();
    applyStaleness(s, null, 't', { _meta: { [FRESHNESS_META_KEY]: { asOf: NOW - 1e6, maxAgeMs: 1 } } }, { enabled: false, overrides: new Map() }, createStalenessState(), NOW);
    expect(s.attrs).toEqual({});
  });

  it('warns at most once per tool, however many malformed responses', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const state = createStalenessState();
    for (let i = 0; i < 20; i++) applyStaleness(span(), null, 'a', { _meta: { [FRESHNESS_META_KEY]: 'bad' } }, config, state, NOW);
    for (let i = 0; i < 20; i++) applyStaleness(span(), null, 'b', { _meta: { [FRESHNESS_META_KEY]: { asOf: 1 } } }, config, state, NOW);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('caps the warned-tool set', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const state = createStalenessState();
    for (let i = 0; i < 1_000; i++) applyStaleness(span(), null, `t${i}`, { _meta: { [FRESHNESS_META_KEY]: 'bad' } }, config, state, NOW);
    expect(state.warnedTools.size).toBe(256);
    expect(warn).toHaveBeenCalledTimes(256);
  });

  it('never throws: a throwing getter, a broken span, a broken recorder', () => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const throwingMeta = {
      _meta: {
        get [FRESHNESS_META_KEY]() {
          throw new Error('boom');
        },
      },
    };
    const throwingFields = { _meta: { [FRESHNESS_META_KEY]: { get asOf() { throw new Error('boom'); } } } };
    const brokenSpan = {
      setAttribute() {
        throw new Error('boom');
      },
    };
    const brokenRecorder = {
      recordStaleResponse() {
        throw new Error('boom');
      },
    };
    const stale = { _meta: { [FRESHNESS_META_KEY]: { asOf: NOW - 1e6, maxAgeMs: 1 } } };
    expect(() => applyStaleness(span(), null, 't', throwingMeta, config, createStalenessState(), NOW)).not.toThrow();
    expect(() => applyStaleness(span(), null, 't', throwingFields, config, createStalenessState(), NOW)).not.toThrow();
    expect(() => applyStaleness(brokenSpan, null, 't', stale, config, createStalenessState(), NOW)).not.toThrow();
    expect(() => applyStaleness(span(), brokenRecorder, 't', stale, config, createStalenessState(), NOW)).not.toThrow();
    expect(() => applyStaleness(span(), null, 't', stale, null, null, NOW)).not.toThrow();
  });

  it('the warning never contains the malformed value itself', () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    applyStaleness(span(), null, 't', { _meta: { [FRESHNESS_META_KEY]: { asOf: 'CANARY-c0ffee12', maxAgeMs: 'CANARY-c0ffee34' } } }, config, createStalenessState(), NOW);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/CANARY/);
  });
});

// --- Real tool-call spans, both SDKs, both server shapes ---

class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

const v1Ctx = () => ({ requestId: 1, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} });
const v2Ctx = () => ({
  mcpReq: { id: 1, method: 'tools/call', signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
});

/** Each builds a server, instruments it, registers one tool returning `produce()`, and returns a call(). */
const SHAPES = [
  {
    name: 'v1 McpServer',
    setup(options, produce) {
      const mcp = new V1McpServer({ name: 't', version: '0' });
      instrumentMcpServer(mcp, options);
      mcp.registerTool('get_quote', { description: 'q' }, async () => produce());
      return () => mcp.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'get_quote', arguments: {} } }, v1Ctx());
    },
  },
  {
    name: 'v2 McpServer',
    setup(options, produce) {
      const mcp = new V2McpServer({ name: 't', version: '0' });
      instrumentMcpServer(mcp, options);
      mcp.registerTool('get_quote', { description: 'q' }, async () => produce());
      return () => mcp.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'get_quote', arguments: {} } }, v2Ctx());
    },
  },
  {
    name: 'v1 Server',
    setup(options, produce) {
      const server = new V1Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
      instrumentMcpServer(server, options);
      server.setRequestHandler(CallToolRequestSchema, async () => produce());
      return () => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'get_quote', arguments: {} } }, v1Ctx());
    },
  },
  {
    name: 'v2 Server',
    setup(options, produce) {
      const server = new V2Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
      instrumentMcpServer(server, options);
      server.setRequestHandler('tools/call', async () => produce());
      return () => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'get_quote', arguments: {} } }, v2Ctx());
    },
  },
];

const withFreshness = (freshness, extra = {}) => ({
  content: [{ type: 'text', text: '{"symbol":"ACME","price":101.5}' }],
  ...extra,
  _meta: { [FRESHNESS_META_KEY]: freshness, ...(extra._meta ?? {}) },
});

describe('staleness on real tools/call spans', () => {
  let spanExporter;
  let provider;
  let reader;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
    reader = new TestMetricReader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    metrics.disable();
    vi.restoreAllMocks();
  });

  async function metricPoints(name) {
    const { resourceMetrics } = await reader.collect();
    const found = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
    return found ? found.dataPoints : [];
  }

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      async function run(result, options = {}) {
        const call = shape.setup(options, () => result);
        const returned = await call().catch((e) => e);
        return { returned, span: spanExporter.getFinishedSpans().at(-1) };
      }

      it('stale (maxAgeMs form): verdict, age, limit on the span; status OK; counted as stale, not as a silent failure', async () => {
        const { span } = await run(withFreshness({ asOf: Date.now() - 240_000, maxAgeMs: 5_000 }));
        expect(span.attributes[VERDICT]).toBe('stale');
        expect(span.attributes[AGE]).toBeGreaterThanOrEqual(240_000);
        expect(span.attributes[MAX_AGE]).toBe(5_000);
        expect(span.attributes[SOURCE]).toBe('max_age_ms');
        expect(span.status.code).toBe(SpanStatusCode.OK);
        expect('error.type' in span.attributes).toBe(false);
        expect(await metricPoints('mcp.tool.stale_responses')).toEqual([
          expect.objectContaining({ value: 1, attributes: { 'gen_ai.tool.name': 'get_quote' } }),
        ]);
        expect(await metricPoints('mcp.tool.silent_failures')).toEqual([]);
        const durations = await metricPoints('mcp.tool.duration');
        expect(durations.map((p) => p.attributes['mcp.tool.outcome'])).toEqual(['success']);
      });

      it('fresh (freshUntil form)', async () => {
        const { span } = await run(withFreshness({ asOf: new Date(Date.now() - 1_000).toISOString(), freshUntil: new Date(Date.now() + 3_600_000).toISOString() }));
        expect(span.attributes[VERDICT]).toBe('fresh');
        expect(span.attributes[SOURCE]).toBe('fresh_until');
        expect(await metricPoints('mcp.tool.stale_responses')).toEqual([]);
      });

      it('config override wins over the tool window', async () => {
        const { span } = await run(withFreshness({ asOf: Date.now() - 3_000, maxAgeMs: 60_000 }), {
          staleness: { tools: { get_quote: { maxAgeMs: 1_000 } } },
        });
        expect(span.attributes[VERDICT]).toBe('stale');
        expect(span.attributes[SOURCE]).toBe('config');
        expect(span.attributes[MAX_AGE]).toBe(1_000);
      });

      it('no freshness data: no verdict and no freshness attributes at all', async () => {
        const { span } = await run({ content: [{ type: 'text', text: 'ok' }] });
        for (const key of FRESHNESS_ATTRS) expect(key in span.attributes).toBe(false);
      });

      it('no freshness data stays verdict-less even with a config override', async () => {
        const { span } = await run({ content: [] }, { staleness: { tools: { get_quote: { maxAgeMs: 1 } } } });
        for (const key of FRESHNESS_ATTRS) expect(key in span.attributes).toBe(false);
      });

      it('malformed freshness: unknown with a reason, result returned untouched', async () => {
        vi.spyOn(diag, 'warn').mockImplementation(() => {});
        const result = withFreshness({ asOf: 'last tuesday', maxAgeMs: 5_000 });
        const { span, returned } = await run(result);
        expect(span.attributes[VERDICT]).toBe('unknown');
        expect(span.attributes[REASON]).toBe('invalid_as_of');
        expect(returned._meta[FRESHNESS_META_KEY]).toEqual({ asOf: 'last tuesday', maxAgeMs: 5_000 });
      });

      it('isError responses are skipped, even with stale freshness data', async () => {
        const { span } = await run(withFreshness({ asOf: Date.now() - 1e7, maxAgeMs: 1 }, { isError: true }));
        expect(span.attributes['error.type']).toBe('tool_error');
        for (const key of FRESHNESS_ATTRS) expect(key in span.attributes).toBe(false);
        expect(await metricPoints('mcp.tool.stale_responses')).toEqual([]);
      });

      it('staleness.enabled: false: nothing read, nothing emitted', async () => {
        const { span } = await run(withFreshness({ asOf: Date.now() - 1e7, maxAgeMs: 1 }), { staleness: { enabled: false } });
        for (const key of FRESHNESS_ATTRS) expect(key in span.attributes).toBe(false);
        expect(await metricPoints('mcp.tool.stale_responses')).toEqual([]);
      });
    });
  }

  it('a stale response still counts as a SUCCESS in the observation state', async () => {
    const mcp = new V1McpServer({ name: 't', version: '0' });
    const instrumented = instrumentMcpServer(mcp, {});
    mcp.registerTool('get_quote', { description: 'q' }, async () => withFreshness({ asOf: Date.now() - 1e7, maxAgeMs: 1 }));
    await mcp.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'get_quote', arguments: {} } }, v1Ctx());
    expect(instrumented.getObservationState().toolOutcome).toMatchObject({ success: 1, failure: 0 });
  });

  it('mcp.tool.stale_responses carries only allow-listed label keys', async () => {
    const call = SHAPES[2].setup({}, () => withFreshness({ asOf: Date.now() - 1e7, maxAgeMs: 1 }));
    await call();
    const points = await metricPoints('mcp.tool.stale_responses');
    expect(points).toHaveLength(1);
    for (const key of Object.keys(points[0].attributes)) expect(METRIC_SAFE_ATTRIBUTES).toContain(key);
  });
});

describe('privacy canary: no result content or other _meta field reaches spans or metrics', () => {
  const CANARIES = ['CANARY-9a1f0c33', 'CANARY-41de77b0', 'CANARY-c5e2a918', 'CANARY-7b3f0d64', 'CANARY-02aa5e19'];
  let spanExporter;
  let provider;
  let reader;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
    reader = new TestMetricReader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    metrics.disable();
    vi.restoreAllMocks();
  });

  it('every SDK/server shape, fresh, stale and unknown responses', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const results = [
      { asOf: Date.now() - 1e6, maxAgeMs: 1, note: CANARIES[3] },
      { asOf: Date.now(), maxAgeMs: 1e9, [CANARIES[4]]: CANARIES[4] },
      { asOf: CANARIES[3], maxAgeMs: CANARIES[4] },
    ].map((freshness) => ({
      content: [{ type: 'text', text: `price ${CANARIES[0]}` }],
      structuredContent: { secret: CANARIES[1] },
      _meta: { [FRESHNESS_META_KEY]: freshness, other: CANARIES[2], [CANARIES[2]]: 1 },
    }));

    for (const shape of SHAPES) {
      for (const result of results) {
        const call = shape.setup({}, () => result);
        await call().catch(() => {});
      }
    }

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(SHAPES.length * results.length);
    expect(spans.some((s) => s.attributes[VERDICT] === 'stale')).toBe(true);
    const spanDump = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status })));
    const { resourceMetrics } = await reader.collect();
    const metricDump = JSON.stringify(resourceMetrics.scopeMetrics);
    const warnDump = JSON.stringify(warn.mock.calls);
    for (const canary of CANARIES) {
      expect(spanDump).not.toContain(canary);
      expect(metricDump).not.toContain(canary);
      expect(warnDump).not.toContain(canary);
    }
  });
});

describe('never throws into the host on garbage freshness input (fuzz)', () => {
  let spanExporter;
  let provider;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    vi.restoreAllMocks();
  });

  const cyclic = { asOf: NOW };
  cyclic.self = cyclic;
  cyclic.maxAgeMs = cyclic;
  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
      has() {
        throw new Error('boom');
      },
    },
  );
  const GARBAGE_TIMESTAMPS = [
    null, true, false, 0, -1, 1, 1.5, Number.NaN, Infinity, -Infinity, 1e300, -1e300, 2 ** 53, '', ' ', 'now',
    '0', '-1', 'NaN', '2026', '2026-10', '2026-10-12', '2026-10-12T14:30', '2026-10-12T25:61:61Z', '2026-02-30T00:00:00Z',
    '9999999-01-01T00:00:00Z', 'x'.repeat(10_000), '\u0000', {}, [], [NOW], () => NOW, Symbol('t'), 10n, new Date(NOW),
    cyclic, throwingProxy,
  ];
  const GARBAGE_FRESHNESS = [
    undefined, null, 0, 'fresh', true, [], [{ asOf: NOW }], () => {}, Symbol('f'), 1n, cyclic, throwingProxy,
    ...GARBAGE_TIMESTAMPS.map((asOf) => ({ asOf, maxAgeMs: 1_000 })),
    ...GARBAGE_TIMESTAMPS.map((maxAgeMs) => ({ asOf: Date.now(), maxAgeMs })),
    ...GARBAGE_TIMESTAMPS.map((freshUntil) => ({ asOf: Date.now(), freshUntil })),
  ];

  it(`${GARBAGE_FRESHNESS.length} malformed values: the handler's result always comes back, verdict is unknown or absent, one warn per tool`, async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    for (const shape of SHAPES) {
      for (const freshness of GARBAGE_FRESHNESS) {
        const result = { content: [{ type: 'text', text: 'ok' }], _meta: { [FRESHNESS_META_KEY]: freshness } };
        const call = shape.setup({}, () => result);
        await call().then(
          () => {},
          (e) => {
            // A v2 SDK may reject a result shape it can't validate; that's the
            // SDK's own behavior, never an error from opentel-mcp.
            expect(String(e?.stack ?? e)).not.toMatch(/staleness\.js/);
          },
        );
      }
    }
    for (const span of spanExporter.getFinishedSpans()) {
      const verdict = span.attributes[VERDICT];
      // Some "garbage" maxAgeMs values (0, 1, 1e300) are legal windows, so
      // fresh/stale can occur; anything else must be unknown or absent.
      if (verdict !== undefined) expect(VERDICTS).toContain(verdict);
    }
    // Each setup() is a fresh instrumented server, so the per-tool budget
    // is one warning per server at most.
    const perServerMax = SHAPES.length * GARBAGE_FRESHNESS.length;
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('freshness')).length).toBeLessThanOrEqual(perServerMax);
  });

  it('one instrumented server, many malformed responses for one tool: exactly one warn', async () => {
    const warn = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    let i = 0;
    const call = SHAPES[2].setup({}, () => ({ content: [], _meta: { [FRESHNESS_META_KEY]: GARBAGE_FRESHNESS[i++ % GARBAGE_FRESHNESS.length] } }));
    for (let n = 0; n < GARBAGE_FRESHNESS.length; n++) await call();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('freshness'))).toHaveLength(1);
  });
});
