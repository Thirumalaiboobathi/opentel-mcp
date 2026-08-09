#!/usr/bin/env node
/**
 * Verification harness for dashboards/grafana-mcp-health.json. NOT part of
 * any published package — see dashboards/README.md.
 *
 * Registers a real MeterProvider + PrometheusExporter (port 9464, the
 * default Prometheus scrape port for this exporter) BEFORE calling
 * instrumentMcpServer(), then drives the same realistic MCP tool traffic
 * as packages/ui/demo/populate.js (successes, silent failures, thrown
 * errors, a thrash loop, schema drift) through a real MCP Client/Server
 * pair. Unlike populate.js, this script:
 *
 *   - sets up metrics export (populate.js only wires traces)
 *   - attaches recognizable token-usage data to a few tool results so
 *     mcp.tool.tokens.total / mcp.tool.cost.total actually get samples
 *   - loops the traffic forever on an interval so Prometheus's rate()/
 *     increase() queries have more than one scrape's worth of data
 *
 * Run: node metrics-demo-server.js  (from dashboards/dev, after npm install)
 * Metrics: http://localhost:9464/metrics
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { instrumentMcpServer } from 'opentel-mcp';

const METRICS_PORT = 9464;
const SERVICE_NAME = 'demo-mcp-server';
const LOOP_INTERVAL_MS = 15_000;

// --- Metrics export must be registered before instrumentMcpServer() ---
// setupMeter() (src/metrics.js) only calls metrics.getMeter() — it never
// creates a MeterProvider itself. The host application (this script) owns
// that, exactly like a real deployment would.
const exporter = new PrometheusExporter(
  {
    port: METRICS_PORT,
    // Flattens the service.name resource attribute onto every metric
    // point (not just the separate target_info series) so the dashboard's
    // service.name template variable can filter with a plain label match
    // instead of a target_info join.
    withResourceConstantLabels: /^service\.name$/,
  },
  () => {
    console.log(`metrics-demo-server: Prometheus scrape endpoint on http://localhost:${METRICS_PORT}/metrics`);
  },
);
const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
  readers: [exporter],
});
metrics.setGlobalMeterProvider(meterProvider);

// --- Tool schemas (V1 -> V2 drives the schema-drift scenario) ---

const SEARCH_CODEBASE_SCHEMA_V1 = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

const SEARCH_CODEBASE_SCHEMA_V2 = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    case_sensitive: { type: 'boolean' },
  },
  required: ['query'],
};

let searchCodebaseSchema = SEARCH_CODEBASE_SCHEMA_V1;
let schemaFlips = 0;

function currentToolDefinitions() {
  return [
    { name: 'search_codebase', description: 'Search the repository for a pattern', inputSchema: searchCodebaseSchema },
    {
      name: 'read_file',
      description: 'Read a file from the repository',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'run_tests',
      description: 'Run a test suite',
      inputSchema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request against a branch',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string' }, title: { type: 'string' } },
        required: ['branch', 'title'],
      },
    },
    {
      name: 'query_database',
      description: 'Run a read-only SQL query against the analytics database',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
    {
      name: 'summarize_ticket',
      description: 'Summarize a support ticket with an LLM',
      inputSchema: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'] },
    },
  ];
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

// mcp.tool.tokens.total / mcp.tool.cost.total only get samples when a tool
// result carries a recognizable usage shape (src/cost/extractor.js). Real
// MCP tools rarely echo LLM usage back today, but this is exactly the shape
// a tool wrapping an LLM call (e.g. summarize_ticket) would return.
function okWithUsage(text, model, inputTokens, outputTokens) {
  return {
    content: [{ type: 'text', text }],
    model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function silentFailure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

// Same isError:true shape as silentFailure(), plus usage — used for the
// thrash-loop scenario below so mcp.tool.loop.wasted_tokens/wasted_cost_usd
// get non-zero samples: each repeated failing call still burned real
// tokens on the way to failing, which is the whole point of "wasted".
function silentFailureWithUsage(text, model, inputTokens, outputTokens) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

const PROTECTED_BRANCH_MESSAGE = "Permission denied: cannot push to protected branch 'main' (require pull request review)";

async function handleToolCall({ name, arguments: args }) {
  switch (name) {
    case 'search_codebase':
      return ok(`Found 3 matches for "${args.query}" in src/`);

    case 'read_file':
      if (args.path?.includes('missing')) {
        return silentFailure(`File not found: ${args.path}`);
      }
      return ok(`// contents of ${args.path}\nexport function handler() { /* ... */ }`);

    case 'run_tests':
      if (args.suite === 'integration') {
        throw new TypeError("Cannot read properties of undefined (reading 'teardown')");
      }
      return ok(`${args.suite}: 42 passed, 0 failed`);

    case 'create_pull_request':
      if (args.branch === 'main') {
        return silentFailureWithUsage(PROTECTED_BRANCH_MESSAGE, 'claude-sonnet-5', 640, 90);
      }
      return ok(`Opened PR #128: "${args.title}"`);

    case 'query_database':
      if (args.sql?.toLowerCase().includes('drop')) {
        throw new Error('ECONNREFUSED: could not connect to database at db.internal:5432');
      }
      if (args.sql?.includes('orders')) {
        return silentFailure('Query timeout after 30000ms: SELECT * FROM orders WHERE status = ...');
      }
      return ok('Returned 128 rows');

    case 'summarize_ticket':
      if (args.ticketId === 'TICKET-500') {
        return silentFailure('Summarization failed: upstream model returned empty completion');
      }
      return okWithUsage(
        `Ticket ${args.ticketId}: customer reports slow checkout, likely CDN cache miss.`,
        'claude-sonnet-5',
        820,
        140,
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callAndIgnoreThrown(client, name, args) {
  try {
    await client.callTool({ name, arguments: args });
  } catch (err) {
    void err;
  }
}

async function runTrafficCycle(client) {
  for (let i = 0; i < 8; i++) {
    await client.callTool({ name: 'search_codebase', arguments: { query: `handle${i}Error` } });
  }
  for (const path of ['src/routes/users.ts', 'src/utils/validate.ts', 'README.md', 'src/db/schema.sql']) {
    await client.callTool({ name: 'read_file', arguments: { path } });
  }
  for (const suite of ['unit', 'unit', 'e2e']) {
    await client.callTool({ name: 'run_tests', arguments: { suite } });
  }
  for (const branch of ['feature/add-retry-logic', 'fix/null-pointer-in-parser']) {
    await client.callTool({ name: 'create_pull_request', arguments: { branch, title: `Update ${branch}` } });
  }
  for (const sql of ['SELECT * FROM users LIMIT 10', 'SELECT count(*) FROM sessions']) {
    await client.callTool({ name: 'query_database', arguments: { sql } });
  }
  for (const ticketId of ['TICKET-101', 'TICKET-102', 'TICKET-103']) {
    await client.callTool({ name: 'summarize_ticket', arguments: { ticketId } });
  }

  // Thrash loop: same tool, same arguments, same fingerprint, 5x in a row
  // (past ThrashDetector's default threshold of 3).
  for (let i = 0; i < 5; i++) {
    await client.callTool({ name: 'create_pull_request', arguments: { branch: 'main', title: 'Hotfix for prod incident' } });
  }

  // Silent failures across several tools/categories.
  await client.callTool({ name: 'read_file', arguments: { path: 'src/config/missing-secrets.json' } });
  await client.callTool({ name: 'read_file', arguments: { path: 'docs/missing-changelog.md' } });
  await client.callTool({ name: 'query_database', arguments: { sql: 'SELECT * FROM orders WHERE status = pending' } });
  await client.callTool({ name: 'summarize_ticket', arguments: { ticketId: 'TICKET-500' } });

  // Thrown/protocol errors.
  await callAndIgnoreThrown(client, 'run_tests', { suite: 'integration' });
  await callAndIgnoreThrown(client, 'run_tests', { suite: 'integration' });
  await callAndIgnoreThrown(client, 'query_database', { sql: 'DROP TABLE sessions' });

  // Flip the search_codebase schema back and forth so schema drift keeps
  // firing on every cycle, not just once at startup.
  searchCodebaseSchema = schemaFlips % 2 === 0 ? SEARCH_CODEBASE_SCHEMA_V2 : SEARCH_CODEBASE_SCHEMA_V1;
  schemaFlips += 1;
  await client.listTools();
}

async function main() {
  const server = new Server({ name: SERVICE_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });

  instrumentMcpServer(server, {
    setupNodeSdk: false, // traces not needed for this harness — metrics only; service.name comes from the MeterProvider resource above
    costTracking: {
      budget: { perToolUsd: 0.01 }, // low on purpose: exercises budget span attrs (see dashboards/README.md)
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request.params));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'demo-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  console.log('metrics-demo-server: driving initial traffic cycle...');
  await runTrafficCycle(client);
  console.log(`metrics-demo-server: cycle done, repeating every ${LOOP_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

  setInterval(() => {
    runTrafficCycle(client).catch((err) => console.error('metrics-demo-server: traffic cycle failed:', err));
  }, LOOP_INTERVAL_MS);
}

main().catch((err) => {
  console.error('metrics-demo-server: failed:', err);
  process.exitCode = 1;
});
