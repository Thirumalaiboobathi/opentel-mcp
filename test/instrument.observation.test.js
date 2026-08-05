import { describe, it, expect, afterEach, vi } from 'vitest';
import { trace, context, metrics } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';

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

/** Registers a handler that branches on tool name: 'ok' succeeds, 'fail' returns isError:true, anything else throws. */
function registerBranchingHandler(server) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'ok') return { content: [{ type: 'text', text: 'done' }] };
    if (request.params.name === 'fail') return { isError: true, content: [{ type: 'text', text: 'nope' }] };
    throw new Error('thrown failure');
  });
}

afterEach(async () => {
  trace.disable();
  context.disable();
  metrics.disable();
});

describe('instrumentMcpServer getObservationState integration', () => {
  it('toolOutcome counts reflect real calls, including mixed success/failure/thrown', async () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });
    registerBranchingHandler(server);

    await invokeToolCall(server, { name: 'ok', arguments: {} });
    await invokeToolCall(server, { name: 'ok', arguments: {} });
    await invokeToolCall(server, { name: 'fail', arguments: {} });
    await invokeToolCall(server, { name: 'boom', arguments: {} }).catch(() => {});

    expect(instrumented.getObservationState().toolOutcome).toEqual({ success: 2, failure: 2, unknown: 0 });
  });

  it('toolOutcome counts are correct end-to-end with fingerprinting:false, thrashDetection disabled, AND enableMetrics:false all at once', async () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, {
      serviceName: 'svc',
      fingerprinting: false,
      thrashDetection: { enabled: false },
      enableMetrics: false,
    });
    registerBranchingHandler(server);

    await invokeToolCall(server, { name: 'ok', arguments: {} });
    await invokeToolCall(server, { name: 'fail', arguments: {} });
    await invokeToolCall(server, { name: 'fail', arguments: {} });
    await invokeToolCall(server, { name: 'boom', arguments: {} }).catch(() => {});

    // The whole point of this test: identical, complete counting even
    // though every OTHER feature that could plausibly gate bookkeeping
    // is turned off simultaneously.
    expect(instrumented.getObservationState().toolOutcome).toEqual({ success: 1, failure: 3, unknown: 0 });
  });

  it('observationIntegrity reads DEGRADED when no TracerProvider is registered', () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    expect(instrumented.getObservationState().observationIntegrity).toBe('DEGRADED');
  });

  it('observationIntegrity reads UNKNOWN, never a HEALTHY-shaped value, once a real provider is registered', () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    const provider = new NodeTracerProvider();
    provider.register();

    const state = instrumented.getObservationState();
    expect(state.observationIntegrity).toBe('UNKNOWN');
    expect(state.observationIntegrity).not.toBe('HEALTHY');
  });

  it('reflects a provider registered AFTER instrumentMcpServer() ran, on the very next accessor call', () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

    expect(instrumented.getObservationState().observationIntegrity).toBe('DEGRADED');

    // Simulates a host registering its OTel SDK asynchronously, after
    // instrumentMcpServer() already ran — exactly the scenario ADR 008
    // Finding 4 requires re-evaluating on every call, not caching from
    // instrument time.
    const provider = new NodeTracerProvider();
    provider.register();

    expect(instrumented.getObservationState().observationIntegrity).toBe('UNKNOWN');
  });

  it('setupNodeSdk: true always reads UNKNOWN — there is nothing left to detect once opentel-mcp owns the provider', async () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });

    expect(instrumented.getObservationState().observationIntegrity).toBe('UNKNOWN');

    await instrumented.shutdown();
  });

  it('getObservationState is absent entirely when enabled: false', () => {
    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', enabled: false });

    expect(instrumented.getObservationState).toBeUndefined();
  });

  it('a tool call still returns its real result even if ToolOutcome recording throws internally', async () => {
    const { ToolOutcomeCounter } = await import('../src/observation/tool-outcome-counter.js');
    const spy = vi.spyOn(ToolOutcomeCounter.prototype, 'recordResult').mockImplementation(() => {
      throw new Error('deliberately broken counter');
    });

    const server = createServer();
    const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });
    registerBranchingHandler(server);

    const result = await invokeToolCall(server, { name: 'ok', arguments: {} });
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }] });

    spy.mockRestore();
    void instrumented;
  });
});
