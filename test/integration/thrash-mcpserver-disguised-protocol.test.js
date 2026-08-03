import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { ATTRIBUTE_KEYS } from '../../src/fingerprint/attributes.js';

/**
 * Regression test for a real, confirmed bug found during Phase 3
 * verification (ADR 007, docs/adr/007-protocol-error-channel.md):
 *
 * The high-level McpServer (`@modelcontextprotocol/sdk/server/mcp.js`) —
 * the ergonomic, documented `.tool()`/`.registerTool()` API most real MCP
 * servers use, not the low-level `Server` — catches essentially every
 * error its own tools/call dispatcher can produce (tool not found,
 * disabled, input validation, output validation, or any other bug in the
 * handler) and converts it to `isError: true` before wrapToolCallHandler
 * (src/instrument.js) ever sees a thrown error, with the sole exception
 * of UrlElicitationRequired errors.
 *
 * The first version of Phase 3's fix only classified `channel` on the
 * THROWN/rejected branch. Since McpServer never lets a protocol failure
 * reach that branch, 'protocol.output' (and 'protocol.input' /
 * 'protocol.not_found') were entirely UNREACHABLE for McpServer users —
 * every one of those conditions collapsed into 'execution', so the false
 * positive ADR 007 exists to fix was still fully present for the most
 * common way to build an MCP server with this SDK. Confirmed by building
 * a real McpServer with a real `registerTool()` call and a real Zod
 * output schema before the fix below existed: it fired
 * `mcp.tool.loop.detected` at the default threshold, exactly like any
 * other repeated business-logic failure.
 *
 * The fix: classifyFailureChannel() (src/fingerprint/classify/channel.js)
 * now inspects an `isError: true` result's `content[0].text` for the
 * exact "MCP error {code}: " wrapper McpError's constructor always
 * applies (McpServer preserves the original message verbatim when it
 * converts a thrown McpError to isError: true) and recovers the real
 * channel from it, falling back to 'execution' only when that wrapper
 * isn't present — i.e. for a genuine, tool-authored business-logic
 * message. This test would have failed before that fix (the assertions
 * below are exactly what failed) and must keep passing after it.
 */
describe('regression: McpServer-disguised protocol failures are recovered, not counted as thrash', () => {
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

  function findMetric(resourceMetrics, name) {
    for (const scope of resourceMetrics.scopeMetrics) {
      const metric = scope.metrics.find((m) => m.descriptor.name === name);
      if (metric) return metric;
    }
    return undefined;
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

  it('does not fire mcp.tool.loop.detected for a real McpServer output-schema bug', async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
    const instrumented = instrumentMcpServer(mcpServer, {
      serviceName: 'svc',
      thrashDetection: { assumeSingleSession: true },
    });

    // A real server-authoring bug: the tool declares an output schema but
    // its handler never returns structuredContent matching it. Every call
    // fails the exact same way, deterministically -- nothing the caller
    // passes as arguments can ever fix this.
    instrumented.registerTool(
      'broken-tool',
      {
        description: 'Always returns output that fails its own declared schema',
        outputSchema: { value: z.string() },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }), // no structuredContent
    );

    const handler = mcpServer.server._requestHandlers.get('tools/call');
    for (let i = 0; i < 10; i++) {
      const result = await handler(
        { method: 'tools/call', params: { name: 'broken-tool', arguments: {} } },
        { requestId: i },
      );
      // Confirms this really did arrive via McpServer's isError:true
      // conversion, not a thrown error -- the SDK swallowed it, exactly
      // as documented above.
      expect(result.isError).toBe(true);
    }

    const spans = spanExporter.getFinishedSpans();
    // Recovered correctly despite arriving as isError: true.
    expect(spans[0].attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.output');

    const { resourceMetrics } = await metricReader.collect();
    expect(findMetric(resourceMetrics, 'mcp.tool.loop.detected')).toBeUndefined();
  });

  it('does not fire for a real McpServer "tool not found" failure (also disguised as isError: true)', async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
    const instrumented = instrumentMcpServer(mcpServer, {
      serviceName: 'svc',
      thrashDetection: { assumeSingleSession: true },
    });
    instrumented.registerTool('real-tool', { description: 'exists' }, async () => ({ content: [] }));

    const handler = mcpServer.server._requestHandlers.get('tools/call');
    const result = await handler(
      { method: 'tools/call', params: { name: 'does-not-exist', arguments: {} } },
      { requestId: 1 },
    );

    expect(result.isError).toBe(true);
    const [span] = spanExporter.getFinishedSpans();
    expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.not_found');

    // notFoundThreshold defaults to 1 -- confirms the recovered channel
    // also picks up its own per-origin threshold correctly, not just the
    // exclusion.
    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });

  it('a genuine business-logic isError: true failure (no McpError wrapper) still classifies as execution', async () => {
    const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
    const instrumented = instrumentMcpServer(mcpServer, {
      serviceName: 'svc',
      thrashDetection: { assumeSingleSession: true },
    });
    instrumented.registerTool('flaky-upstream', { description: 'calls an upstream service' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'upstream service unavailable' }],
    }));

    const handler = mcpServer.server._requestHandlers.get('tools/call');
    for (let i = 0; i < 3; i++) {
      await handler({ method: 'tools/call', params: { name: 'flaky-upstream', arguments: {} } }, { requestId: i });
    }

    const spans = spanExporter.getFinishedSpans();
    expect(spans[0].attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('execution');

    // Still thrashes at the ordinary execution threshold -- this is a
    // genuine repeated business-logic failure, not a disguised protocol
    // one, and must not be swept into the exclusion.
    const { resourceMetrics } = await metricReader.collect();
    const detected = findMetric(resourceMetrics, 'mcp.tool.loop.detected');
    expect(detected.dataPoints[0].value).toBe(1);
  });
});
