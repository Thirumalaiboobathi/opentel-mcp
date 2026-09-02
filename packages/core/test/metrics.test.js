import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_ERROR_TYPE,
  ATTR_MCP_TOOL_OUTCOME,
  MCP_METHOD_NAME_TOOLS_CALL,
} from '../src/attributes.js';
import * as topAttrs from '../src/attributes.js';
import * as fingerprintAttrs from '../src/fingerprint/attributes.js';
import * as schemaDriftAttrs from '../src/schema-drift/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

/**
 * Invokes a registered request handler directly, bypassing the need for a
 * live transport/connection — mirrors invokeToolCall in instrument.test.js.
 */
function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('No handler registered for method "tools/call"');
  }
  return handler({ method: 'tools/call', params }, extra);
}

/**
 * Minimal in-memory MetricReader. @opentelemetry/sdk-metrics does not ship
 * a dedicated "InMemoryMetricReader" export (only InMemoryMetricExporter,
 * which is for the push/PeriodicExportingMetricReader path); collect() on
 * the base MetricReader class already does exactly what's needed
 * on-demand, so this only needs to fill in the two abstract lifecycle
 * hooks.
 */
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

let reader;
let provider;

beforeEach(() => {
  reader = new TestMetricReader();
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  metrics.disable();
});

describe('metrics', () => {
  describe('mcp.tool.calls', () => {
    it('increments by 1 on every tool call with gen_ai.tool.name and mcp.method.name attributes', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });
      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const calls = findMetric(resourceMetrics, 'mcp.tool.calls');
      expect(calls.dataPoints).toHaveLength(1);
      expect(calls.dataPoints[0].value).toBe(2);
      expect(calls.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(calls.dataPoints[0].attributes[ATTR_MCP_METHOD_NAME]).toBe(MCP_METHOD_NAME_TOOLS_CALL);
    });
  });

  describe('mcp.tool.errors', () => {
    it('increments on a thrown error with error.type set, and does not touch silent_failures', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new TypeError('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
      expect(errors.dataPoints).toHaveLength(1);
      expect(errors.dataPoints[0].value).toBe(1);
      expect(errors.dataPoints[0].attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
      expect(errors.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');

      expect(findMetric(resourceMetrics, 'mcp.tool.silent_failures')).toBeUndefined();
    });

    it('increments on a rejected promise the same way as a synchronous throw', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, () => Promise.reject(new RangeError('nope')));

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const errors = findMetric(resourceMetrics, 'mcp.tool.errors');
      expect(errors.dataPoints[0].attributes[ATTR_ERROR_TYPE]).toBe('RangeError');
    });
  });

  describe('mcp.tool.silent_failures', () => {
    it('increments when the JSON-RPC response succeeds but CallToolResult.isError is true, and does not touch errors', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        isError: true,
        content: [{ type: 'text', text: 'tool blew up' }],
      }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const silentFailures = findMetric(resourceMetrics, 'mcp.tool.silent_failures');
      expect(silentFailures.dataPoints).toHaveLength(1);
      expect(silentFailures.dataPoints[0].value).toBe(1);
      expect(silentFailures.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');

      expect(findMetric(resourceMetrics, 'mcp.tool.errors')).toBeUndefined();
    });

    it('does not increment on a normal successful call', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      expect(findMetric(resourceMetrics, 'mcp.tool.silent_failures')).toBeUndefined();
    });
  });

  describe('mcp.tool.duration', () => {
    it('is a millisecond histogram recording outcome=success on a successful call', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.descriptor.unit).toBe('ms');
      expect(duration.dataPoints).toHaveLength(1);
      expect(duration.dataPoints[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('echo');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('success');
      expect(duration.dataPoints[0].value.count).toBe(1);
      expect(duration.dataPoints[0].value.sum).toBeGreaterThanOrEqual(0);
    });

    it('records outcome=error on a thrown error', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw new Error('boom');
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('error');
    });

    it('records outcome=silent_failure when CallToolResult.isError is true', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      const duration = findMetric(resourceMetrics, 'mcp.tool.duration');
      expect(duration.dataPoints[0].attributes[ATTR_MCP_TOOL_OUTCOME]).toBe('silent_failure');
    });
  });

  describe('no MeterProvider registered', () => {
    it('does not crash and still calls the handler normally', async () => {
      metrics.disable();

      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await expect(invokeToolCall(server, { name: 'echo', arguments: {} })).resolves.toEqual({ content: [] });
    });
  });

  describe('enableMetrics: false', () => {
    it('emits no mcp.tool.* metrics even though a MeterProvider is registered', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', enableMetrics: false });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));

      await invokeToolCall(server, { name: 'echo', arguments: {} });

      const { resourceMetrics } = await reader.collect();
      expect(findMetric(resourceMetrics, 'mcp.tool.calls')).toBeUndefined();
      expect(findMetric(resourceMetrics, 'mcp.tool.duration')).toBeUndefined();
    });

    it('does not affect tracing (spans are unrelated to this flag)', async () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, { serviceName: 'svc', enableMetrics: false })).not.toThrow();
    });
  });
});

/**
 * Metric-label allowlist cross-check (docs/adr/021-tool-name-cardinality.md,
 * Decision 5). ADR 021 found that METRIC_SAFE_ATTRIBUTES / COST_METRIC_SAFE_ATTRIBUTES
 * (src/attributes.js), and their same-named siblings in
 * src/fingerprint/attributes.js and src/schema-drift/attributes.js, are
 * governance DOCUMENTATION only — no metric-recording call site in
 * src/metrics.js, src/thrash/emitter.js, or src/schema-drift/emitter.js
 * has ever actually consulted any of them before attaching a label. This
 * is the dev-time invariant that closes that gap: it statically extracts
 * every attribute key literal attached as a metric-instrument label
 * across those three files, resolves each identifier through that FILE's
 * own import bindings (mirroring real JS module resolution rather than a
 * single global name→value table, since the same local name — e.g.
 * ATTRIBUTE_KEYS — refers to a different module's export depending on
 * which file imports it), and asserts every resolved value is a member
 * of at least one of the four allowlists above.
 *
 * Deliberately a plain regex over source text, not an AST parse — same
 * "just enough to catch the real bug" posture as
 * test/recipes/tail-sampling-attributes.test.js's own attribute
 * cross-check, which this test mirrors structurally per ADR 021's
 * instruction to verify the artifact (the allowlists) against the source
 * (the actual call sites) rather than trusting they already agree.
 */
describe('metric-label allowlist cross-check (ADR 021)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SRC_DIR = path.resolve(__dirname, '../src');

  /**
   * The three files ADR 021 Decision 5 names as this test's scope, each
   * paired with how ITS OWN import specifiers resolve to the already-
   * imported attribute-constant module namespaces above — e.g.
   * metrics.js's `from './attributes.js'` is src/attributes.js
   * (topAttrs), but schema-drift/emitter.js's `from './attributes.js'`
   * is src/schema-drift/attributes.js (schemaDriftAttrs), since it's
   * resolved relative to a different directory. Hand-mapped rather than
   * resolved via real path arithmetic — a small, fixed, three-file list,
   * matching this test's "just enough" posture.
   */
  const FILES = [
    {
      relPath: 'metrics.js',
      specifierToModule: {
        './attributes.js': topAttrs,
        './fingerprint/attributes.js': fingerprintAttrs,
      },
    },
    {
      relPath: 'thrash/emitter.js',
      specifierToModule: {
        '../attributes.js': topAttrs,
        '../fingerprint/attributes.js': fingerprintAttrs,
      },
    },
    {
      relPath: 'schema-drift/emitter.js',
      specifierToModule: {
        '../attributes.js': topAttrs,
        './attributes.js': schemaDriftAttrs,
      },
    },
  ];

  const SAFE_LISTS = [
    topAttrs.METRIC_SAFE_ATTRIBUTES,
    topAttrs.COST_METRIC_SAFE_ATTRIBUTES,
    fingerprintAttrs.METRIC_SAFE_ATTRIBUTES,
    schemaDriftAttrs.METRIC_SAFE_ATTRIBUTES,
  ];

  /** Maps each local import name used in `text` to the module namespace it resolves to, per `specifierToModule`. */
  function buildImportMap(text, specifierToModule) {
    const importMap = new Map();
    const importStatementPattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const stmt of text.matchAll(importStatementPattern)) {
      const [, namedImports, specifier] = stmt;
      const mod = specifierToModule[specifier];
      if (!mod) continue;
      for (const rawName of namedImports.split(',')) {
        const localName = rawName.trim().split(/\s+as\s+/).pop().trim();
        if (localName) importMap.set(localName, mod);
      }
    }
    return importMap;
  }

  /**
   * Every computed-property key (`[IDENTIFIER]:` or `[IDENTIFIER.MEMBER]:`)
   * inside the argument text of a `.add(...)`/`.record(...)` call — the
   * shape every metric-instrument label bag in these three files takes,
   * either inline or via a `const metricAttrs = {...}` built once and
   * reused across several calls (thrash/emitter.js, schema-drift/emitter.js).
   */
  function findMetricLabelKeyExpressions(text) {
    const constObjects = new Map();
    for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(\{[\s\S]*?\});/g)) {
      constObjects.set(m[1], m[2]);
    }

    const keyExpressions = new Set();
    const computedKeyPattern = /\[\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\]\s*:/g;
    for (const call of text.matchAll(/\.(?:add|record)\(\s*[^,]+,\s*([\s\S]*?)\);/g)) {
      let argText = call[1].trim();
      if (constObjects.has(argText)) argText = constObjects.get(argText);
      for (const km of argText.matchAll(computedKeyPattern)) {
        keyExpressions.add(km[1]);
      }
    }
    return keyExpressions;
  }

  /** Resolves an "IDENTIFIER" or "IDENTIFIER.MEMBER" expression string to its actual attribute string value via importMap. */
  function resolveKeyExpression(expr, importMap) {
    const [root, member] = expr.split('.');
    const mod = importMap.get(root);
    if (!mod || !(root in mod)) return undefined;
    return member ? mod[root]?.[member] : mod[root];
  }

  for (const { relPath, specifierToModule } of FILES) {
    it(`every metric label key in src/${relPath} resolves to a value present in an allowlist`, () => {
      const text = readFileSync(path.join(SRC_DIR, relPath), 'utf8');
      const importMap = buildImportMap(text, specifierToModule);
      const keyExpressions = findMetricLabelKeyExpressions(text);

      // Sanity check: this file's metric-recording calls actually use at
      // least one computed key. A file that stops using [IDENTIFIER]: as
      // its attribute-bag shape would make every assertion below
      // vacuously true instead of failing loudly — this line is what
      // prevents that silent pass.
      expect(keyExpressions.size, `no computed-property metric label keys found in src/${relPath} — did its label bag shape change?`).toBeGreaterThan(0);

      // Collect every violation before asserting, rather than stopping at
      // the first — a Set of key expressions has no guaranteed report
      // order otherwise, and this file may attach more than one
      // unlisted label (it does, on the current tree).
      const unresolved = [];
      const unsafe = [];
      for (const expr of keyExpressions) {
        const value = resolveKeyExpression(expr, importMap);
        if (typeof value !== 'string') {
          unresolved.push(expr);
          continue;
        }
        if (!SAFE_LISTS.some((list) => list.includes(value))) {
          unsafe.push(`"${value}" (from ${expr})`);
        }
      }

      expect(unresolved, `src/${relPath}: these key expressions did not resolve to a string via their own import bindings`).toEqual([]);
      expect(
        unsafe,
        `src/${relPath}: these metric labels are not present in METRIC_SAFE_ATTRIBUTES, COST_METRIC_SAFE_ATTRIBUTES, fingerprint/attributes.js's METRIC_SAFE_ATTRIBUTES, or schema-drift/attributes.js's METRIC_SAFE_ATTRIBUTES:\n  ${unsafe.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});
