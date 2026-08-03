import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';

/**
 * ADR 007 Phase 2: mcp.failure.channel span attribute (protocol vs.
 * execution channel), wired via classifyFailureChannel()
 * (src/fingerprint/classify/channel.js) into both of
 * wrapToolCallHandler()'s existing failure branches. See ADR
 * 007 (docs/adr/007-protocol-error-channel.md) for the design.
 */

/** Fresh, unconnected low-level Server — every test builds its own. */
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

describe('mcp.failure.channel — protocol-channel (thrown) failures', () => {
  it('sets span status ERROR and mcp.failure.channel: protocol.not_found for a re-thrown "tool not found" McpError', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Tool ghost-tool not found');
    });

    await expect(invokeToolCall(server, { name: 'ghost-tool', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.not_found');
  });

  it('sets mcp.failure.channel: protocol.input for a re-thrown input-validation McpError', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool foo: bad shape');
    });

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.input');
  });

  it('sets mcp.failure.channel: protocol.output for a re-thrown output-validation McpError', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Output validation error: Tool foo has an output schema but no structured content was provided',
      );
    });

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.output');
  });

  it('sets mcp.failure.channel: protocol.other for an InternalError McpError', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InternalError, 'something unrelated broke');
    });

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.other');
  });

  it('sets mcp.failure.channel: unknown for a plain thrown Error with no JSON-RPC code', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new TypeError('unrelated bug in the handler');
    });

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('unknown');
  });

  it('still sets span status ERROR when fingerprinting (and therefore channel classification) is disabled', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', fingerprinting: false });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Tool ghost-tool not found');
    });

    await expect(invokeToolCall(server, { name: 'ghost-tool', arguments: {} })).rejects.toThrow();

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBeUndefined();
  });
});

describe('mcp.failure.channel — execution-channel (isError: true) behaviour is unchanged', () => {
  it('sets mcp.failure.channel: execution and preserves existing ERROR status / mcp.failure.origin behaviour', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'invalid input: missing field "email"' }],
    }));

    const result = await invokeToolCall(server, { name: 'foo', arguments: {} });
    expect(result.isError).toBe(true);

    const [span] = spanExporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTRIBUTE_KEYS.ORIGIN]).toBe('tool_error');
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('execution');
  });

  it('does not throw and returns the isError result unchanged (no behaviour regression from adding channel)', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc' });
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    server.setRequestHandler(CallToolRequestSchema, async () => errorResult);

    const result = await invokeToolCall(server, { name: 'foo', arguments: {} });
    expect(result).toEqual(errorResult);
  });
});
