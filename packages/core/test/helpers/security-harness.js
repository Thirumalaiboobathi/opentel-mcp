import { vi } from 'vitest';
import { trace, context, metrics, diag, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as V2Server, McpServer as V2McpServer } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../../src/instrument.js';

/**
 * Shared harness for the v0.18 security-observability tests (ADRs 027 amendment, 029-032): in-memory span and
 * metric capture, a diag logger that records everything at every level, and builders that run a handler through
 * a really instrumented server of each of the four SDK shapes.
 */

class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

export const v1Ctx = () => ({ requestId: 1, sessionId: 's1', signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} });
export const v2Ctx = (method = 'tools/call') => ({
  sessionId: 's1',
  mcpReq: { id: 1, method, signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
});

/** @returns {{ spans: () => any[], points: (name: string) => Promise<any[]>, allMetrics: () => Promise<any[]>, diagLines: string[], teardown: () => Promise<void> }} */
export function createHarness() {
  const spanExporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  provider.register({ contextManager: null, propagator: null });
  const reader = new TestMetricReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  const diagLines = [];
  const record = (level) => (...args) => diagLines.push(`${level}: ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  diag.setLogger({ error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug'), verbose: record('verbose') }, DiagLogLevel.ALL);

  return {
    spans: () => spanExporter.getFinishedSpans(),
    async allMetrics() {
      const { resourceMetrics } = await reader.collect();
      return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    },
    async points(name) {
      const { resourceMetrics } = await reader.collect();
      const found = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
      return found ? found.dataPoints : [];
    },
    diagLines,
    async teardown() {
      await provider.shutdown();
      trace.disable();
      context.disable();
      metrics.disable();
      diag.disable();
      vi.restoreAllMocks();
    },
  };
}

/**
 * Each shape builds an instrumented server whose single tool `name` runs `handler(args)`, and returns
 * `{ call(name?, args?), list(), server }`. `tools` is what tools/list returns (a function so tests can change it).
 */
export const SHAPES = [
  {
    name: 'v1 McpServer',
    build(options, handler, { toolName = 'get_quote' } = {}) {
      const mcp = new V1McpServer({ name: 't', version: '0' });
      const instrumented = instrumentMcpServer(mcp, options);
      mcp.registerTool(toolName, { description: 'q' }, async (args) => handler(args));
      const s = mcp.server;
      return {
        server: instrumented,
        call: (name = toolName, args = {}) => s._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, v1Ctx()),
        list: (params = {}) => s._requestHandlers.get('tools/list')({ method: 'tools/list', params }, v1Ctx()),
      };
    },
  },
  {
    name: 'v2 McpServer',
    build(options, handler, { toolName = 'get_quote' } = {}) {
      const mcp = new V2McpServer({ name: 't', version: '0' });
      const instrumented = instrumentMcpServer(mcp, options);
      mcp.registerTool(toolName, { description: 'q' }, async (args) => handler(args));
      const s = mcp.server;
      return {
        server: instrumented,
        call: (name = toolName, args = {}) => s._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, v2Ctx()),
        list: (params = {}) => s._requestHandlers.get('tools/list')({ method: 'tools/list', params }, v2Ctx('tools/list')),
      };
    },
  },
  {
    name: 'v1 Server',
    build(options, handler, { tools = () => [] } = {}) {
      const server = new V1Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
      const instrumented = instrumentMcpServer(server, options);
      server.setRequestHandler(CallToolRequestSchema, async (req) => handler(req.params.arguments, req.params.name));
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
      return {
        server: instrumented,
        call: (name = 'get_quote', args = {}) => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, v1Ctx()),
        list: (params = {}) => server._requestHandlers.get('tools/list')({ method: 'tools/list', params }, v1Ctx()),
      };
    },
  },
  {
    name: 'v2 Server',
    build(options, handler, { tools = () => [] } = {}) {
      const server = new V2Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
      const instrumented = instrumentMcpServer(server, options);
      server.setRequestHandler('tools/call', async (req) => handler(req.params.arguments, req.params.name));
      server.setRequestHandler('tools/list', async () => ({ tools: tools() }));
      return {
        server: instrumented,
        call: (name = 'get_quote', args = {}) => server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, v2Ctx()),
        list: (params = {}) => server._requestHandlers.get('tools/list')({ method: 'tools/list', params }, v2Ctx('tools/list')),
      };
    },
  },
];

/** The latest finished `tools/call` span. */
export const lastToolSpan = (h) => h.spans().filter((s) => s.name.startsWith('tools/call')).at(-1);
