import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics, diag, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { z } from 'zod';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Server as V2Server, McpServer as V2McpServer } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../src/instrument.js';
import { FRESHNESS_META_KEY } from '../src/staleness.js';

/**
 * Security item B3 (v0.17.0): with EVERY feature on at once (fingerprinting,
 * cost + budget, thrash, schema drift, unactionable errors, resources and
 * prompts coverage, staleness with a config override), a distinctive canary
 * in every input a client or tool controls must never appear in any
 * exported span (names, attributes, events, status), any metric, or any
 * diag output at any level.
 *
 * Tool and prompt NAMES are captured by design (gen_ai.tool.name,
 * gen_ai.prompt.name), so canaries go in values only. A low-level Server
 * handler that THROWS an error carrying its own arguments is the
 * errorRecording channel, covered separately (security.secrets.test.js);
 * here a tool that fails does so via isError content, and the McpServer
 * shapes turn a throwing callback into exactly that.
 */

const C = {
  arg: 'CANARY-ARG-a1f3',
  content: 'CANARY-CONTENT-b2e4',
  structured: 'CANARY-STRUCT-c3d5',
  metaOther: 'CANARY-META-d4c6',
  freshExtra: 'CANARY-FRESH-e5b7',
  errorContent: 'CANARY-ERRTEXT-f6a8',
  thrownFromArg: 'CANARY-THROWN-0a9b',
  uri: 'canary-uri-1b8c',
  promptArg: 'CANARY-PROMPTARG-2c7d',
  requestMeta: 'CANARY-REQMETA-3d6e',
  schemaDesc: 'CANARY-SCHEMADESC-4e5f',
};
const CANARY_URI = `canary://${C.uri}/customers/42`;

const ALL_FEATURES = {
  fingerprinting: true,
  costTracking: { budget: { perSessionUsd: 0.000001, perToolUsd: 0.000001 } },
  thrashDetection: { assumeSingleSession: true, threshold: 2 },
  schemaDrift: { enabled: true },
  unactionableErrors: { enabled: true },
  coverage: { resources: true, prompts: true },
  staleness: { tools: { quote: { maxAgeMs: 1_000 } } },
};

class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

const v1Extra = () => ({ requestId: 1, sessionId: 's1', signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} });
const v2Ctx = (method) => ({
  sessionId: 's1',
  mcpReq: { id: 1, method, signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
});

// What each tool returns. Model + usage so cost attribution and the budget run.
const okResult = () => ({
  content: [{ type: 'text', text: `quote ${C.content}` }],
  structuredContent: { note: C.structured },
  usage: { input_tokens: 100, output_tokens: 50 },
  model: 'claude-sonnet-5',
  _meta: {
    other: C.metaOther,
    [FRESHNESS_META_KEY]: { asOf: Date.now() - 60_000, maxAgeMs: 5_000, note: C.freshExtra },
  },
});
const errResult = () => ({ isError: true, content: [{ type: 'text', text: `lookup failed ${C.errorContent}` }] });
const tinyErrResult = () => ({ isError: true, content: [{ type: 'text', text: 'E' }] });

function build(sdk, api) {
  if (api === 'Server') {
    const server =
      sdk === 'v1'
        ? new V1Server({ name: 's', version: '0' }, { capabilities: { resources: {}, prompts: {}, tools: {} } })
        : new V2Server({ name: 's', version: '0' }, { capabilities: { resources: {}, prompts: {}, tools: {} } });
    instrumentMcpServer(server, ALL_FEATURES);
    const reg = (schema, method, handler) => (sdk === 'v1' ? server.setRequestHandler(schema, handler) : server.setRequestHandler(method, handler));
    reg(CallToolRequestSchema, 'tools/call', async (req) => {
      if (req.params.name === 'quote') return okResult();
      if (req.params.name === 'tiny') return tinyErrResult();
      return errResult();
    });
    reg(ListToolsRequestSchema, 'tools/list', async () => ({
      tools: [{ name: 'quote', description: C.schemaDesc, inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: C.schemaDesc } } } }],
    }));
    reg(ReadResourceRequestSchema, 'resources/read', async (req) => {
      if (req.params.uri.endsWith('/missing')) throw new Error(`Resource ${req.params.uri} not found`);
      return { contents: [{ uri: req.params.uri, text: `body ${C.content}` }] };
    });
    reg(ListResourcesRequestSchema, 'resources/list', async () => ({ resources: [{ uri: CANARY_URI, name: 'c' }] }));
    reg(ListResourceTemplatesRequestSchema, 'resources/templates/list', async () => ({ resourceTemplates: [] }));
    reg(GetPromptRequestSchema, 'prompts/get', async (req) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `hello ${req.params.arguments?.who}` } }],
    }));
    reg(ListPromptsRequestSchema, 'prompts/list', async () => ({ prompts: [{ name: 'greet' }] }));
    return server;
  }

  const mcp = sdk === 'v1' ? new V1McpServer({ name: 'm', version: '0' }) : new V2McpServer({ name: 'm', version: '0' });
  instrumentMcpServer(mcp, ALL_FEATURES);
  const schema = sdk === 'v1' ? { symbol: z.string().describe(C.schemaDesc) } : z.object({ symbol: z.string().describe(C.schemaDesc) });
  mcp.registerTool('quote', { description: C.schemaDesc, inputSchema: schema }, async () => okResult());
  mcp.registerTool('lookup', { inputSchema: schema }, async () => errResult());
  mcp.registerTool('tiny', { inputSchema: schema }, async () => tinyErrResult());
  mcp.registerTool('explode', { inputSchema: schema }, async ({ symbol }) => {
    throw new Error(`cannot price ${symbol} ${C.thrownFromArg}`);
  });
  mcp.registerResource('customer', CANARY_URI, { description: 'c' }, async (uri) => ({ contents: [{ uri: uri.href, text: `body ${C.content}` }] }));
  mcp.registerPrompt(
    'greet',
    { description: 'g', argsSchema: sdk === 'v1' ? { who: z.string() } : z.object({ who: z.string() }) },
    async ({ who }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `hello ${who}` } }] }),
  );
  return mcp.server;
}

async function call(sdk, inner, method, params) {
  const handler = inner._requestHandlers.get(method);
  if (!handler) return undefined;
  return handler({ method, params }, sdk === 'v1' ? v1Extra() : v2Ctx(method)).catch((e) => e);
}

describe('B3: no client or tool content anywhere, with every feature on', () => {
  let spanExporter;
  let provider;
  let reader;
  let meterProvider;
  let diagLines;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    provider.register({ contextManager: null, propagator: null });
    reader = new TestMetricReader();
    meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    diagLines = [];
    const capture = (...args) =>
      diagLines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    diag.setLogger({ error: capture, warn: capture, info: capture, debug: capture, verbose: capture }, { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true });
  });

  afterEach(async () => {
    await provider.shutdown();
    await meterProvider.shutdown();
    trace.disable();
    context.disable();
    metrics.disable();
    diag.disable();
  });

  for (const sdk of ['v1', 'v2']) {
    for (const api of ['Server', 'McpServer']) {
      it(`${sdk} ${api}`, async () => {
        const inner = build(sdk, api);
        const requestMeta = { note: C.requestMeta, traceparent: C.requestMeta };
        const args = { symbol: C.arg };

        await call(sdk, inner, 'tools/list', {});
        for (const name of ['quote', 'lookup', 'lookup', 'lookup', 'tiny', ...(api === 'McpServer' ? ['explode', 'explode'] : [])]) {
          await call(sdk, inner, 'tools/call', { name, arguments: args, _meta: requestMeta });
        }
        await call(sdk, inner, 'tools/list', {});
        await call(sdk, inner, 'resources/read', { uri: CANARY_URI, _meta: requestMeta });
        await call(sdk, inner, 'resources/read', { uri: `${CANARY_URI}/missing` });
        await call(sdk, inner, 'resources/list', {});
        await call(sdk, inner, 'resources/templates/list', {});
        await call(sdk, inner, 'prompts/get', { name: 'greet', arguments: { who: C.promptArg }, _meta: requestMeta });
        await call(sdk, inner, 'prompts/list', {});

        const spans = spanExporter.getFinishedSpans();
        // Sanity: the features actually ran.
        const attrs = spans.map((s) => s.attributes);
        expect(attrs.some((a) => a['mcp.tool.freshness.verdict'] === 'stale')).toBe(true);
        expect(attrs.some((a) => a['mcp.failure.unactionable'] === true)).toBe(true);
        expect(attrs.some((a) => typeof a['mcp.failure.fingerprint'] === 'string')).toBe(true);
        expect(attrs.some((a) => a['mcp.tool.cost.usd'] !== undefined)).toBe(true);
        expect(spans.some((s) => s.name === 'resources/read')).toBe(true);
        expect(spans.some((s) => s.name === 'prompts/get greet')).toBe(true);

        const spanDump = JSON.stringify(
          spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links })),
        );
        const { resourceMetrics } = await reader.collect();
        const metricDump = JSON.stringify(resourceMetrics.scopeMetrics);
        const diagDump = diagLines.join('\n');
        // Positive controls: the dumps do carry what's captured by design,
        // and diag output was captured, so an absent canary means something.
        expect(spanDump).toContain('tools/call quote');
        expect(spanDump).toContain('prompts/get greet');
        expect(metricDump).toContain('quote');
        expect(diagLines.length).toBeGreaterThan(0);
        for (const [label, canary] of Object.entries(C)) {
          expect(spanDump, `${label} reached a span`).not.toContain(canary);
          expect(metricDump, `${label} reached a metric`).not.toContain(canary);
          expect(diagDump, `${label} reached diag output`).not.toContain(canary);
        }
      });
    }
  }
});
