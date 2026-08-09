import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { SPAN_EVENT_NAME_LOOP_DETECTED } from '../../src/thrash/attributes.js';

/**
 * ADR 007, Phase 3 (docs/adr/007-protocol-error-channel.md): origin-aware
 * thrash detection, end to end through the public instrumentMcpServer()
 * entry point (not just the isolated ThrashDetector — see
 * test/thrash/detector.channel.test.js for that). This file's central
 * concern is the FALSE POSITIVE external review raised: a tool whose
 * OUTPUT fails its own declared schema is a server-side bug, not agent
 * thrash, and must never fire mcp.tool.loop.detected no matter how many
 * times a client retries it.
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

let spanExporter;
let traceProvider;
let metricReader;
let meterProvider;

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

describe('regression: the output-validation false positive from external review no longer fires', () => {
  it('never fires mcp.tool.loop.detected for a deterministic output-validation bug, however many times it repeats', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      // A real tool handler bug: it always produces output that fails its
      // own declared output schema. No argument the caller supplies can
      // ever fix this — it is a pure server-side defect.
      throw new McpError(
        ErrorCode.InvalidParams,
        'Output validation error: Tool broken-tool has an output schema but no structured content was provided',
      );
    });

    // Far more than any configured threshold (default execution threshold
    // is 3) — before ADR 007 Phase 3, this would already have fired
    // mcp.tool.loop.detected at the 3rd call.
    for (let i = 0; i < 10; i++) {
      await expect(invokeToolCall(server, { name: 'broken-tool', arguments: { attempt: i } })).rejects.toThrow();
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected).toBeUndefined();

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(10);
    for (const span of spans) {
      expect(span.events.filter((e) => e.name === SPAN_EVENT_NAME_LOOP_DETECTED)).toHaveLength(0);
    }
  });

  it('getThrashSummary() reports zero loops for the repeated output-validation failure', async () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, {
      serviceName: 'svc',
      thrashDetection: { assumeSingleSession: true },
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Output validation error: Invalid structured content for tool broken-tool: shape mismatch',
      );
    });

    for (let i = 0; i < 10; i++) {
      await expect(invokeToolCall(server, { name: 'broken-tool', arguments: {} })).rejects.toThrow();
    }

    const summary = instrumented.getThrashSummary();
    expect(summary.activeLoops).toBe(0);
    expect(summary.totalLoopsDetected).toBe(0);
  });

  it('contrast: the same repeat count on a genuine execution-channel (isError: true) failure DOES thrash — proving the exclusion is specific to protocol.output, not a global regression', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'upstream service unavailable' }],
    }));

    for (let i = 0; i < 3; i++) {
      await invokeToolCall(server, { name: 'flaky-upstream', arguments: {} });
    }

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });
});

describe('per-origin thresholds, end to end', () => {
  it('protocol.not_found flags on the very first call (default notFoundThreshold: 1)', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Tool ghost-tool not found');
    });

    await expect(invokeToolCall(server, { name: 'ghost-tool', arguments: {} })).rejects.toThrow();

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });

  it('protocol.input does not flag until the higher inputThreshold (default 5), unlike execution\'s threshold of 3', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool foo: bad shape');
    });

    for (let i = 0; i < 4; i++) {
      await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();
    }
    let { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow(); // 5th call
    ({ resourceMetrics } = await metricReader.collect());
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });

  it('protocol.input threshold is configurable via thrashDetection.inputThreshold', async () => {
    const server = createServer();
    instrumentMcpServer(server, {
      serviceName: 'svc',
      thrashDetection: { assumeSingleSession: true, inputThreshold: 2 },
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool foo: bad shape');
    });

    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();
    await expect(invokeToolCall(server, { name: 'foo', arguments: {} })).rejects.toThrow();

    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });
});

describe('mixed-origin failures on one tool do not merge into a single loop (end to end)', () => {
  it('a not_found failure followed by input-validation failures on the same tool name track independently', async () => {
    const server = createServer();
    instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { assumeSingleSession: true } });

    let mode = 'not_found';
    server.setRequestHandler(CallToolRequestSchema, async () => {
      if (mode === 'not_found') {
        throw new McpError(ErrorCode.InvalidParams, 'Tool same-name not found');
      }
      throw new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool same-name: x');
    });

    // protocol.not_found flags immediately (threshold 1).
    await expect(invokeToolCall(server, { name: 'same-name', arguments: {} })).rejects.toThrow();
    let { resourceMetrics } = await metricReader.collect();
    let detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);

    // Switch to protocol.input on the SAME tool name. If these merged into
    // one loop, the very first input-validation call here would already
    // be "count 2" of a shared loop; instead it must start a fresh
    // protocol.input episode requiring its own 5 calls to flag.
    mode = 'input';
    for (let i = 0; i < 4; i++) {
      await expect(invokeToolCall(server, { name: 'same-name', arguments: {} })).rejects.toThrow();
    }
    ({ resourceMetrics } = await metricReader.collect());
    detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    // Still exactly 1 total detection (the not_found one) -- the 4
    // input-validation calls haven't crossed inputThreshold (5) yet.
    expect(detected.dataPoints[0].value).toBe(1);

    await expect(invokeToolCall(server, { name: 'same-name', arguments: {} })).rejects.toThrow(); // 5th input-validation call
    ({ resourceMetrics } = await metricReader.collect());
    detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(2); // not_found's detection + input's own, independent detection
  });
});
