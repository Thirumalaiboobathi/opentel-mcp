import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, metrics, diag, DiagLogLevel, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer as V1McpServer, ResourceTemplate as V1ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Server as V2Server,
  McpServer as V2McpServer,
  ResourceTemplate as V2ResourceTemplate,
} from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../src/instrument.js';
import { ATTR_MCP_METHOD_NAME, ATTR_GEN_AI_TOOL_NAME, ATTR_GEN_AI_PROMPT_NAME, ATTR_ERROR_TYPE } from '../src/attributes.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';

/**
 * ADR 026: opt-in resources/* and prompts/* coverage, on SDK v1 and v2,
 * low-level Server and McpServer. Handlers are invoked white-box through
 * the private `_requestHandlers` map (test-only, as in the other
 * instrument.*.test.js files).
 */

const CANARY_URI = 'canary://secret-7d41/customers/42';
const CANARY_ARG = 'CANARY-ARG-3e9b';
const COVERED = ['resources/read', 'resources/list', 'resources/templates/list', 'prompts/get', 'prompts/list'];
const BOTH = { coverage: { resources: true, prompts: true } };

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
  diag.disable();
  vi.restoreAllMocks();
});

const v1Extra = () => ({ requestId: 7, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} });
const v2Ctx = (method) => ({
  mcpReq: { id: 7, method, signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
});

const REQUESTS = {
  'resources/read': { uri: CANARY_URI },
  'resources/list': {},
  'resources/templates/list': {},
  'prompts/get': { name: 'greet', arguments: { who: CANARY_ARG } },
  'prompts/list': {},
};

/** Builds a server for (sdk, api), instruments it with `options`, registers one handler per method. */
function build(sdk, api, options) {
  if (api === 'Server') {
    const server =
      sdk === 'v1'
        ? new V1Server({ name: 's', version: '0' }, { capabilities: { resources: {}, prompts: {}, tools: {} } })
        : new V2Server({ name: 's', version: '0' }, { capabilities: { resources: {}, prompts: {}, tools: {} } });
    instrumentMcpServer(server, options);
    const reg = (v1Schema, method, handler) =>
      sdk === 'v1' ? server.setRequestHandler(v1Schema, handler) : server.setRequestHandler(method, handler);
    reg(ReadResourceRequestSchema, 'resources/read', async (req) => ({
      contents: [{ uri: req.params.uri, text: 'resource body' }],
    }));
    reg(ListResourcesRequestSchema, 'resources/list', async () => ({ resources: [{ uri: CANARY_URI, name: 'c' }] }));
    reg(ListResourceTemplatesRequestSchema, 'resources/templates/list', async () => ({ resourceTemplates: [] }));
    reg(GetPromptRequestSchema, 'prompts/get', async (req) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `hello ${req.params.arguments?.who}` } }],
    }));
    reg(ListPromptsRequestSchema, 'prompts/list', async () => ({ prompts: [{ name: 'greet' }] }));
    return { inner: server };
  }

  const mcp = sdk === 'v1' ? new V1McpServer({ name: 'm', version: '0' }) : new V2McpServer({ name: 'm', version: '0' });
  instrumentMcpServer(mcp, options);
  const Template = sdk === 'v1' ? V1ResourceTemplate : V2ResourceTemplate;
  mcp.registerResource('customer', CANARY_URI, { description: 'c' }, async (uri) => ({
    contents: [{ uri: uri.href, text: 'resource body' }],
  }));
  mcp.registerResource('by-id', new Template('canary://item/{id}', { list: undefined }), { description: 't' }, async (uri) => ({
    contents: [{ uri: uri.href, text: 'item' }],
  }));
  mcp.registerPrompt('greet', { description: 'g' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
  }));
  return { inner: mcp.server };
}

async function invoke(sdk, inner, method, params = REQUESTS[method]) {
  const handler = inner._requestHandlers.get(method);
  if (!handler) throw new Error(`no ${method} handler`);
  return handler({ method, params }, sdk === 'v1' ? v1Extra() : v2Ctx(method));
}

const spansFor = (method) => spanExporter.getFinishedSpans().filter((s) => s.attributes[ATTR_MCP_METHOD_NAME] === method);

for (const sdk of ['v1', 'v2']) {
  for (const api of ['Server', 'McpServer']) {
    describe(`${sdk} ${api}`, () => {
      for (const method of COVERED) {
        it(`${method}: one SERVER span, named by method, mcp.method.name set, gen_ai.tool.name absent`, async () => {
          const { inner } = build(sdk, api, BOTH);
          const result = await invoke(sdk, inner, method);
          expect(result).toBeDefined();

          const spans = spansFor(method);
          expect(spans).toHaveLength(1);
          const [span] = spans;
          expect(span.kind).toBe(SpanKind.SERVER);
          expect(span.name).toBe(method === 'prompts/get' ? 'prompts/get greet' : method);
          expect(span.status.code).toBe(SpanStatusCode.OK);
          expect(ATTR_GEN_AI_TOOL_NAME in span.attributes).toBe(false);
          if (method === 'prompts/get') expect(span.attributes[ATTR_GEN_AI_PROMPT_NAME]).toBe('greet');
          else expect(ATTR_GEN_AI_PROMPT_NAME in span.attributes).toBe(false);
          expect(span.attributes['jsonrpc.request.id']).toBe('7');
        });
      }

      it('coverage off (the default): no resource/prompt spans at all', async () => {
        const { inner } = build(sdk, api, {});
        for (const method of COVERED) await invoke(sdk, inner, method);
        for (const method of COVERED) expect(spansFor(method)).toHaveLength(0);
      });

      it('coverage.resources only: resource methods traced, prompt methods not', async () => {
        const { inner } = build(sdk, api, { coverage: { resources: true } });
        for (const method of COVERED) await invoke(sdk, inner, method);
        expect(spansFor('resources/read')).toHaveLength(1);
        expect(spansFor('prompts/get')).toHaveLength(0);
        expect(spansFor('prompts/list')).toHaveLength(0);
      });

      it('a failing resources/read: ERROR span with error.type and fingerprint, error rethrown unchanged, no URI or message on the span', async () => {
        const { inner } = build(sdk, api, BOTH);
        if (api === 'Server') {
          // Re-register to throw, as a real handler would for an unknown URI.
          inner.removeRequestHandler?.('resources/read');
          inner._requestHandlers.delete('resources/read');
          const thrower = async (req) => {
            throw Object.assign(new Error(`Resource ${req.params.uri} not found`), { name: 'ResourceNotFound' });
          };
          if (sdk === 'v1') inner.setRequestHandler(ReadResourceRequestSchema, thrower);
          else inner.setRequestHandler('resources/read', thrower);
        }
        const missing = `${CANARY_URI}/missing`;
        await expect(invoke(sdk, inner, 'resources/read', { uri: missing })).rejects.toThrow();

        const [span] = spansFor('resources/read');
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(typeof span.attributes[ATTR_ERROR_TYPE]).toBe('string');
        expect(typeof span.attributes[ATTRIBUTE_KEYS.FINGERPRINT]).toBe('string');
        expect(typeof span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('string');
        expect(span.events).toHaveLength(0);
        expect(span.status.message ?? '').toBe('');
        expect(JSON.stringify({ a: span.attributes, s: span.status, n: span.name })).not.toContain('secret-7d41');
      });

      it('privacy: resource URIs and prompt arguments never reach spans or metrics', async () => {
        const { inner } = build(sdk, api, BOTH);
        for (const method of COVERED) await invoke(sdk, inner, method);
        const spanDump = JSON.stringify(
          spanExporter.getFinishedSpans().map((s) => ({ n: s.name, a: s.attributes, e: s.events, s: s.status })),
        );
        const { resourceMetrics } = await reader.collect();
        const metricDump = JSON.stringify(resourceMetrics);
        for (const canary of ['secret-7d41', CANARY_ARG]) {
          expect(spanDump).not.toContain(canary);
          expect(metricDump).not.toContain(canary);
        }
      });
    });
  }
}

describe('metrics: mcp.server.operation.duration', () => {
  it('records each covered method, labeled only by mcp.method.name (+ error.type), from the fixed set', async () => {
    const { inner } = build('v1', 'McpServer', BOTH);
    for (const method of COVERED) await invoke('v1', inner, method);
    await invoke('v1', inner, 'resources/read', { uri: 'canary://nope' }).catch(() => {});

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'mcp.server.operation.duration');
    expect(metric).toBeDefined();
    const labelSets = metric.dataPoints.map((p) => p.attributes);
    for (const labels of labelSets) {
      expect(Object.keys(labels).every((k) => k === 'mcp.method.name' || k === 'error.type')).toBe(true);
      expect(COVERED).toContain(labels['mcp.method.name']);
    }
    expect(new Set(labelSets.map((l) => l['mcp.method.name']))).toEqual(new Set(COVERED));
    expect(labelSets.some((l) => l['mcp.method.name'] === 'resources/read' && typeof l['error.type'] === 'string')).toBe(true);
    // Tool metrics untouched: no tool was called.
    const toolCalls = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'mcp.tool.calls');
    expect(toolCalls?.dataPoints.length ?? 0).toBe(0);
  });
});

describe('already-registered handlers: skipped with one diag.warn, never a throw', () => {
  function captureWarnings() {
    const warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
    return () => warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('coverage requested'));
  }

  it('v1 Server: resource handlers registered first are skipped; later prompt handlers and tools are still wrapped', async () => {
    const warnings = captureWarnings();
    const server = new V1Server({ name: 's', version: '0' }, { capabilities: { resources: {}, prompts: {}, tools: {} } });
    server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [] }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

    expect(() => instrumentMcpServer(server, BOTH)).not.toThrow();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('resources/read');
    expect(warnings()[0]).toContain('resources/list');
    expect(warnings()[0]).not.toContain('prompts/get');

    server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
    await invoke('v1', server, 'resources/read');
    await invoke('v1', server, 'prompts/get');
    await server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'x', arguments: {} } }, v1Extra());

    expect(spansFor('resources/read')).toHaveLength(0);
    expect(spansFor('prompts/get')).toHaveLength(1);
    expect(spansFor('tools/call')).toHaveLength(1);
  });

  it('v1 McpServer: a resource registered before instrumenting is skipped (warned), prompts registered after are traced', async () => {
    const warnings = captureWarnings();
    const mcp = new V1McpServer({ name: 'm', version: '0' });
    mcp.registerResource('early', 'canary://early', {}, async (uri) => ({ contents: [{ uri: uri.href, text: 'x' }] }));
    expect(() => instrumentMcpServer(mcp, BOTH)).not.toThrow();
    expect(warnings()).toHaveLength(1);
    mcp.registerPrompt('greet', { description: 'g' }, async () => ({ messages: [] }));
    await invoke('v1', mcp.server, 'resources/read', { uri: 'canary://early' });
    await invoke('v1', mcp.server, 'prompts/get', { name: 'greet' });
    expect(spansFor('resources/read')).toHaveLength(0);
    expect(spansFor('prompts/get')).toHaveLength(1);
  });

  it('v2 McpServer declaring capabilities.resources/prompts (handlers installed in its constructor): no throw, one warning, tools still work', async () => {
    const warnings = captureWarnings();
    const mcp = new V2McpServer({ name: 'm', version: '0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    expect(() => instrumentMcpServer(mcp, BOTH)).not.toThrow();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/resources\/read.*prompts\/list/);
    mcp.registerTool('echo', { description: 'e' }, async () => ({ content: [] }));
    await mcp.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 'echo', arguments: {} } }, v2Ctx('tools/call'));
    expect(spansFor('tools/call')).toHaveLength(1);
  });

  it('nothing pre-registered: no warning', () => {
    const warnings = captureWarnings();
    instrumentMcpServer(new V1McpServer({ name: 'm', version: '0' }), BOTH);
    expect(warnings()).toHaveLength(0);
  });

  it('coverage off: pre-registered resource handlers are not even checked (no warning, as before 0.16)', () => {
    const warnings = captureWarnings();
    const server = new V1Server({ name: 's', version: '0' }, { capabilities: { resources: {} } });
    server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [] }));
    expect(() => instrumentMcpServer(server, {})).not.toThrow();
    expect(warnings()).toHaveLength(0);
  });
});
