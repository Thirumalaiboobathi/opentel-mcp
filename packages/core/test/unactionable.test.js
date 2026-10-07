import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as V2McpServer } from '@modelcontextprotocol/server';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import {
  assessToolErrorContent,
  resolveUnactionableErrorsConfig,
  applyUnactionableAttributes,
  ATTR_MCP_FAILURE_UNACTIONABLE,
  ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET,
  CONTENT_LENGTH_BUCKETS,
} from '../src/unactionable.js';
import { METRIC_SAFE_ATTRIBUTES } from '../src/attributes.js';
import { METRIC_SAFE_ATTRIBUTES as FINGERPRINT_METRIC_SAFE } from '../src/fingerprint/attributes.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';

/** ADR 025: unactionable tool errors. */

const text = (t) => ({ type: 'text', text: t });
const err = (...content) => ({ isError: true, content });
const chars = (n) => 'x'.repeat(n);

describe('assessToolErrorContent (lengths and counts only)', () => {
  const cases = [
    ['content missing', { isError: true }, true, 'empty'],
    ['content not an array', { isError: true, content: 'oops' }, true, 'empty'],
    ['content empty', err(), true, 'empty'],
    ['empty text', err(text('')), true, 'empty'],
    ['whitespace-only text', err(text('   \n\t ')), true, 'empty'],
    ['"Error" (5)', err(text('Error')), true, 'tiny'],
    ['9 chars', err(text(chars(9))), true, 'tiny'],
    ['exactly 10 chars', err(text(chars(10))), false, 'short'],
    ['10 chars with surrounding whitespace counts as 10', err(text(`  ${chars(10)}  `)), false, 'short'],
    ['79 chars', err(text(chars(79))), false, 'short'],
    ['80 chars', err(text(chars(80))), false, 'medium'],
    ['499 chars', err(text(chars(499))), false, 'medium'],
    ['500 chars', err(text(chars(500))), false, 'long'],
    ['text summed across items (4 + 6)', err(text(chars(4)), text(chars(6))), false, 'short'],
    ['useful text in content[1], not content[0]', err(text(''), text('Rate limited: retry after 30s')), false, 'short'],
    ['image only', err({ type: 'image', data: 'AAAA', mimeType: 'image/png' }), false, 'empty'],
    ['resource link only', err({ type: 'resource_link', uri: 'file:///x', name: 'x' }), false, 'empty'],
    ['tiny text plus a resource', err(text('Error'), { type: 'resource', resource: { uri: 'file:///x', text: 'y' } }), false, 'tiny'],
    ['text item with non-string text is ignored', err({ type: 'text', text: 42 }), true, 'empty'],
    ['null / primitive items are ignored', err(null, 7, 'str'), true, 'empty'],
  ];
  for (const [label, result, unactionable, bucket] of cases) {
    it(`${label}: unactionable=${unactionable}, bucket=${bucket}`, () => {
      expect(assessToolErrorContent(result, 10)).toEqual({ unactionable, bucket });
    });
  }

  it('minTextLength 0: only empty / whitespace-only is unactionable, and "tiny" never occurs', () => {
    expect(assessToolErrorContent(err(text(' ')), 0)).toEqual({ unactionable: true, bucket: 'empty' });
    expect(assessToolErrorContent(err(text('E')), 0)).toEqual({ unactionable: false, bucket: 'short' });
  });

  it('every bucket it can return is one of the five fixed values', () => {
    for (const n of [0, 1, 9, 10, 79, 80, 499, 500, 5000]) {
      expect(CONTENT_LENGTH_BUCKETS).toContain(assessToolErrorContent(err(text(chars(n))), 10).bucket);
    }
  });
});

describe('resolveUnactionableErrorsConfig', () => {
  const ENV = ['OTEL_MCP_UNACTIONABLE_ERRORS_ENABLED', 'OTEL_MCP_UNACTIONABLE_ERRORS_MIN_TEXT_LENGTH'];
  afterEach(() => {
    for (const name of ENV) delete process.env[name];
  });

  it('defaults: enabled, minTextLength 10', () => {
    expect(resolveUnactionableErrorsConfig(undefined)).toEqual({ enabled: true, minTextLength: 10 });
  });

  it('options override; invalid values fall back to defaults', () => {
    expect(resolveUnactionableErrorsConfig({ enabled: false, minTextLength: 0 })).toEqual({ enabled: false, minTextLength: 0 });
    for (const bad of [-1, 201, 2.5, '10', Number.NaN]) {
      expect(resolveUnactionableErrorsConfig({ minTextLength: bad }).minTextLength).toBe(10);
    }
    expect(resolveUnactionableErrorsConfig({ enabled: 'no' }).enabled).toBe(true);
    expect(resolveUnactionableErrorsConfig('junk')).toEqual({ enabled: true, minTextLength: 10 });
  });

  it('env vars apply with lower precedence than options', () => {
    process.env.OTEL_MCP_UNACTIONABLE_ERRORS_ENABLED = 'false';
    process.env.OTEL_MCP_UNACTIONABLE_ERRORS_MIN_TEXT_LENGTH = '20';
    expect(resolveUnactionableErrorsConfig(undefined)).toEqual({ enabled: false, minTextLength: 20 });
    expect(resolveUnactionableErrorsConfig({ enabled: true, minTextLength: 5 })).toEqual({ enabled: true, minTextLength: 5 });
  });

  it('applyUnactionableAttributes never throws, even on a broken span', () => {
    const brokenSpan = {
      setAttribute() {
        throw new Error('boom');
      },
    };
    expect(() => applyUnactionableAttributes(brokenSpan, err(), { enabled: true, minTextLength: 10 })).not.toThrow();
  });
});

describe('unactionable attributes on real tool-call spans', () => {
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
  });

  const SDKS = [
    {
      name: 'v1',
      make: () => new V1McpServer({ name: 't', version: '0' }),
      ctx: () => ({ requestId: 1, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} }),
    },
    {
      name: 'v2',
      make: () => new V2McpServer({ name: 't', version: '0' }),
      ctx: () => ({
        mcpReq: { id: 1, method: 'tools/call', signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
      }),
    },
  ];

  for (const sdk of SDKS) {
    async function run(result, options = {}, thrown = false) {
      const mcp = sdk.make();
      instrumentMcpServer(mcp, options);
      mcp.registerTool('t', { description: 't' }, async () => {
        if (thrown) throw new Error('kaboom');
        return result;
      });
      await mcp.server._requestHandlers
        .get('tools/call')({ method: 'tools/call', params: { name: 't', arguments: {} } }, sdk.ctx())
        .catch(() => {});
      return spanExporter.getFinishedSpans().at(-1).attributes;
    }

    it(`${sdk.name}: an empty isError result is flagged unactionable / empty`, async () => {
      const attrs = await run(err());
      expect(attrs[ATTR_MCP_FAILURE_UNACTIONABLE]).toBe(true);
      expect(attrs[ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET]).toBe('empty');
    });

    it(`${sdk.name}: a descriptive isError result is not flagged, but still carries its bucket`, async () => {
      const attrs = await run(err(text('Customer 42 not found; check the id and retry')));
      expect(attrs[ATTR_MCP_FAILURE_UNACTIONABLE]).toBe(false);
      expect(attrs[ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET]).toBe('short');
    });

    it(`${sdk.name}: a success gets neither attribute`, async () => {
      const ok = await run({ content: [text('fine')] });
      expect(ATTR_MCP_FAILURE_UNACTIONABLE in ok).toBe(false);
      expect(ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET in ok).toBe(false);
    });

    it(`${sdk.name}: McpServer turns a throwing tool into an isError result, which is assessed like any other`, async () => {
      // McpServer catches the callback's throw and returns { isError: true,
      // content: [<message>] } -- core sees an isError result, not a throw.
      const attrs = await run(undefined, {}, true);
      expect(typeof attrs[ATTR_MCP_FAILURE_UNACTIONABLE]).toBe('boolean');
      expect(CONTENT_LENGTH_BUCKETS).toContain(attrs[ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET]);
    });

    it(`${sdk.name}: unactionableErrors.enabled: false sets nothing`, async () => {
      const attrs = await run(err(), { unactionableErrors: { enabled: false } });
      expect(ATTR_MCP_FAILURE_UNACTIONABLE in attrs).toBe(false);
    });

    it(`${sdk.name}: works with fingerprinting off (independent of it)`, async () => {
      const attrs = await run(err(text('Error')), { fingerprinting: false });
      expect(attrs[ATTR_MCP_FAILURE_UNACTIONABLE]).toBe(true);
      expect(attrs[ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET]).toBe('tiny');
    });

    it(`${sdk.name}: fingerprint and category are identical with the feature on or off`, async () => {
      const result = err(text('Error'));
      const on = await run(result);
      const off = await run(result, { unactionableErrors: { enabled: false } });
      expect(on[ATTRIBUTE_KEYS.FINGERPRINT]).toBeDefined();
      expect(on[ATTRIBUTE_KEYS.FINGERPRINT]).toBe(off[ATTRIBUTE_KEYS.FINGERPRINT]);
      expect(on[ATTRIBUTE_KEYS.CATEGORY]).toBe(off[ATTRIBUTE_KEYS.CATEGORY]);
    });
  }
});

describe('a genuinely thrown error (low-level Server) gets neither attribute', () => {
  it('only isError results are assessed', async () => {
    const spanExporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
    try {
      const server = new V1Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
      instrumentMcpServer(server, {});
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('kaboom');
      });
      await server._requestHandlers
        .get('tools/call')({ method: 'tools/call', params: { name: 't', arguments: {} } }, { requestId: 1, signal: new AbortController().signal })
        .catch(() => {});
      const attrs = spanExporter.getFinishedSpans()[0].attributes;
      expect(attrs['error.type']).toBe('TypeError');
      expect(ATTR_MCP_FAILURE_UNACTIONABLE in attrs).toBe(false);
      expect(ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET in attrs).toBe(false);
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
    }
  });
});

describe('privacy: no content text ever reaches spans or metrics (ADR 025)', () => {
  // Canaries that can't occur anywhere else, and that aren't SDK validation
  // messages (mcp.failure.validation_paths carries schema field NAMES from
  // those by design, ADR 009 -- a separate, pre-existing derivation).
  const CANARIES = ['CANARY-7f3a91e2', 'CANARY-b04c55d8', 'CANARY-e19d2a6f', 'CANARY-5c88f013'];
  const RESULTS = [
    err(text(CANARIES[0])), // short
    err(text(''), text(`${CANARIES[1]} ${chars(90)}`)), // medium, in content[1]
    err(text(`${CANARIES[2]}${chars(600)}`)), // long
    err(text(CANARIES[3].slice(0, 6))), // tiny prefix of a canary
    err(text('   ')), // whitespace only
    err(), // empty
  ];

  class TestMetricReader extends MetricReader {
    onForceFlush() {
      return Promise.resolve();
    }
    onShutdown() {
      return Promise.resolve();
    }
  }

  let spanExporter;
  let provider;
  let reader;
  let meterProvider;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
    reader = new TestMetricReader();
    meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    await provider.shutdown();
    await meterProvider.shutdown();
    trace.disable();
    context.disable();
    metrics.disable();
  });

  for (const fingerprinting of [false, true]) {
    it(`fingerprinting ${fingerprinting ? 'on' : 'off'}: canaries absent from every exported span and metric data point`, async () => {
      const mcp = new V1McpServer({ name: 'privacy', version: '0' });
      instrumentMcpServer(mcp, { fingerprinting });
      let i = 0;
      mcp.registerTool('leaky', { description: 'returns canary errors' }, async () => RESULTS[i++]);
      const call = mcp.server._requestHandlers.get('tools/call');
      for (let n = 0; n < RESULTS.length; n++) {
        await call(
          { method: 'tools/call', params: { name: 'leaky', arguments: {} } },
          { requestId: n, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} },
        );
      }

      const spans = spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(RESULTS.length);
      const spanDump = JSON.stringify(
        spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links })),
      );
      const { resourceMetrics } = await reader.collect();
      const metricDump = JSON.stringify(resourceMetrics);

      for (const canary of [...CANARIES, CANARIES[3].slice(0, 6)]) {
        expect(spanDump).not.toContain(canary);
        expect(metricDump).not.toContain(canary);
      }

      // The feature's own attributes only ever take their fixed values.
      expect(spans.map((s) => s.attributes[ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET])).toEqual([
        'short',
        'medium',
        'long',
        'tiny',
        'empty',
        'empty',
      ]);
      expect(spans.map((s) => s.attributes[ATTR_MCP_FAILURE_UNACTIONABLE])).toEqual([false, false, false, true, true, true]);
      // ...and neither is ever a metric label.
      expect(metricDump).not.toContain(ATTR_MCP_FAILURE_UNACTIONABLE);
      expect(metricDump).not.toContain(ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET);
    });
  }

  it('neither attribute is on any METRIC_SAFE_ATTRIBUTES list', () => {
    for (const list of [METRIC_SAFE_ATTRIBUTES, FINGERPRINT_METRIC_SAFE]) {
      expect(list).not.toContain(ATTR_MCP_FAILURE_UNACTIONABLE);
      expect(list).not.toContain(ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET);
    }
  });
});
