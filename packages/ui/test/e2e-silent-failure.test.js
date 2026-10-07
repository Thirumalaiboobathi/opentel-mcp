/**
 * End-to-end: a tool call that returns `isError: true` must surface as a
 * silent failure in the dashboard's HTTP API, with nothing mocked in
 * between:
 *
 *   SDK Client --stdio--> instrumented McpServer (child process, core's
 *   wrapToolCallHandler + setupNodeSdk) --OTLP/HTTP JSON--> the real CLI's
 *   server (bin/opentel-mcp-ui.js main(), on a free port) --> ring buffer
 *   --> GET /api/summary + GET /api/spans/history
 *
 * Any layer dropping the failure status (core's isError branch, the OTLP
 * encoding, otlp-json-receiver.js, serialize-span.js's field mapping, or
 * summary.js's bucketing) fails this test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { main } from '../bin/opentel-mcp-ui.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/e2e-instrumented-server.mjs', import.meta.url));
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

/** @type {import('node:http').Server | undefined} */
let uiServer;
/** @type {Client | undefined} */
let client;
let baseUrl = '';

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return res.json();
}

/** Polls until `predicate(value)` holds, or fails after POLL_TIMEOUT_MS. No fixed sleeps. */
async function pollUntil(read, predicate, description) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
}

beforeAll(async () => {
  // The real CLI entry point, minus argv parsing side effects: port 0 asks
  // the OS for a free port, read back from the listening socket.
  uiServer = main(['--port=0']);
  await new Promise((resolve) => uiServer.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (uiServer.address());
  baseUrl = `http://127.0.0.1:${port}`;

  client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [FIXTURE],
      env: {
        ...process.env,
        OPENTEL_MCP_E2E_EXPORTER_URL: `${baseUrl}/v1/traces`,
        // Export promptly instead of on BatchSpanProcessor's 5s default
        // schedule. The poll below doesn't depend on it -- it only makes
        // the test faster.
        OTEL_BSP_SCHEDULE_DELAY: '100',
      },
      // The fixture's StderrSpanExporter logs every span to stderr.
      stderr: 'pipe',
    }),
  );
}, POLL_TIMEOUT_MS);

afterAll(async () => {
  // Closing the client closes the transport, which terminates the child.
  await client?.close().catch(() => {});
  await new Promise((resolve) => (uiServer ? uiServer.close(() => resolve()) : resolve()));
  uiServer?.closeAllConnections?.();
});

describe('end-to-end: isError tool call -> dashboard API', () => {
  it(
    'a tool call returning isError: true appears in /api/summary as a silent failure, with the right tool name and classification',
    async () => {
      const result = await client.callTool({ name: 'fetch_report', arguments: {} });
      // Sanity: the client really did see a JSON-RPC success carrying a
      // tool-level failure -- the shape that makes this failure "silent".
      expect(result.isError).toBe(true);

      // A successful call too, so the assertion below proves the failure
      // is bucketed as silentFailure rather than everything landing there.
      await client.callTool({ name: 'ping', arguments: {} });

      const history = await pollUntil(
        () => getJson('/api/spans/history'),
        (body) => body.spans.filter((s) => s.toolName === 'fetch_report' || s.toolName === 'ping').length >= 2,
        'both tool-call spans to reach the dashboard',
      );

      const failed = history.spans.find((s) => s.toolName === 'fetch_report');
      expect(failed).toMatchObject({
        toolName: 'fetch_report',
        status: 'ERROR',
        errorType: 'tool_error',
        failureCategory: 'timeout',
        failureChannel: 'execution',
      });

      const ok = history.spans.find((s) => s.toolName === 'ping');
      expect(ok.errorType).toBeUndefined();
      expect(ok.status).not.toBe('ERROR');

      const summary = await getJson('/api/summary');
      expect(summary.buffered).toEqual({ total: 2, success: 1, error: 0, silentFailure: 1 });
    },
    POLL_TIMEOUT_MS + 5_000,
  );
});
