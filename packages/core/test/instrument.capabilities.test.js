import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as V2Server, McpServer as V2McpServer } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../src/instrument.js';
import { ATTR_GEN_AI_TOOL_NAME, ATTR_MCP_METHOD_NAME } from '../src/attributes.js';

/**
 * v2's McpServer registers its own tools/list + tools/call dispatchers in
 * its CONSTRUCTOR when `capabilities.tools` is declared
 * (@modelcontextprotocol/server mcp-*.mjs: `if (options?.capabilities?.tools)
 * this.setToolRequestHandlers()`). Before the fix, instrumentMcpServer()
 * treated those as user-registered handlers and threw INSTRUMENT_FIRST_ERROR
 * no matter where the user called it. This file covers every SDK x API x
 * capabilities combination, plus the genuine misorders the check exists for.
 *
 * Handlers are invoked white-box through the private `_requestHandlers` map,
 * the same test-only technique instrument.test.js / instrument.v2.test.js use;
 * production code never does this.
 */

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

const INFO = { name: 'caps-test', version: '0.0.0' };
const TOOLS_CAPS = { capabilities: { tools: {} } };
const OK = { content: [{ type: 'text', text: 'ok' }] };

function v1Extra() {
  return { requestId: 1, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} };
}

function v2Ctx(method = 'tools/call') {
  return {
    mcpReq: {
      id: 1,
      method,
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => {},
      notify: async () => {},
    },
  };
}

/** Calls tools/call on the inner Server; returns the finished tools/call spans. */
async function callTool(innerServer, kind, name = 'echo') {
  const handler = innerServer._requestHandlers.get('tools/call');
  if (!handler) throw new Error('no tools/call handler registered');
  const request = { method: 'tools/call', params: { name, arguments: {} } };
  await handler(request, kind === 'v1' ? v1Extra() : v2Ctx());
  return memoryExporter.getFinishedSpans().filter((s) => s.attributes[ATTR_MCP_METHOD_NAME] === 'tools/call');
}

function expectOneToolSpan(spans, name = 'echo') {
  expect(spans).toHaveLength(1);
  expect(spans[0].name).toBe(`tools/call ${name}`);
  expect(spans[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe(name);
}

describe('instrument-first with declared capabilities — every SDK x API combination', () => {
  for (const caps of [undefined, TOOLS_CAPS]) {
    const label = caps ? 'with capabilities.tools' : 'without capabilities';

    it(`v1 Server, ${label}: instruments, then wraps a later tools/call handler`, async () => {
      const server = new V1Server(INFO, caps ?? { capabilities: { tools: {} } });
      expect(() => instrumentMcpServer(server, {})).not.toThrow();
      server.setRequestHandler(CallToolRequestSchema, async () => OK);
      expectOneToolSpan(await callTool(server, 'v1'));
    });

    it(`v1 McpServer, ${label}: instruments, then wraps a later registerTool()`, async () => {
      const mcp = new V1McpServer(INFO, caps);
      expect(() => instrumentMcpServer(mcp, {})).not.toThrow();
      mcp.registerTool('echo', { description: 'echo' }, async () => OK);
      expectOneToolSpan(await callTool(mcp.server, 'v1'));
    });

    it(`v2 Server, ${label}: instruments, then wraps a later tools/call handler`, async () => {
      const server = new V2Server(INFO, caps ?? { capabilities: { tools: {} } });
      expect(() => instrumentMcpServer(server, {})).not.toThrow();
      server.setRequestHandler('tools/call', async () => OK);
      expectOneToolSpan(await callTool(server, 'v2'));
    });

    it(`v2 McpServer, ${label}: instruments, then wraps a later registerTool()`, async () => {
      const mcp = new V2McpServer(INFO, caps);
      expect(() => instrumentMcpServer(mcp, {})).not.toThrow();
      mcp.registerTool('echo', { description: 'echo' }, async () => OK);
      expectOneToolSpan(await callTool(mcp.server, 'v2'));
    });
  }

  it('v2 McpServer with capabilities.tools: tools/list is wrapped too (schema drift), and still lists the tool', async () => {
    const mcp = new V2McpServer(INFO, TOOLS_CAPS);
    instrumentMcpServer(mcp, {});
    mcp.registerTool('echo', { description: 'echo' }, async () => OK);

    const list = mcp.server._requestHandlers.get('tools/list');
    const result = await list({ method: 'tools/list', params: {} }, v2Ctx('tools/list'));
    expect(result.tools.map((t) => t.name)).toEqual(['echo']);
    const listSpans = memoryExporter.getFinishedSpans().filter((s) => s.attributes[ATTR_MCP_METHOD_NAME] === 'tools/list');
    expect(listSpans).toHaveLength(1);
  });

  it('v2 McpServer with capabilities.tools and schemaDrift disabled: tools/call still wrapped', async () => {
    const mcp = new V2McpServer(INFO, TOOLS_CAPS);
    expect(() => instrumentMcpServer(mcp, { schemaDrift: { enabled: false } })).not.toThrow();
    mcp.registerTool('echo', { description: 'echo' }, async () => OK);
    expectOneToolSpan(await callTool(mcp.server, 'v2'));
  });

  it('v2 McpServer with capabilities.tools: still advertises the tools capability after instrumenting', () => {
    const mcp = new V2McpServer(INFO, TOOLS_CAPS);
    instrumentMcpServer(mcp, {});
    expect(mcp.server.getCapabilities().tools).toBeDefined();
  });
});

describe('instrument-first still catches genuine misorders (handlers that would be bypassed)', () => {
  it('v1 Server: a tools/call handler registered before instrumenting throws', () => {
    const server = new V1Server(INFO, TOOLS_CAPS);
    server.setRequestHandler(CallToolRequestSchema, async () => OK);
    expect(() => instrumentMcpServer(server, {})).toThrow(/must be called BEFORE registering/);
  });

  it('v2 Server: a tools/call handler registered before instrumenting throws', () => {
    const server = new V2Server(INFO, TOOLS_CAPS);
    server.setRequestHandler('tools/call', async () => OK);
    expect(() => instrumentMcpServer(server, {})).toThrow(/must be called BEFORE registering/);
  });

  it('v1 McpServer: a tool registered before instrumenting throws', () => {
    const mcp = new V1McpServer(INFO);
    mcp.registerTool('echo', { description: 'echo' }, async () => OK);
    expect(() => instrumentMcpServer(mcp, {})).toThrow(/must be called BEFORE registering/);
  });

  it('v2 McpServer without capabilities: a tool registered before instrumenting throws', () => {
    const mcp = new V2McpServer(INFO);
    mcp.registerTool('echo', { description: 'echo' }, async () => OK);
    expect(() => instrumentMcpServer(mcp, {})).toThrow(/must be called BEFORE registering/);
  });

  it('v2 McpServer with capabilities.tools: a tool registered before instrumenting still throws', () => {
    const mcp = new V2McpServer(INFO, TOOLS_CAPS);
    mcp.registerTool('echo', { description: 'echo' }, async () => OK);
    expect(() => instrumentMcpServer(mcp, {})).toThrow(/must be called BEFORE registering/);
  });

  it('v2 McpServer with capabilities.tools, already connected: keeps the previous behavior (throws) rather than re-registering capabilities after connect', () => {
    const mcp = new V2McpServer(INFO, TOOLS_CAPS);
    // Simulate a connected transport; v2 refuses registerCapabilities() after connect.
    Object.defineProperty(mcp.server, 'transport', { get: () => ({}) });
    expect(() => instrumentMcpServer(mcp, {})).toThrow(/must be called BEFORE registering/);
    // And nothing was removed: McpServer's own handler is still there.
    expect(mcp.server._requestHandlers.has('tools/call')).toBe(true);
  });
});
