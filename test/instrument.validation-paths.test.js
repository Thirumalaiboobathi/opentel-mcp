import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { ATTRIBUTE_KEYS, METRIC_SAFE_ATTRIBUTES } from '../src/fingerprint/attributes.js';

/**
 * ADR 009 Phase 2: mcp.failure.validation_paths span attribute, wired into
 * both of wrapToolCallHandler()'s failure branches. See
 * docs/adr/009-field-level-convergence.md.
 */

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

class TestMetricReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  traceProvider.register();

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

describe('mcp.failure.validation_paths — real McpServer (isError: true, disguised)', () => {
  it('sets the attribute to the failing field(s) for a real Zod input-validation failure', async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
    const instrumented = instrumentMcpServer(mcpServer, { serviceName: 'svc' });
    instrumented.registerTool(
      'my-tool',
      { description: 'test', inputSchema: { email: z.string().email(), age: z.number() } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );

    const handler = mcpServer.server._requestHandlers.get('tools/call');
    await handler(
      { method: 'tools/call', params: { name: 'my-tool', arguments: { email: 'not-an-email', age: 'nope' } } },
      { requestId: 1 },
    );

    const [span] = spanExporter.getFinishedSpans();
    expect(span.attributes[ATTRIBUTE_KEYS.VALIDATION_PATHS]).toEqual(['email', 'age']);
  });

  it('omits the attribute entirely for a genuine business-logic isError: true failure', async () => {
    const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {} } });
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'upstream service unavailable' }],
    }));

    const handler = server._requestHandlers.get('tools/call');
    await handler({ method: 'tools/call', params: { name: 'foo', arguments: {} } }, { requestId: 1 });

    const [span] = spanExporter.getFinishedSpans();
    expect(ATTRIBUTE_KEYS.VALIDATION_PATHS in span.attributes).toBe(false);
  });

  it('omits the attribute entirely when fingerprinting is disabled', async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
    const instrumented = instrumentMcpServer(mcpServer, { serviceName: 'svc', fingerprinting: false });
    instrumented.registerTool(
      'my-tool',
      { description: 'test', inputSchema: { email: z.string().email() } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );

    const handler = mcpServer.server._requestHandlers.get('tools/call');
    await handler(
      { method: 'tools/call', params: { name: 'my-tool', arguments: { email: 'not-an-email' } } },
      { requestId: 1 },
    );

    const [span] = spanExporter.getFinishedSpans();
    expect(ATTRIBUTE_KEYS.VALIDATION_PATHS in span.attributes).toBe(false);
  });
});

describe('mcp.failure.validation_paths — thrown McpError (low-level Server)', () => {
  it('sets the attribute for a thrown McpError carrying a Zod issues array', async () => {
    const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {} } });
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Input validation error: Invalid arguments for tool foo: [{"code":"invalid_type","path":["email"],"message":"bad"}]',
      );
    });

    const handler = server._requestHandlers.get('tools/call');
    await expect(
      handler({ method: 'tools/call', params: { name: 'foo', arguments: {} } }, { requestId: 1 }),
    ).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.attributes[ATTRIBUTE_KEYS.VALIDATION_PATHS]).toEqual(['email']);
  });

  it('omits the attribute for a thrown error with no embedded Zod JSON', async () => {
    const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {} } });
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new TypeError('unrelated bug');
    });

    const handler = server._requestHandlers.get('tools/call');
    await expect(
      handler({ method: 'tools/call', params: { name: 'foo', arguments: {} } }, { requestId: 1 }),
    ).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(ATTRIBUTE_KEYS.VALIDATION_PATHS in span.attributes).toBe(false);
  });
});

describe('mcp.failure.validation_paths — never a metric label', () => {
  it('is not present in METRIC_SAFE_ATTRIBUTES', () => {
    expect(METRIC_SAFE_ATTRIBUTES).not.toContain(ATTRIBUTE_KEYS.VALIDATION_PATHS);
  });
});
