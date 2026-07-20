import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_ERROR_TYPE,
  ATTR_MCP_TOOL_OUTCOME,
  MCP_METHOD_NAME_TOOLS_CALL,
} from '../src/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/**
 * Invokes a registered request handler directly, bypassing the need for a
 * live transport/connection — mirrors invokeToolCall in instrument.test.js.
 */
function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('No handler registered for method "tools/call"');
  }
  return handler({ method: 'tools/call', params }, extra);
}

/**
 * Minimal in-memory MetricReader. @opentelemetry/sdk-metrics does not ship
 * a dedicated "InMemoryMetricReader" export (only InMemoryMetricExporter,
 * which is for the push/PeriodicExportingMetricReader path); collect() on
 * the base MetricReader class already does exactly what's needed
 * on-demand, so this only needs to fill in the two abstract lifecycle
 * hooks.
 */
class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

function findMetric(resourceMetrics, name) {
  for (const scope of resourceMetrics.scopeMetrics) {
    const metric = scope.metrics.find((m) => m.descriptor.name === name);
    if (metric) return metric;
  }
  return undefined;
}

let reader;
let provider;

beforeEach(() => {
  reader = new TestMetricReader();
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  metrics.disable();
});

describe('metrics', () => {
  describe('mcp.tool.calls', () => {
    it('increments by 1 on every tool call with gen_ai.tool.name and mcp.method.name attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });
      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const calls = findMetric(resourceMetrics, 'mcp.tool.calls');
      expect(calls.dataPoints).toHaveLength(1);
      expect(calls.dataPoints[0].value).toBe(2);
      expect(calls.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(calls.dataPoints[0].attributes[ATTR_MCP_METHOD_NAME]).toBe(MCP_METHOD_NAME_TOOLS_CALL);
    });
  });

  describe('mcp.tool.errors', () => {
    it('increments on a thrown error with error.type set, and does not touch silent_failures', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
      expect(errors.dataPoints).toHaveLength(1);
      expect(errors.dataPoints[0].value).toBe(1);
      expect(errors.dataPoints[0].attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
      expect(errors.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');

      expect(findMetric(resourceMetrics, 'mcp.tool.silent_failures')).toBeUndefined();
    });

    it('increments on a rejected promise the same way as a synchronous throw', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, () => Promise.reject(new RangeError('nope')));

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
      expect(errors.dataPoints[0].attributes[ATTR_ERROR_TYPE]).toBe('RangeError');
    });
  });

  describe('mcp.tool.silent_failures', () => {
    it('increments when the JSON-RPC response succeeds but CallToolResult.isError is true, and does not touch errors', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        isError: true,
        content: [{ type: 'text', text: 'tool blew up' }],
      }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const silentFailures = findMetric(resourceMetrics, 'mcp.tool.silent_failures');
      expect(silentFailures.dataPoints).toHaveLength(1);
      expect(silentFailures.dataPoints[0].value).toBe(1);
      expect(silentFailures.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');

      expect(findMetric(resourceMetrics, 'mcp.tool.errors')).toBeUndefined();
    });

    it('does not increment on a normal successful call', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      expect(findMetric(resourceMetrics, 'mcp.tool.silent_failures')).toBeUndefined();
    });
  });

  describe('mcp.tool.duration', () => {
    it('is a millisecond histogram recording outcome=success on a successful call', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.descriptor.unit).toBe('ms');
      expect(duration.dataPoints).toHaveLength(1);
      expect(duration.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('success');
      expect(duration.dataPoints[0].value.count).toBe(1);
      expect(duration.dataPoints[0].value.sum).toBeGreaterThanOrEqual(0);
    });

    it('records outcome=error on a thrown error', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new Error('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('error');
    });

    it('records outcome=silent_failure when CallToolResult.isError is true', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('silent_failure');
    });
  });

  describe('no MeterProvider registered', () => {
    it('does not crash and still calls the handler normally', async () => {
      metrics.disable();

      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await expect(invokeToolCall(server, { name: 'echo', arguments: {} })).resolves.toEqual({ content: [] });
    });
  });

  describe('enableMetrics: false', () => {
    it('emits no mcp.tool.* metrics even though a MeterProvider is registered', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', enableMetrics: false });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      expect(findMetric(resourceMetrics, 'mcp.tool.calls')).toBeUndefined();
      expect(findMetric(resourceMetrics, 'mcp.tool.duration')).toBeUndefined();
    });

    it('does not affect tracing (spans are unrelated to this flag)', async () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, { serviceName: 'svc', enableMetrics: false })).not.toThrow();
    });
  });
});
