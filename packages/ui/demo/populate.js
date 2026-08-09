#!/usr/bin/env node
/**
 * Populates a real, running opentel-mcp-ui dashboard with real traffic —
 * for visual review/screenshotting, not a test (see test/demo-fixture.test.js
 * and bin/opentel-mcp-ui.js's `--demo` flag for the synthetic-fixture path,
 * which injects fake SerializedSpans directly into the buffer and never
 * exercises instrumentMcpServer(), OTLP export, or the real MCP protocol
 * at all). This script does the real thing end to end:
 *
 *   real MCP Client + Server (InMemoryTransport.createLinkedPair(), the
 *   same technique bench/thrash-data-benchmark.js already uses in this
 *   repo)
 *     -> instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl })
 *     -> a real NodeTracerProvider + BatchSpanProcessor(OTLPTraceExporter)
 *     -> the dashboard's own POST /v1/traces receiver (server.js)
 *     -> the ring buffer -> SSE -> whatever's rendering the dashboard.
 *
 * Starts the dashboard itself (withUI(), fixed port 4319 -- the
 * project's documented default everywhere else: bin/opentel-mcp-ui.js,
 * with-ui.js's own default) rather than assuming one is already running.
 * If you already have a dashboard open on 4319, stop it first -- this
 * script needs the port.
 *
 * Run: node packages/ui/demo/populate.js   (from the repo root), or
 *      npm run demo --workspace=packages/ui
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from 'opentel-mcp';
import { withUI } from '../src/with-ui.js';

const PORT = 4319;
const EXPORTER_URL = `http://localhost:${PORT}/v1/traces`;

// --- Tool schemas (V1 -> V2 drives the schema-drift scenario below) ---

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
      name: 'send_slack_message',
      description: 'Post a message to a Slack channel',
      inputSchema: {
        type: 'object',
        properties: { channel: { type: 'string' }, text: { type: 'string' } },
        required: ['channel', 'text'],
      },
    },
  ];
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function silentFailure(text) {
  // isError: true inside an otherwise-successful JSON-RPC response --
  // the exact case a standard OTel setup renders as a clean green span.
  return { isError: true, content: [{ type: 'text', text }] };
}

// Called every time by create_pull_request with these arguments -- the
// SAME text every time is what makes computeFingerprint() produce the
// SAME fingerprint on every call, which is what lets ThrashDetector
// accumulate a real loop instead of five unrelated failures.
const PROTECTED_BRANCH_MESSAGE = "Permission denied: cannot push to protected branch 'main' (require pull request review)";

/**
 * @param {import('@modelcontextprotocol/sdk/types.js').CallToolRequest['params']} params
 */
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
        return silentFailure(PROTECTED_BRANCH_MESSAGE);
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

    case 'send_slack_message':
      if (args.channel === '#incidents') {
        return silentFailure('Rate limited by Slack API — retry after 12s');
      }
      return ok(`Message posted to ${args.channel}`);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callAndIgnoreThrown(client, name, args) {
  try {
    await client.callTool({ name, arguments: args });
  } catch (err) {
    // Expected for the "thrown" scenarios (run_tests/integration,
    // query_database DROP) -- these are the calls meant to be VISIBLE to
    // standard OTel, so the demo wants them to actually throw, not
    // silently succeed.
    void err;
  }
}

async function main() {
  console.log(`opentel-mcp-ui demo: starting the dashboard on http://localhost:${PORT} ...`);

  const server = new Server({ name: 'demo-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } });

  // instrumentMcpServer() must run before any setRequestHandler() call
  // (both tools/call AND tools/list, since schema drift wraps tools/list
  // too) -- see instrument.js's own documented ordering requirement.
  instrumentMcpServer(server, {
    serviceName: 'demo-mcp-server',
    setupNodeSdk: true,
    exporterUrl: EXPORTER_URL,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request.params));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'demo-client', version: '1.0.0' });

  // Deliberately NOT setting serverTransport.sessionId -- InMemoryTransport
  // has no sessionId property at all until something assigns one (checked
  // directly against the installed SDK), so this reads as a genuine
  // single-connection transport, the same as stdio, and thrash detection
  // needs no assumeSingleSession escape hatch here.
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // withUI() AFTER instrumentMcpServer() -- it needs the TracerProvider
  // instrumentMcpServer() just registered to already exist before it can
  // even attempt its own best-effort dynamic-attach path. Passing the
  // real, connected `server` object (not the wrapper's mcpServer, since
  // this is the low-level API) so /api/meta can inspect its real
  // transport and /api/summary can read its real getObservationState().
  const dashboard = await withUI(server, { port: PORT });

  console.log('opentel-mcp-ui demo: schema drift -- tools/list (v1 schema for search_codebase)...');
  await client.listTools();

  console.log('opentel-mcp-ui demo: driving realistic traffic...');

  // Successes, spread across every tool with varied, realistic arguments.
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
  for (const channel of ['#deploys', '#general', '#deploys']) {
    await client.callTool({ name: 'send_slack_message', arguments: { channel, text: 'Deploy finished' } });
  }

  // Thrash loop: the SAME tool, the SAME arguments, therefore the SAME
  // computeFingerprint() output, five times in a row -- past
  // ThrashDetector's default threshold of 3, so this is a real,
  // detected loop, not just "several failures."
  //
  // Placed BEFORE the other silent failures/thrown errors below, not
  // after: the silent-failure feed (opentel-mcp-ui's default matrix-cell
  // view) shows newest-first, so whatever runs LAST is what a viewer
  // sees at the top. With the loop last, all 5 of its identical rows
  // dominated the top of the feed; with it here, the loop still reads
  // as one contiguous, recognizable episode when scrolling (its 5 calls
  // stay consecutive), but the feed instead opens on the varied tools
  // that follow.
  console.log('opentel-mcp-ui demo: thrash loop -- create_pull_request against a protected branch, 5x...');
  for (let i = 0; i < 5; i++) {
    await client.callTool({ name: 'create_pull_request', arguments: { branch: 'main', title: 'Hotfix for prod incident' } });
  }

  // Silent failures -- isError: true inside a 200, the whole point. Kept
  // AFTER the thrash loop (see comment above) so the feed's newest,
  // most-visible rows are these varied tools, not the repeated
  // permission-denied message.
  await client.callTool({ name: 'read_file', arguments: { path: 'src/config/missing-secrets.json' } });
  await client.callTool({ name: 'read_file', arguments: { path: 'docs/missing-changelog.md' } });
  await client.callTool({ name: 'query_database', arguments: { sql: 'SELECT * FROM orders WHERE status = pending' } });
  await client.callTool({ name: 'send_slack_message', arguments: { channel: '#incidents', text: 'DB latency spike' } });
  await client.callTool({ name: 'send_slack_message', arguments: { channel: '#incidents', text: 'Retrying deploy' } });

  // Thrown/protocol errors -- VISIBLE to standard OTel (a real exception,
  // not isError: true), so client.callTool() rejects for these.
  await callAndIgnoreThrown(client, 'run_tests', { suite: 'integration' });
  await callAndIgnoreThrown(client, 'run_tests', { suite: 'integration' });
  await callAndIgnoreThrown(client, 'query_database', { sql: 'DROP TABLE sessions' });

  console.log('opentel-mcp-ui demo: schema drift -- tools/list again (v2 schema adds case_sensitive)...');
  searchCodebaseSchema = SEARCH_CODEBASE_SCHEMA_V2;
  await client.listTools();

  // The OTLP exporter batches (BatchSpanProcessor) -- force everything
  // buffered out to the dashboard now, rather than waiting on its
  // default ~5s schedule. This only tears down the tracer provider, not
  // the MCP client/server connection or the dashboard's own HTTP server.
  //
  // Deliberately NOT calling client.close() here: InMemoryTransport's
  // close() cascades to the OTHER side of the linked pair (see
  // inMemory.js -- close() calls `this._otherTransport?.close()`), which
  // would tear down the SERVER's transport too and make server.transport
  // undefined from then on. /api/meta inspects server.transport live, on
  // every request -- if the connection were closed here, anyone loading
  // the dashboard AFTER this script finishes would see transport.shape:
  // 'undeterminable' and every detector reporting 'unknown', instead of
  // the real 'single-connection' / all-live state this demo is meant to
  // show. Leaving the (idle, harmless) connection open keeps /api/meta
  // honest for as long as the dashboard itself stays up.
  await server.shutdown?.();

  console.log(`\nopentel-mcp-ui demo: done. Dashboard: ${dashboard.url}\n`);
}

main().catch((err) => {
  console.error('opentel-mcp-ui demo: failed:', err);
  process.exitCode = 1;
});
