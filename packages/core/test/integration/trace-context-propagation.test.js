import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as V2Server } from '@modelcontextprotocol/server';
import { instrumentMcpServer } from '../../src/instrument.js';

/**
 * ADR 017 (docs/adr/017-trace-context-propagation.md): end-to-end proof
 * that a valid W3C `traceparent` in `params._meta` actually reparents the
 * tools/call span — not just that extractTraceContext() (unit-tested in
 * test/tracecontext/extract.test.js) produces the right Context value in
 * isolation. Uses a real NodeTracerProvider with no custom sampler (the
 * SDK's own default, ParentBasedSampler({root: AlwaysOnSampler}) — the same
 * default this package's own setupNodeSdk:true path relies on) so the
 * sampling tests below exercise the real Sampler, not a mock of it.
 */

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_PARENT_ID = '00f067aa0ba902b7';

function traceparent(flags = '01') {
  return `00-${VALID_TRACE_ID}-${VALID_PARENT_ID}-${flags}`;
}

function createV1Server(name = 'v1-test-server') {
  return new V1Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

function invokeV1ToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('No handler registered for method "tools/call"');
  return handler({ method: 'tools/call', params }, extra);
}

function registerV1Tools(server, toolsByName) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const impl = toolsByName[request.params.name];
    if (!impl) throw new Error(`no fixture registered for tool "${request.params.name}"`);
    return impl(request.params.arguments);
  });
}

let spanExporter;
let traceProvider;
let contextManager;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  // Deliberately no `sampler` option — proves this feature works against
  // the SDK's real default sampler, not a test-only stand-in.
  traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  // A REAL context manager, not `contextManager: null` (as other
  // integration test files in this repo use) — this file's "conflicting
  // with an already-active local context" tests below need
  // `context.with(localContext, fn)` to actually make `localContext`
  // observable as `context.active()` inside `fn`, which the API's
  // fallback NoopContextManager does NOT do (its `with()` just calls `fn`
  // directly, and its `active()` always returns ROOT_CONTEXT regardless —
  // confirmed by reading its source). Without this, those tests would
  // pass for the wrong reason (no ambient context was ever really active
  // to begin with), not because extraction correctly falls back to one.
  contextManager = new AsyncHooksContextManager().enable();
  traceProvider.register({ contextManager, propagator: null });
});

afterEach(async () => {
  await traceProvider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
  spanExporter.reset();
});

describe('trace context propagation (v1)', () => {
  it('absent _meta produces a root span (no parent) — unchanged from pre-v0.11.0 behavior', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

    await invokeV1ToolCall(server, { name: 'ask', arguments: {} });

    const [span] = spanExporter.getFinishedSpans();
    expect(span).toBeDefined();
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('a valid traceparent in _meta becomes the span\'s parent', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

    await invokeV1ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: traceparent() } });

    const [span] = spanExporter.getFinishedSpans();
    expect(span.parentSpanContext).toBeDefined();
    expect(span.parentSpanContext.traceId).toBe(VALID_TRACE_ID);
    expect(span.parentSpanContext.spanId).toBe(VALID_PARENT_ID);
    expect(span.parentSpanContext.isRemote).toBe(true);
    // The child span joins the SAME trace as the extracted parent.
    expect(span.spanContext().traceId).toBe(VALID_TRACE_ID);
  });

  it('propagates tracestate alongside traceparent', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

    await invokeV1ToolCall(server, {
      name: 'ask',
      arguments: {},
      _meta: { traceparent: traceparent(), tracestate: 'vendor=abc123' },
    });

    const [span] = spanExporter.getFinishedSpans();
    expect(span.parentSpanContext.traceState?.get('vendor')).toBe('abc123');
  });

  describe('malformed/absent _meta — must behave exactly like no traceparent at all', () => {
    it.each([
      ['_meta missing entirely', undefined],
      ['_meta present but empty', {}],
      ['traceparent malformed', { traceparent: 'garbage' }],
      ['traceparent all-zero trace-id', { traceparent: `00-${'0'.repeat(32)}-${VALID_PARENT_ID}-01` }],
      ['traceparent wrong type', { traceparent: 12345 }],
    ])('%s', async (_label, meta) => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      const params = meta === undefined ? { name: 'ask', arguments: {} } : { name: 'ask', arguments: {}, _meta: meta };
      await expect(invokeV1ToolCall(server, params)).resolves.toBeDefined();

      const [span] = spanExporter.getFinishedSpans();
      expect(span.parentSpanContext).toBeUndefined();
    });
  });

  describe('conflicting with an already-active local context (ADR 017)', () => {
    it('the _meta-extracted context wins over an ambient active local SpanContext', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      const localSpanContext = {
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: 1,
      };
      const localContext = trace.setSpanContext(context.active(), localSpanContext);

      await context.with(localContext, () =>
        invokeV1ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: traceparent() } }),
      );

      const [span] = spanExporter.getFinishedSpans();
      // Wins outright — not merged with the local trace-id.
      expect(span.spanContext().traceId).toBe(VALID_TRACE_ID);
      expect(span.spanContext().traceId).not.toBe(localSpanContext.traceId);
      expect(span.parentSpanContext.traceId).toBe(VALID_TRACE_ID);
    });

    it('a different trace family in _meta than the active local context still wins outright', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      const localContext = trace.setSpanContext(context.active(), {
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        traceFlags: 1,
      });

      await context.with(localContext, () =>
        invokeV1ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: traceparent() } }),
      );

      const [span] = spanExporter.getFinishedSpans();
      expect(span.spanContext().traceId).toBe(VALID_TRACE_ID);
    });

    it('falls back to the active local context when _meta has no valid traceparent', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      const localSpanContext = { traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), traceFlags: 1 };
      const localContext = trace.setSpanContext(context.active(), localSpanContext);

      await context.with(localContext, () => invokeV1ToolCall(server, { name: 'ask', arguments: {} }));

      const [span] = spanExporter.getFinishedSpans();
      expect(span.parentSpanContext.traceId).toBe(localSpanContext.traceId);
    });
  });

  describe('sampling decision (ADR 017 — honored via the real ParentBasedSampler, no code of our own)', () => {
    it('a sampled (01) upstream traceparent records the span', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      await invokeV1ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: traceparent('01') } });

      expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    });

    it('a not-sampled (00) upstream traceparent results in NO exported span, but the tool call still succeeds', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      const result = await invokeV1ToolCall(server, {
        name: 'ask',
        arguments: {},
        _meta: { traceparent: traceparent('00') },
      });

      expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
      expect(spanExporter.getFinishedSpans()).toHaveLength(0);
    });

    it('an absent traceparent (root span) still records, honoring the root sampler default', async () => {
      const server = createV1Server();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

      await invokeV1ToolCall(server, { name: 'ask', arguments: {} });

      expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    });
  });

  it('never throws for a hostile _meta and the tool call still returns normally', async () => {
    const server = createV1Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    registerV1Tools(server, { ask: () => ({ content: [{ type: 'text', text: 'hi' }] }) });

    await expect(
      invokeV1ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: { nested: 'object' } } }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });
});

describe('trace context propagation (v2) — parity with v1 (ADR 017)', () => {
  function createV2Server(name = 'v2-test-server') {
    return new V2Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
  }

  function makeCtx(requestId = 1) {
    return {
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

  function invokeV2ToolCall(server, params) {
    const handler = server._requestHandlers.get('tools/call');
    if (!handler) throw new Error('No handler registered for method "tools/call"');
    return handler({ method: 'tools/call', params }, makeCtx());
  }

  it('a valid traceparent in _meta reparents the span under v2 the same as under v1', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async (request) => {
      expect(request.params.name).toBe('ask');
      return { content: [{ type: 'text', text: 'hi' }] };
    });

    await invokeV2ToolCall(server, { name: 'ask', arguments: {}, _meta: { traceparent: traceparent() } });

    const [span] = spanExporter.getFinishedSpans();
    expect(span.parentSpanContext?.traceId).toBe(VALID_TRACE_ID);
    expect(span.spanContext().traceId).toBe(VALID_TRACE_ID);
  });

  it('absent _meta under v2 produces a root span, same as v1', async () => {
    const server = createV2Server();
    instrumentMcpServer(server, { serviceName: 'svc' });
    server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'hi' }] }));

    await invokeV2ToolCall(server, { name: 'ask', arguments: {} });

    const [span] = spanExporter.getFinishedSpans();
    expect(span.parentSpanContext).toBeUndefined();
  });
});
