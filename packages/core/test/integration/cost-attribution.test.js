import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import {
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_MCP_TOOL_TOKENS_INPUT,
  ATTR_MCP_TOOL_TOKENS_OUTPUT,
  ATTR_MCP_TOOL_TOKENS_TOTAL,
  ATTR_MCP_TOOL_MODEL,
  ATTR_MCP_TOOL_COST_USD,
  ATTR_MCP_TOOL_COST_CURRENCY,
  MCP_TOOL_COST_CURRENCY_USD,
} from '../../src/attributes.js';
import { ATTRIBUTE_KEYS } from '../../src/fingerprint/attributes.js';
import { DEFAULT_PRICING } from '../../src/cost/pricing.js';
import { calculateCost } from '../../src/cost/calculator.js';

/** Fresh, unconnected low-level Server — every test builds its own (see test/instrument.fingerprint.test.js). */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/** Invokes a registered request handler directly, bypassing the need for a live transport/connection. */
function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('No handler registered for method "tools/call"');
  }
  return handler({ method: 'tools/call', params }, extra);
}

/** Registers one handler that dispatches by tool name to a `{ [toolName]: (args) => result }` map. */
function registerTools(server, toolsByName) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const impl = toolsByName[request.params.name];
    if (!impl) throw new Error(`no fixture registered for tool "${request.params.name}"`);
    return impl(request.params.arguments);
  });
}

/** Minimal in-memory MetricReader — mirrors test/metrics.test.js's TestMetricReader. */
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

function findDataPoint(metric, toolName) {
  return metric?.dataPoints.find((dp) => dp.attributes[ATTR_GEN_AI_TOOL_NAME] === toolName);
}

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  traceProvider.register({ contextManager: null, propagator: null });

  metricReader = new TestMetricReader();
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await traceProvider.shutdown();
  trace.disable();
  context.disable();
  spanExporter.reset();

  await meterProvider.shutdown();
  metrics.disable();
});

describe('cost attribution integration', () => {
  describe('Anthropic-format usage', () => {
    it('adds all 6 cost/token span attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_INPUT]).toBe(1000);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_OUTPUT]).toBe(500);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(1500);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('claude-sonnet-5');
      expect(span.attributes[ATTR_MCP_TOOL_COST_CURRENCY]).toBe(MCP_TOOL_COST_CURRENCY_USD);

      const expectedCost = calculateCost(1000, 500, 'claude-sonnet-5', DEFAULT_PRICING);
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeCloseTo(expectedCost, 6);
    });
  });

  describe('OpenAI-format usage', () => {
    it('adds all 6 cost/token span attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 300, completion_tokens: 120 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_INPUT]).toBe(300);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_OUTPUT]).toBe(120);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(420);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('gpt-4o');
      expect(span.attributes[ATTR_MCP_TOOL_COST_CURRENCY]).toBe(MCP_TOOL_COST_CURRENCY_USD);

      const expectedCost = calculateCost(300, 120, 'gpt-4o', DEFAULT_PRICING);
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeCloseTo(expectedCost, 6);
    });
  });

  describe('_meta.usage convention', () => {
    it('adds all 6 cost/token span attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          _meta: { usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-haiku-4-5' },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(15);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('claude-haiku-4-5');
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeCloseTo(
        calculateCost(10, 5, 'claude-haiku-4-5', DEFAULT_PRICING),
        6,
      );
    });
  });

  describe('JSON-in-text convention', () => {
    it('adds all 6 cost/token span attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 }, model: 'deepseek-v3' }),
            },
          ],
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(10);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('deepseek-v3');
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeCloseTo(calculateCost(7, 3, 'deepseek-v3', DEFAULT_PRICING), 6);
    });
  });

  describe('no usage present', () => {
    it('adds no cost/token attributes, and the span is otherwise unaffected', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({ content: [{ type: 'text', text: 'no usage info here' }] }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_INPUT]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_OUTPUT]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_COST_CURRENCY]).toBeUndefined();

      // Span is still a normal, valid, OK span — untouched by the absence of usage.
      expect(span.status.code).toBe(1); // SpanStatusCode.OK
      expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('ask');
    });
  });

  describe('cost calculation fails (unknown model)', () => {
    it('adds token attributes but not the cost attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'some-future-model-not-in-any-table',
          usage: { input_tokens: 50, output_tokens: 25 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_INPUT]).toBe(50);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_OUTPUT]).toBe(25);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(75);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('some-future-model-not-in-any-table');
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_COST_CURRENCY]).toBeUndefined();
    });
  });

  describe('usage present with no model detectable anywhere', () => {
    it('adds token attributes but no model or cost attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 4, output_tokens: 1 } }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(5);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeUndefined();
    });
  });

  describe('costTracking: { enabled: false }', () => {
    it('adds no cost/token attributes even when the result carries valid usage', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', costTracking: { enabled: false } });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      for (const key of [
        ATTR_MCP_TOOL_TOKENS_INPUT,
        ATTR_MCP_TOOL_TOKENS_OUTPUT,
        ATTR_MCP_TOOL_TOKENS_TOTAL,
        ATTR_MCP_TOOL_MODEL,
        ATTR_MCP_TOOL_COST_USD,
        ATTR_MCP_TOOL_COST_CURRENCY,
      ]) {
        expect(span.attributes[key]).toBeUndefined();
      }
    });
  });

  describe('custom pricingTable and extractor overrides', () => {
    it('prices a model absent from DEFAULT_PRICING when a custom pricingTable is supplied', async () => {
      const server = createServer();
      const pricingTable = { 'my-internal-model': { inputPer1M: 1, outputPer1M: 2, currency: 'USD' } };
      instrumentMcpServer(server, { serviceName: 'svc', costTracking: { pricingTable } });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'my-internal-model',
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBe(3);
    });

    it('recognizes a custom result shape via a custom extractor', async () => {
      const server = createServer();
      const extractor = (result) =>
        result?.tokenStats
          ? {
              inputTokens: result.tokenStats.in,
              outputTokens: result.tokenStats.out,
              totalTokens: result.tokenStats.in + result.tokenStats.out,
              model: result.tokenStats.modelId,
            }
          : null;
      instrumentMcpServer(server, { serviceName: 'svc', costTracking: { extractor } });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          tokenStats: { in: 2, out: 8, modelId: 'claude-sonnet-5' },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_INPUT]).toBe(2);
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_OUTPUT]).toBe(8);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('claude-sonnet-5');
    });
  });

  describe('tool-level failure (isError: true) path', () => {
    it('still adds cost/token attributes alongside the existing isError/fingerprint attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        broken: () => ({
          isError: true,
          content: [{ type: 'text', text: 'request rejected' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 40, output_tokens: 10 },
        }),
      });

      await invokeToolCall(server, { name: 'broken', arguments: {} });

      const [span] = spanExporter.getFinishedSpans();
      // v0.4.0 behavior must be unchanged: isError still marks the span ERROR and fingerprints.
      expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
      expect(span.attributes[ATTRIBUTE_KEYS.ORIGIN]).toBe('tool_error');
      expect(span.attributes[ATTRIBUTE_KEYS.CATEGORY]).toBeTruthy();

      // New in v0.5.0: cost/token attributes are present too.
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBe(50);
      expect(span.attributes[ATTR_MCP_TOOL_MODEL]).toBe('claude-sonnet-5');
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeCloseTo(
        calculateCost(40, 10, 'claude-sonnet-5', DEFAULT_PRICING),
        6,
      );
    });
  });

  describe('thrown-exception path', () => {
    it('adds no cost/token attributes (no result exists to extract from), and rethrows as before', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        flaky: () => {
          throw new Error('boom');
        },
      });

      await expect(invokeToolCall(server, { name: 'flaky', arguments: {} })).rejects.toThrow('boom');

      const [span] = spanExporter.getFinishedSpans();
      expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBeUndefined();
      expect(span.attributes[ATTR_MCP_TOOL_COST_USD]).toBeUndefined();
    });
  });

  describe('a throwing custom extractor', () => {
    it('never breaks the span or the tool call result', async () => {
      const server = createServer();
      const extractor = () => {
        throw new Error('extractor blew up');
      };
      instrumentMcpServer(server, { serviceName: 'svc', costTracking: { extractor } });
      registerTools(server, {
        ask: () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      });

      const result = await invokeToolCall(server, { name: 'ask', arguments: {} });
      expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } });

      const [span] = spanExporter.getFinishedSpans();
      expect(span.status.code).toBe(1); // SpanStatusCode.OK — cost tracking failure must not affect span outcome
      expect(span.attributes[ATTR_MCP_TOOL_TOKENS_TOTAL]).toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('records mcp.tool.tokens.total with tool_name and model attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const tokens = findMetric(resourceMetrics, 'mcp.tool.tokens.total');
      const dataPoint = findDataPoint(tokens, 'ask');
      expect(dataPoint.value).toBe(1500);
      expect(dataPoint.attributes[ATTR_MCP_TOOL_MODEL]).toBe('claude-sonnet-5');
      expect(Object.keys(dataPoint.attributes).sort()).toEqual([ATTR_GEN_AI_TOOL_NAME, ATTR_MCP_TOOL_MODEL].sort());
    });

    it('records mcp.tool.cost.total with the calculated cost', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const cost = findMetric(resourceMetrics, 'mcp.tool.cost.total');
      const dataPoint = findDataPoint(cost, 'ask');
      expect(dataPoint.value).toBeCloseTo(calculateCost(1000, 500, 'claude-sonnet-5', DEFAULT_PRICING), 6);
    });

    it('does not record mcp.tool.cost.total when the model is unknown (tokens still recorded)', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'unknown-model',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const tokens = findMetric(resourceMetrics, 'mcp.tool.tokens.total');
      expect(findDataPoint(tokens, 'ask')?.value).toBe(15);

      const cost = findMetric(resourceMetrics, 'mcp.tool.cost.total');
      expect(findDataPoint(cost, 'ask')).toBeUndefined();
    });

    it('records nothing on mcp.tool.tokens.total / mcp.tool.cost.total when there is no usage at all', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({ content: [{ type: 'text', text: 'no usage' }] }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const tokens = findMetric(resourceMetrics, 'mcp.tool.tokens.total');
      const cost = findMetric(resourceMetrics, 'mcp.tool.cost.total');
      expect(findDataPoint(tokens, 'ask')).toBeUndefined();
      expect(findDataPoint(cost, 'ask')).toBeUndefined();
    });

    it('does not record cost/token metrics when costTracking is disabled', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', costTracking: { enabled: false } });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const tokens = findMetric(resourceMetrics, 'mcp.tool.tokens.total');
      const cost = findMetric(resourceMetrics, 'mcp.tool.cost.total');
      expect(findDataPoint(tokens, 'ask')).toBeUndefined();
      expect(findDataPoint(cost, 'ask')).toBeUndefined();
    });

    it('keeps mcp.tool.calls / mcp.tool.duration recording unaffected by cost tracking (no regression)', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerTools(server, {
        ask: () => ({
          content: [{ type: 'text', text: 'hi' }],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });

      await invokeToolCall(server, { name: 'ask', arguments: {} });

      const { resourceMetrics } = await metricReader.collect();
      const calls = findMetric(resourceMetrics, 'mcp.tool.calls');
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(findDataPoint(calls, 'ask').value).toBe(1);
      expect(findDataPoint(duration, 'ask').value.count).toBe(1);
    });
  });
});
