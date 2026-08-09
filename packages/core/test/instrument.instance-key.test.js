import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  instrumentMcpServer,
  __resetInstanceRegistryForTests,
  __getInstanceRegistrySizeForTests,
} from '../src/instrument.js';
import { ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED, ATTR_MCP_TOOL_COST_BUDGET_SCOPE, MCP_METHOD_NAME_TOOLS_LIST } from '../src/attributes.js';
import { SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED, ATTRIBUTE_KEYS as SCHEMA_DRIFT_KEYS } from '../src/schema-drift/attributes.js';

const ENV_INSTANCE_KEY = 'OTEL_MCP_INSTANCE_KEY';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) throw new Error('No handler registered for method "tools/call"');
  return handler({ method: 'tools/call', params }, extra);
}

function invokeToolsList(server, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/list');
  if (!handler) throw new Error('No handler registered for method "tools/list"');
  return handler({ method: 'tools/list', params: {} }, extra);
}

function registerOk(server) {
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'done' }] }));
}

// A tool result carrying recognizable usage data (src/cost/extractor.js),
// so applyCostAttribution() and budgetTracker actually run. 100,000 input
// tokens x claude-sonnet-5's $3/1M input price (src/cost/pricing.js) =
// exactly $0.30 — a round number chosen for simple threshold arithmetic.
function registerCostlyOk(server) {
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'done' }],
    model: 'claude-sonnet-5',
    usage: { input_tokens: 100_000, output_tokens: 0 },
  }));
}

function registerToolsList(server, getTools) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));
}

let spanExporter;
let provider;

beforeEach(() => {
  __resetInstanceRegistryForTests();
  spanExporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  // NOT contextManager: null — schemaDriftEmitter uses trace.getActiveSpan()
  // (mirrors thrash/emitter.js), which needs a real context manager to
  // resolve, same as test/instrument.schema-drift.test.js's own beforeEach.
  provider.register({ propagator: null });
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  spanExporter.reset();
  delete process.env[ENV_INSTANCE_KEY];
});

describe('instrumentMcpServer instanceKey (ADR 012, Phase 2)', () => {
  describe('omitted (the default): byte-identical to pre-v0.9.0', () => {
    it('never touches the registry across many instrumentMcpServer() calls and tool calls', async () => {
      expect(__getInstanceRegistrySizeForTests()).toBe(0);

      for (let i = 0; i < 5; i++) {
        const server = createServer();
        instrumentMcpServer(server, { serviceName: 'svc' });
        registerOk(server);
        await invokeToolCall(server, { name: 'ok', arguments: {} });
        await invokeToolCall(server, { name: 'ok', arguments: {} });
      }

      expect(__getInstanceRegistrySizeForTests()).toBe(0);
    });

    it('each instrumented server still gets its own fresh trackers — no accidental sharing', async () => {
      const serverA = createServer();
      const instrumentedA = instrumentMcpServer(serverA, { serviceName: 'svc-a' });
      registerOk(serverA);
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });

      const serverB = createServer();
      const instrumentedB = instrumentMcpServer(serverB, { serviceName: 'svc-b' });
      registerOk(serverB);
      await invokeToolCall(serverB, { name: 'ok', arguments: {} });

      expect(instrumentedA.getObservationState().toolOutcome).toEqual({ success: 3, failure: 0, unknown: 0 });
      // If state were leaking across calls (the ADR-012 bug, or a wiring
      // mistake in this phase), serverB would see 4, not 1.
      expect(instrumentedB.getObservationState().toolOutcome).toEqual({ success: 1, failure: 0, unknown: 0 });
    });
  });

  describe('same instanceKey across N instrumentMcpServer() calls shares tracker state', () => {
    it('toolOutcomeCounter accumulates across separate calls sharing a key', async () => {
      const serverA = createServer();
      instrumentMcpServer(serverA, { serviceName: 'svc', instanceKey: 'shared-service' });
      registerOk(serverA);
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });

      // A DIFFERENT Server object, a DIFFERENT instrumentMcpServer() call —
      // the exact "fresh Server per request" shape ADR 012 is about — but
      // the SAME instanceKey.
      const serverB = createServer();
      const instrumentedB = instrumentMcpServer(serverB, { serviceName: 'svc', instanceKey: 'shared-service' });
      registerOk(serverB);
      await invokeToolCall(serverB, { name: 'ok', arguments: {} });

      // 3 total: 2 from serverA's calls + 1 from serverB's own — proving
      // serverB's toolOutcomeCounter is the SAME instance serverA used, not
      // a fresh one that only sees its own single call.
      expect(instrumentedB.getObservationState().toolOutcome).toEqual({ success: 3, failure: 0, unknown: 0 });
    });

    it('budgetTracker accumulates cost across separate calls sharing a key, tripping a per-tool budget only once combined', async () => {
      // $0.30/call (see registerCostlyOk above). A limit of $0.50 is under
      // budget for any ONE call alone, but exceeded by the SECOND call's
      // cumulative total ($0.60) only if state truly carried over.
      const options = { serviceName: 'svc', instanceKey: 'shared-service', costTracking: { budget: { perToolUsd: 0.5 } } };

      const serverA = createServer();
      instrumentMcpServer(serverA, options);
      registerCostlyOk(serverA);
      await invokeToolCall(serverA, { name: 'costly', arguments: {} }, { requestId: 1 });

      const [firstSpan] = spanExporter.getFinishedSpans();
      expect(firstSpan.attributes[ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED]).toBeUndefined(); // $0.30 alone, not over $0.50

      const serverB = createServer();
      instrumentMcpServer(serverB, options);
      registerCostlyOk(serverB);
      await invokeToolCall(serverB, { name: 'costly', arguments: {} }, { requestId: 1 });

      const spans = spanExporter.getFinishedSpans();
      const secondSpan = spans[spans.length - 1];
      // $0.60 cumulative — only reachable if serverB's budgetTracker is the
      // SAME shared instance serverA already recorded $0.30 against.
      expect(secondSpan.attributes[ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED]).toBe(true);
      expect(secondSpan.attributes[ATTR_MCP_TOOL_COST_BUDGET_SCOPE]).toBe('tool');
    });

    it('schemaDriftDetector shares its schema history across separate calls sharing a key', async () => {
      const options = { serviceName: 'svc', instanceKey: 'shared-service' };
      const schemaV1 = { type: 'object', properties: { q: { type: 'string' } } };
      const schemaV2 = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } };

      const serverA = createServer();
      instrumentMcpServer(serverA, options);
      registerToolsList(serverA, () => [{ name: 'search', inputSchema: schemaV1 }]);
      await invokeToolsList(serverA, { requestId: 1 }); // cold start — establishes the baseline

      // A DIFFERENT Server, a DIFFERENT instrumentMcpServer() call, the
      // SAME instanceKey — its own tools/list call is the FIRST this
      // physical server object has ever made, but the shared detector
      // already has 'search' -> schemaV1 on record.
      const serverB = createServer();
      instrumentMcpServer(serverB, options);
      registerToolsList(serverB, () => [{ name: 'search', inputSchema: schemaV2 }]);
      await invokeToolsList(serverB, { requestId: 1 });

      const toolsListSpans = spanExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
      expect(toolsListSpans).toHaveLength(2);

      // serverA's own (cold-start) span must carry no drift event.
      expect(toolsListSpans[0].events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED)).toHaveLength(0);

      // serverB's span DOES — only possible because it shared serverA's
      // detector state instead of starting cold itself.
      const driftEvents = toolsListSpans[1].events.filter((e) => e.name === SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED);
      expect(driftEvents).toHaveLength(1);
      expect(driftEvents[0].attributes[SCHEMA_DRIFT_KEYS.TYPE]).toBe('field_added');
    });
  });

  describe('different instanceKeys: independent state, no merging', () => {
    it('two different keys never see each other\'s toolOutcome counts, even with a third call reusing one of the keys', async () => {
      const serverX1 = createServer();
      const instrumentedX1 = instrumentMcpServer(serverX1, { serviceName: 'svc', instanceKey: 'service-x' });
      registerOk(serverX1);
      await invokeToolCall(serverX1, { name: 'ok', arguments: {} });
      await invokeToolCall(serverX1, { name: 'ok', arguments: {} });
      await invokeToolCall(serverX1, { name: 'ok', arguments: {} });

      const serverY = createServer();
      const instrumentedY = instrumentMcpServer(serverY, { serviceName: 'svc', instanceKey: 'service-y' });
      registerOk(serverY);
      await invokeToolCall(serverY, { name: 'ok', arguments: {} });
      await invokeToolCall(serverY, { name: 'ok', arguments: {} });

      // service-y must not see any of service-x's 3 calls.
      expect(instrumentedY.getObservationState().toolOutcome).toEqual({ success: 2, failure: 0, unknown: 0 });

      // A second call under 'service-x' DOES accumulate onto the first...
      const serverX2 = createServer();
      const instrumentedX2 = instrumentMcpServer(serverX2, { serviceName: 'svc', instanceKey: 'service-x' });
      registerOk(serverX2);
      await invokeToolCall(serverX2, { name: 'ok', arguments: {} });
      expect(instrumentedX2.getObservationState().toolOutcome).toEqual({ success: 4, failure: 0, unknown: 0 });

      // ...and 'service-y' is still completely unaffected by that.
      expect(instrumentedY.getObservationState().toolOutcome).toEqual({ success: 2, failure: 0, unknown: 0 });
      // Sanity: instrumentedX1's own accessor reflects the same shared
      // state as instrumentedX2's — both point at the identical tracker.
      expect(instrumentedX1.getObservationState().toolOutcome).toEqual({ success: 4, failure: 0, unknown: 0 });
    });
  });

  describe('OTEL_MCP_INSTANCE_KEY environment variable', () => {
    it('is used when options.instanceKey is omitted', async () => {
      process.env[ENV_INSTANCE_KEY] = 'env-service';

      const serverA = createServer();
      instrumentMcpServer(serverA, { serviceName: 'svc' }); // no instanceKey option
      registerOk(serverA);
      await invokeToolCall(serverA, { name: 'ok', arguments: {} });

      const serverB = createServer();
      const instrumentedB = instrumentMcpServer(serverB, { serviceName: 'svc' }); // no instanceKey option
      registerOk(serverB);
      await invokeToolCall(serverB, { name: 'ok', arguments: {} });

      // Both picked up the same env-var-sourced key, so state is shared.
      expect(instrumentedB.getObservationState().toolOutcome).toEqual({ success: 2, failure: 0, unknown: 0 });
    });

    it('the explicit option takes precedence over the env var', async () => {
      process.env[ENV_INSTANCE_KEY] = 'env-service';

      const serverEnv = createServer();
      instrumentMcpServer(serverEnv, { serviceName: 'svc' }); // uses env var: 'env-service'
      registerOk(serverEnv);
      await invokeToolCall(serverEnv, { name: 'ok', arguments: {} });

      const serverExplicit = createServer();
      const instrumentedExplicit = instrumentMcpServer(serverExplicit, {
        serviceName: 'svc',
        instanceKey: 'explicit-service', // different from the env var
      });
      registerOk(serverExplicit);
      await invokeToolCall(serverExplicit, { name: 'ok', arguments: {} });

      // Not 2 — the explicit option put this server under a different key
      // than the env-var-sourced one, so no sharing happened.
      expect(instrumentedExplicit.getObservationState().toolOutcome).toEqual({ success: 1, failure: 0, unknown: 0 });
    });

    it('an empty/whitespace-only env var is treated as absent', async () => {
      process.env[ENV_INSTANCE_KEY] = '   ';

      expect(__getInstanceRegistrySizeForTests()).toBe(0);
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      registerOk(server);
      await invokeToolCall(server, { name: 'ok', arguments: {} });

      // No key resolved -> registry still never touched.
      expect(__getInstanceRegistrySizeForTests()).toBe(0);
    });
  });
});
