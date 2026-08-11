import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { instrumentMcpServer } from '../src/instrument.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_MCP_TOOL_ARGUMENT_COUNT,
  ATTR_ERROR_TYPE,
  GEN_AI_OPERATION_NAME_EXECUTE_TOOL,
} from '../src/attributes.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';

/**
 * ADR 015 Phase 2/3: v2 (@modelcontextprotocol/server) wrapping. Mirrors
 * test/instrument.test.js's v1 coverage structurally, but against the REAL
 * v2 package throughout — not a hand-rolled fixture. v2's dispatch
 * mechanism (method-name STRING, not schema-object identity — ADR 015
 * Finding 1) and its `ctx` shape (`ctx.sessionId` / `ctx.mcpReq.id` —
 * Findings 3/7) are exactly what this file needs to prove actually work
 * end to end; a fixture standing in for the real SDK couldn't credibly
 * demonstrate either.
 *
 * The "mcp.failure.channel (ADR 015 Phase 3)" describe block below closes
 * a gap Phase 2 deliberately left open: this file originally only proved
 * a v2 disguised validation failure produces a span with ERROR status
 * (the span/attribute layer Phase 2 was responsible for), without
 * asserting on `mcp.failure.channel`/`mcp.failure.validation_paths` —
 * those depend on channel.js/validation-paths.js, both v1-only until
 * Phase 3. `wrapToolCallHandler` itself needed no change for this: it
 * already called `classifyFailureChannel()`/`extractValidationPaths()`
 * unconditionally on the raw result/error, with no `kind`-based branching
 * (see channel.js's own docblock for why none was needed) — so Phase 3
 * landing in those two modules alone was enough to make the integration
 * correct, confirmed here rather than assumed.
 */

/** Fresh, unconnected low-level v2 Server — every test builds its own. */
function createV2Server(name = 'v2-test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/**
 * Invokes a registered request handler directly, bypassing the need for a
 * live transport/connection — the v2 equivalent of instrument.test.js's
 * invokeHandler(), reaching into the same private `_requestHandlers` Map
 * v2's `Server`/`Protocol` also exposes (test-only white-box access; the
 * production code in instrument.js never does this — ADR 001/002).
 */
function invokeHandler(server, method, request, ctx) {
  const handler = server._requestHandlers.get(method);
  if (!handler) {
    throw new Error(`No handler registered for method "${method}"`);
  }
  return handler(request, ctx);
}

/**
 * A minimal but faithful v2 `ctx` (the wrapped handler's second argument —
 * ADR 015 Finding 3): `sessionId` at the top level (optional, matching
 * `BaseContext.sessionId?: string`), `mcpReq.id` for request identity
 * (non-optional in v2's types, but this fixture still lets a test omit it
 * to prove the presence guard still behaves), and just enough of
 * `mcpReq.*` for a real v2 `Server`/`McpServer`'s own internal dispatch
 * logic (era/codec resolution, cache-hint handling) to not throw.
 */
function makeCtx({ sessionId, requestId = 1 } = {}) {
  return {
    sessionId,
    mcpReq: {
      id: requestId,
      method: 'tools/call',
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => {},
      notify: async () => {},
    },
  };
}

function invokeToolCall(server, params, ctxOverrides) {
  return invokeHandler(server, 'tools/call', { method: 'tools/call', params }, makeCtx(ctxOverrides));
}

let memoryExporter;
let provider;

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  provider.register({ contextManager: null, propagator: null });
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  memoryExporter.reset();
});

describe('instrumentMcpServer — v2 (@modelcontextprotocol/server) support (ADR 015 Phase 2)', () => {
  describe('low-level Server', () => {
    it('emits exactly one span named "tools/call echo" with kind SERVER and correct standard attributes', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'ok' }] }));

      await invokeToolCall(server, { name: 'echo', arguments: { a: 1, b: 2 } });

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const [span] = spans;
      expect(span.name).toBe('tools/call echo');
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.attributes[ATTR_MCP_METHOD_NAME]).toBe('tools/call');
      expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_NAME_EXECUTE_TOOL);
      expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(span.attributes[ATTR_MCP_TOOL_ARGUMENT_COUNT]).toBe(2);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('reads jsonrpc.request.id from ctx.mcpReq.id, not extra.requestId (ADR 015 Finding 7)', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} }, { requestId: 'req-99' });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('req-99');
    });

    it('omits jsonrpc.request.id when ctx.mcpReq.id is absent, same guard as v1', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => ({ content: [] }));

      const ctx = makeCtx();
      delete ctx.mcpReq.id;
      await invokeHandler(server, 'tools/call', { method: 'tools/call', params: { name: 'echo', arguments: {} } }, ctx);

      const [span] = memoryExporter.getFinishedSpans();
      expect(ATTR_JSONRPC_REQUEST_ID in span.attributes).toBe(false);
    });

    it('error path: a thrown error produces an ERROR-status span and rethrows', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => {
        throw new TypeError('v2 boom');
      });

      await expect(invokeToolCall(server, { name: 'boom', arguments: {} })).rejects.toThrow('v2 boom');

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
    });

    it('does not wrap handlers registered for methods other than tools/call', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });

      let pingCalled = false;
      server.setRequestHandler('ping', async () => {
        pingCalled = true;
        return {};
      });

      await invokeHandler(server, 'ping', { method: 'ping' }, makeCtx());

      expect(pingCalled).toBe(true);
      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });

    it('passes a 3-arg custom-method setRequestHandler call straight through, unwrapped', async () => {
      // v2's setRequestHandler has a second overload for non-spec methods:
      // (method, schemas, handler). tools/call is always 2-arg (ADR 015
      // Finding 1); this proves the patch doesn't misfire on the 3-arg
      // form even if a caller registers a custom method also named
      // 'tools/call'-adjacent-but-not-actually — here just a distinct
      // custom method, to prove the patch is shape-driven, not name-driven,
      // for the 3-arg path.
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });

      let called = false;
      server.setRequestHandler('acme/custom', { params: z.object({ x: z.string() }) }, async (params) => {
        called = true;
        return { ok: true, x: params.x };
      });

      const handler = server._requestHandlers.get('acme/custom');
      const result = await handler({ method: 'acme/custom', params: { x: 'hi' } }, makeCtx());

      expect(called).toBe(true);
      expect(result).toEqual({ ok: true, x: 'hi' });
      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });

    it('throws the instrument-first error when a tools/call handler is already registered before instrumentation', () => {
      const server = createV2Server();
      server.setRequestHandler('tools/call', async () => ({ content: [] }));

      expect(() => instrumentMcpServer(server, { serviceName: 'svc' })).toThrow(/must be called BEFORE registering/i);
    });

    it('idempotency: instrumenting twice does not double-wrap', async () => {
      const server = createV2Server();
      const first = instrumentMcpServer(server, { serviceName: 'svc' });
      const second = instrumentMcpServer(server, { serviceName: 'svc' });
      expect(second).toBe(first);

      server.setRequestHandler('tools/call', async () => ({ content: [] }));
      await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });
  });

  describe('McpServer (registerTool)', () => {
    it('happy path: instrument, registerTool, invoke, and assert a correct span', async () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      const instrumented = instrumentMcpServer(mcpServer, { serviceName: 'svc' });

      instrumented.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }],
      }));

      await invokeHandler(
        mcpServer.server,
        'tools/call',
        { method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
        makeCtx({ requestId: 3 }),
      );

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.name).toBe('tools/call echo');
      expect(span.kind).toBe(SpanKind.SERVER);
      expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(span.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('3');
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it('a disguised isError:true validation failure still produces an ERROR-status span (attribute layer only — classification is Phase 3)', async () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      mcpServer.registerTool('strict', { inputSchema: z.object({ n: z.number() }) }, async ({ n }) => ({
        content: [{ type: 'text', text: String(n) }],
      }));

      const result = await invokeHandler(
        mcpServer.server,
        'tools/call',
        { method: 'tools/call', params: { name: 'strict', arguments: { n: 'not-a-number' } } },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('idempotency: instrumenting the outer McpServer then the inner Server is a no-op', async () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      instrumentMcpServer(mcpServer.server, { serviceName: 'svc' });

      mcpServer.registerTool('echo', {}, async () => ({ content: [] }));
      await invokeHandler(mcpServer.server, 'tools/call', { method: 'tools/call', params: { name: 'echo', arguments: {} } }, makeCtx());

      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
    });

    it('throws the instrument-first error when a tool is registered via .registerTool() before instrumentation', () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      mcpServer.registerTool('echo', {}, async () => ({ content: [] }));

      expect(() => instrumentMcpServer(mcpServer, { serviceName: 'svc' })).toThrow(/must be called BEFORE registering/i);
    });

    it('getThrashSummary/getObservationState are attached, same as v1', async () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      const instrumented = instrumentMcpServer(mcpServer, { serviceName: 'svc' });

      expect(typeof instrumented.getThrashSummary).toBe('function');
      expect(typeof instrumented.getObservationState).toBe('function');
      expect(instrumented.getObservationState().toolOutcome).toEqual({ success: 0, failure: 0, unknown: 0 });
    });
  });

  describe('sessionId (ADR 015 Finding 3): read from ctx.sessionId', () => {
    it('two clients with distinct ctx.sessionId values get independently tracked thrash episodes', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc', thrashDetection: { threshold: 3 } });
      server.setRequestHandler('tools/call', async () => ({
        isError: true,
        content: [{ type: 'text', text: 'invalid input: missing field "email"' }],
      }));

      // Interleaved, mirroring test/integration/thrash-detection.test.js's
      // v1 "two interleaved clients" case — each client reaches its own
      // 3rd (threshold) failure on its last call.
      for (let i = 0; i < 2; i++) {
        await invokeToolCall(server, { name: 'validate', arguments: {} }, { sessionId: 'client-a' });
        await invokeToolCall(server, { name: 'validate', arguments: {} }, { sessionId: 'client-b' });
      }
      expect(server.getThrashSummary().activeLoops).toBe(0);

      await invokeToolCall(server, { name: 'validate', arguments: {} }, { sessionId: 'client-a' }); // client-a's 3rd
      expect(server.getThrashSummary().activeLoops).toBe(1);

      await invokeToolCall(server, { name: 'validate', arguments: {} }, { sessionId: 'client-b' }); // client-b's 3rd
      expect(server.getThrashSummary().activeLoops).toBe(2);
    });

    it('ctx.sessionId absent (the default, stateless-HTTP shape) does not throw and does not crash thrash detection', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => ({ content: [] }));

      await expect(invokeToolCall(server, { name: 'echo', arguments: {} }, { sessionId: undefined })).resolves.toBeDefined();
    });
  });

  describe('mcp.failure.channel / mcp.failure.validation_paths (ADR 015 Phase 3)', () => {
    it('a real v2 disguised input-validation failure sets both attributes correctly, end to end through wrapToolCallHandler', async () => {
      const mcpServer = new McpServer({ name: 'v2-mcp', version: '1.0.0' });
      instrumentMcpServer(mcpServer, { serviceName: 'svc' });
      mcpServer.registerTool('strict', { inputSchema: z.object({ n: z.number(), email: z.string().email() }) }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));

      const result = await invokeHandler(
        mcpServer.server,
        'tools/call',
        { method: 'tools/call', params: { name: 'strict', arguments: { n: 'not-a-number', email: 'nope' } } },
        makeCtx(),
      );
      expect(result.isError).toBe(true);

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.input');
      expect(span.attributes[ATTRIBUTE_KEYS.VALIDATION_PATHS]).toEqual(['n', 'email']);
    });

    it('a real v2 thrown not-found error sets mcp.failure.channel via the thrown branch (.code read directly, no wrapper)', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async (request) => {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      });

      await expect(invokeToolCall(server, { name: 'nope', arguments: {} })).rejects.toThrow('Tool nope not found');

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('protocol.not_found');
    });

    it('a genuine business-logic isError: true failure (no validation markers) still classifies as execution for v2', async () => {
      const server = createV2Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler('tools/call', async () => ({
        isError: true,
        content: [{ type: 'text', text: 'upstream service unavailable' }],
      }));

      await invokeToolCall(server, { name: 'flaky', arguments: {} });

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTRIBUTE_KEYS.CHANNEL]).toBe('execution');
      expect(ATTRIBUTE_KEYS.VALIDATION_PATHS in span.attributes).toBe(false);
    });
  });
});
