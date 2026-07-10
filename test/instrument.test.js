import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, context, diag, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { __resetServiceNameWarnedForTests } from '../src/config.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_MCP_TOOL_ARGUMENT_COUNT,
  ATTR_ERROR_TYPE,
  ERROR_TYPE_TOOL_ERROR,
  GEN_AI_OPERATION_NAME_EXECUTE_TOOL,
  MCP_METHOD_NAME_TOOLS_CALL,
} from '../src/attributes.js';

const ATTR_MCP_TOOL_STATUS = 'mcp.tool.status';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/**
 * Invokes a registered request handler directly, bypassing the need for a
 * live transport/connection. This mirrors exactly what Protocol#_onrequest
 * does internally (look up the stored handler by JSON-RPC method and call
 * it). Reaching into `_requestHandlers` here is test-only white-box access
 * for verification — the production code in instrument.js never does this
 * (see ADR 001 / ADR 002).
 */
function invokeHandler(server, method, request, extra = { requestId: 1 }) {
  // Private field OK in tests: unit-testing the wrapped handler without
  // spinning up a full transport. Src code never touches private fields —
  // see ADR 001.
  const handler = server._requestHandlers.get(method);
  if (!handler) {
    throw new Error(`No handler registered for method "${method}"`);
  }
  return handler(request, extra);
}

function invokeToolCall(server, params, extra) {
  return invokeHandler(server, 'tools/call', { method: 'tools/call', params }, extra);
}

/**
 * A minimal object duck-typed to look like McpServer: a real low-level
 * Server under `.server` (so setRequestHandler/assertCanSetRequestHandler
 * behave exactly like production), plus `.tool()`/`.registerTool()` that
 * mimic McpServer's real behavior — a single lazy call to
 * `server.setRequestHandler(CallToolRequestSchema, ...)` on the first tool
 * registration only. Deliberately not the real McpServer class, so these
 * tests exercise opentel-mcp's own detection/wrapping logic in isolation;
 * real end-to-end McpServer coverage lives in examples/hello-mcpserver.
 */
function createFakeMcpServer(name = 'test-mcpserver') {
  const innerServer = createServer(name);
  const registeredTools = {};
  let dispatcherInstalled = false;

  function installDispatcherOnce() {
    if (dispatcherInstalled) return;
    dispatcherInstalled = true;
    innerServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const handler = registeredTools[request.params.name];
      if (!handler) {
        throw new Error(`Tool ${request.params.name} not found`);
      }
      return handler(request.params.arguments ?? {}, extra);
    });
  }

  return {
    server: innerServer,
    tool(toolName, handler) {
      registeredTools[toolName] = handler;
      installDispatcherOnce();
    },
    registerTool(toolName, _config, handler) {
      registeredTools[toolName] = handler;
      installDispatcherOnce();
    },
  };
}

let memoryExporter;
let provider;

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  // contextManager/propagator: null — these tests only assert on captured
  // spans, not context propagation, so skip installing global async_hooks
  // state that would otherwise leak across tests.
  provider.register({ contextManager: null, propagator: null });
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  memoryExporter.reset();
});

describe('instrumentMcpServer', () => {
  describe('happy path', () => {
    it('emits exactly one span named "tools/call echo" with kind SERVER per tool call', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('tools/call echo');
      expect(spans[0].kind).toBe(SpanKind.SERVER);
    });

    it('falls back to just mcp.method.name as the span name when no tool name is available', async () => {
      // CallToolRequestSchema requires params.name to be a string but does
      // not enforce a minimum length, so an empty string is the only way to
      // reach this branch through the SDK's own schema validation (a
      // missing/undefined name is rejected by zod before our handler ever
      // runs) — '' is falsy in JS, which is exactly what the ternary in
      // wrapToolCallHandler checks.
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: '', arguments: {} });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.name).toBe(MCP_METHOD_NAME_TOOLS_CALL);
    });

    it('sets mcp.method.name, gen_ai.tool.name, gen_ai.operation.name, mcp.tool.argument_count, and jsonrpc.request.id attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: { foo: 'bar', baz: 42 } }, { requestId: 7 });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_METHOD_NAME]).toBe('tools/call');
      expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_NAME_EXECUTE_TOOL);
      expect(span.attributes[ATTR_MCP_TOOL_ARGUMENT_COUNT]).toBe(2);
      expect(span.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('7');
    });

    it('sets span status to SpanStatusCode.OK and does not set error.type', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes[ATTR_ERROR_TYPE]).toBeUndefined();
    });

    it('emits mcp.tool.argument_count = 0 when request.params.arguments is undefined', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo' });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTR_MCP_TOOL_ARGUMENT_COUNT]).toBe(0);
    });
  });

  describe('tool-level failure (isError: true)', () => {
    it('sets error.type to "tool_error" and span status ERROR, returns the result unchanged, and does not throw', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      const toolResult = { isError: true, content: [{ type: 'text', text: 'tool blew up' }] };
      server.setRequestHandler(CallToolRequestSchema, async () => toolResult);

      const result = await invokeToolCall(server, { name: 'echo', arguments: {} });

      // toEqual, not toBe: the SDK's own setRequestHandler wrapper
      // reconstructs the result object en route back to the caller (see
      // parseWithCompat in protocol.js), so reference identity isn't
      // preserved even without instrumentation — value equality is what
      // "returned unchanged" means here.
      expect(result).toEqual(toolResult);

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe(ERROR_TYPE_TOOL_ERROR);
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('tool_error');
    });
  });

  describe('error path (synchronous throw)', () => {
    it('rethrows the original error to the caller', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('boom');
      });

      await expect(invokeToolCall(server, { name: 'echo', arguments: {} })).rejects.toThrow('boom');
    });

    it('records the exception and sets SpanStatusCode.ERROR on the span', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((e) => e.name === 'exception')).toBe(true);
      expect(span.ended).toBe(true);
    });

    it('sets error.type and status ERROR with the error message as status description, and does not set the removed mcp.tool.status attribute', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('boom');
      expect(span.attributes[ATTR_MCP_TOOL_STATUS]).toBeUndefined();
    });
  });

  describe('error path (rejected promise)', () => {
    it('rethrows the rejection to the caller', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, () => Promise.reject(new RangeError('nope')));

      await expect(invokeToolCall(server, { name: 'echo', arguments: {} })).rejects.toThrow('nope');
    });

    it('applies the same error attributes and ERROR status as a synchronous throw', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, () => Promise.reject(new RangeError('nope')));

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('nope');
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('RangeError');
      expect(span.attributes[ATTR_MCP_TOOL_STATUS]).toBeUndefined();
      expect(span.events.some((e) => e.name === 'exception')).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('does not double-wrap when instrumentMcpServer is called twice on the same server', async () => {
      const server = createServer();
      const first = instrumentMcpServer(server, { serviceName: 'svc' });
      const second = instrumentMcpServer(server, { serviceName: 'svc' });
      expect(second).toBe(first);

      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
      await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });
  });

  describe('instrument-first violation', () => {
    it('throws the instrument-first error when a tools/call handler is already registered before instrumentation', () => {
      const server = createServer();
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      expect(() => instrumentMcpServer(server, { serviceName: 'svc' })).toThrow(/must be called BEFORE registering/i);
    });
  });

  describe('non-Server, non-McpServer input', () => {
    it('throws a clear error when given something that matches neither shape', () => {
      expect(() => instrumentMcpServer({}, { serviceName: 'svc' })).toThrow(/expects either a low-level Server/i);
    });
  });

  describe('serviceName requirement depends on setupNodeSdk', () => {
    it('setupNodeSdk: true + no serviceName -> throws', () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, { setupNodeSdk: true })).toThrow(/serviceName/i);
    });

    it('setupNodeSdk: true + empty string serviceName -> throws', () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, { serviceName: '', setupNodeSdk: true })).toThrow(/serviceName/i);
    });

    it('setupNodeSdk: false + no serviceName -> does not throw, spans still emit', async () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, {})).not.toThrow();
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });

    it('setupNodeSdk: false + serviceName passed -> diag.warn fires exactly once per process, not once per server', async () => {
      __resetServiceNameWarnedForTests();
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

      const serverA = createServer('a');
      const serverB = createServer('b');
      instrumentMcpServer(serverA, { serviceName: 'svc-a' });
      instrumentMcpServer(serverB, { serviceName: 'svc-b' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/serviceName was provided but setupNodeSdk is false/i);

      warnSpy.mockRestore();
    });

    it('setupNodeSdk: true + serviceName -> no warning', () => {
      __resetServiceNameWarnedForTests();
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('enabled: false', () => {
    it('produces no spans for tool calls when instrumentation is disabled', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', enabled: false });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });
  });

  describe('global tracer provider respect', () => {
    it('emits spans through the externally-registered provider when setupNodeSdk is false (default)', async () => {
      // The outer beforeEach already registered `provider`/`memoryExporter`
      // as the global tracer provider before instrumentMcpServer runs.
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });
  });

  describe('handler-selectivity', () => {
    it('does not wrap handlers registered for schemas other than CallToolRequestSchema', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });

      let pingCalled = false;
      server.setRequestHandler(PingRequestSchema, async () => {
        pingCalled = true;
        return {};
      });

      await invokeHandler(server, 'ping', { method: 'ping' });

      expect(pingCalled).toBe(true);
      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });
  });

  describe('shutdown attachment', () => {
    it('attaches server.shutdown when setupNodeSdk: true', async () => {
      const server = createServer();
      const instrumented = instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });

      expect(typeof instrumented.shutdown).toBe('function');

      // Clean up the provider this test created internally so it doesn't
      // leak into subsequent tests' global tracer registration.
      await instrumented.shutdown();
    });

    it('does not attach server.shutdown when setupNodeSdk is false or omitted', () => {
      const server = createServer();
      const instrumented = instrumentMcpServer(server, { serviceName: 'svc' });

      expect(instrumented.shutdown).toBeUndefined();
    });
  });

  describe('McpServer support', () => {
    it('happy path: instrument, register via .tool(), invoke, and assert a correct span', async () => {
      const mcpServer = createFakeMcpServer();
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });

      mcpServer.tool('echo', async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));

      await invokeToolCall(mcpServer.server, { name: 'echo', arguments: { text: 'hi' } }, { requestId: 3 });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.name).toBe('tools/call echo');
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.attributes[ATTR_MCP_METHOD_NAME]).toBe('tools/call');
      expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(span.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('3');
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('error path: a tool registered via .registerTool() that throws produces an error span and rethrows', async () => {
      const mcpServer = createFakeMcpServer();
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });

      mcpServer.registerTool('boom', {}, async () => {
        throw new TypeError('mcp boom');
      });

      await expect(invokeToolCall(mcpServer.server, { name: 'boom', arguments: {} })).rejects.toThrow('mcp boom');

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('mcp boom');
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
    });

    it('idempotency: instrumenting the outer McpServer twice is a no-op', async () => {
      const mcpServer = createFakeMcpServer();
      const first = instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      const second = instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      expect(second).toBe(first);

      mcpServer.tool('echo', async () => ({ content: [] }));
      await invokeToolCall(mcpServer.server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });

    it('idempotency: instrumenting the outer then the inner server is a no-op', async () => {
      const mcpServer = createFakeMcpServer();
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      instrumentMcpServer(mcpServer.server, { serviceName: 'svc' });

      mcpServer.tool('echo', async () => ({ content: [] }));
      await invokeToolCall(mcpServer.server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });

    it('throws the instrument-first error when a tool is registered via .tool() before instrumentation', () => {
      const mcpServer = createFakeMcpServer();
      mcpServer.tool('echo', async () => ({ content: [] }));

      expect(() => instrumentMcpServer(mcpServer, { serviceName: 'svc' })).toThrow(/must be called BEFORE registering/i);
    });
  });
});
