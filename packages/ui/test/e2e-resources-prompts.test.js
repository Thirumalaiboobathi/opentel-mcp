/**
 * End-to-end: resources/* and prompts/* spans from a LIVE instrumented
 * server (core's opt-in `coverage: { resources, prompts }`) must reach the
 * dashboard's HTTP API, on both ingestion paths:
 *
 *   OTLP:       SDK Client --stdio--> instrumented McpServer (child process)
 *               --OTLP/HTTP JSON--> the real CLI server --> /api/*
 *   In-process: SDK Client --in-memory--> instrumented McpServer with
 *               withUI()'s CollectorSpanProcessor as a real SpanProcessor
 *               --> /api/*
 *
 * ...while everything tool-call-shaped (summary, hero stat inputs) keeps
 * counting only tools/call, and no resource URI / prompt argument is ever
 * stored or served.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { instrumentMcpServer } from 'opentel-mcp';
import { main } from '../bin/opentel-mcp-ui.js';
import { withUI } from '../src/with-ui.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/e2e-coverage-server.mjs', import.meta.url));
const TIMEOUT_MS = 30_000;
const COVERED = ['resources/read', 'resources/list', 'resources/templates/list', 'prompts/get', 'prompts/list'];
const CANARIES = ['canary-uri-7d41', 'CANARY-ARG-3e9b'];

async function pollUntil(read, predicate, description) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
}

const methodOf = (s) => s.attributes?.['mcp.method.name'];
const covered = (spans) => spans.filter((s) => COVERED.includes(methodOf(s)));

/** Drives every covered method (one resource read and one prompt get fail), plus one tool call. */
async function exerciseServer(client) {
  await client.callTool({ name: 'ping', arguments: {} });
  await client.readResource({ uri: 'doc://canary-uri-7d41/readme' });
  await client.readResource({ uri: 'item://canary-uri-7d41/42' }).catch(() => {});
  await client.listResources();
  await client.listResourceTemplates();
  await client.getPrompt({ name: 'greet', arguments: { who: 'CANARY-ARG-3e9b' } });
  await client.getPrompt({ name: 'greet', arguments: {} }).catch(() => {});
  await client.listPrompts();
}

function expectAllCoveredMethodsAndGuards(spans, summary, rawBodies) {
  const seen = new Set(covered(spans).map(methodOf));
  expect([...seen].sort()).toEqual([...COVERED].sort());
  // Failures are carried through (resources/read of the throwing template, prompts/get missing arg).
  expect(covered(spans).some((s) => s.status === 'ERROR')).toBe(true);
  // Tool-call-only surfaces are untouched: exactly the one `ping` call, no silent failures.
  expect(summary.buffered).toEqual({ total: 1, success: 1, error: 0, silentFailure: 0 });
  // No URI or prompt argument is stored or served.
  for (const body of rawBodies) for (const canary of CANARIES) expect(body).not.toContain(canary);
}

describe('resources/prompts spans from a live server reach the dashboard', () => {
  /** @type {import('node:http').Server | undefined} */
  let uiServer;
  /** @type {Client | undefined} */
  let client;
  /** @type {Awaited<ReturnType<typeof withUI>> | undefined} */
  let handle;
  /** @type {TracerProvider | undefined} */
  let provider;

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = undefined;
    await provider?.shutdown().catch(() => {});
    provider = undefined;
    trace.disable();
    await handle?.close();
    handle = undefined;
    if (uiServer) await new Promise((resolve) => uiServer.close(() => resolve()));
    uiServer?.closeAllConnections?.();
    uiServer = undefined;
  });

  it(
    'OTLP path: a stdio server with coverage enabled -> real CLI UI -> /api/spans/history',
    async () => {
      uiServer = main(['--port=0']);
      await new Promise((resolve) => uiServer.once('listening', resolve));
      const baseUrl = `http://127.0.0.1:${uiServer.address().port}`;

      client = new Client({ name: 'e2e-client', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [FIXTURE],
          env: { ...process.env, OPENTEL_MCP_E2E_EXPORTER_URL: `${baseUrl}/v1/traces`, OTEL_BSP_SCHEDULE_DELAY: '100' },
          stderr: 'pipe',
        }),
      );
      await exerciseServer(client);

      const text = async (path) => (await fetch(`${baseUrl}${path}`)).text();
      const history = await pollUntil(
        async () => JSON.parse(await text('/api/spans/history')),
        (body) => new Set(covered(body.spans).map(methodOf)).size === COVERED.length,
        'all five resource/prompt methods to reach the dashboard',
      );
      const [historyText, summaryText, liveText] = await Promise.all([
        text('/api/spans/history'),
        text('/api/summary'),
        text('/api/meta'),
      ]);
      expectAllCoveredMethodsAndGuards(history.spans, JSON.parse(summaryText), [historyText, summaryText, liveText]);
    },
    TIMEOUT_MS + 5_000,
  );

  it(
    'in-process path: withUI()\'s collector as a real SpanProcessor on the instrumented server',
    async () => {
      handle = await withUI({}, { port: 0 });
      provider = new TracerProvider({ spanProcessors: [handle.collector] });
      trace.setGlobalTracerProvider(provider);

      const server = new McpServer({ name: 'inproc-coverage', version: '0.0.0' });
      instrumentMcpServer(server, { coverage: { resources: true, prompts: true } });
      server.registerTool('ping', { description: 'ok' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      server.registerResource('doc', 'doc://canary-uri-7d41/readme', {}, async (uri) => ({
        contents: [{ uri: uri.href, text: 'hello' }],
      }));
      server.registerResource(
        'item',
        new (await import('@modelcontextprotocol/sdk/server/mcp.js')).ResourceTemplate('item://canary-uri-7d41/{id}', { list: undefined }),
        {},
        async () => {
          throw new Error('item lookup failed');
        },
      );
      server.registerPrompt('greet', { argsSchema: { who: z.string() } }, async ({ who }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `hi ${who}` } }],
      }));

      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      client = new Client({ name: 'inproc-client', version: '0.0.0' });
      await client.connect(clientSide);
      await exerciseServer(client);

      const text = async (path) => (await fetch(`${handle.url}${path}`)).text();
      const [historyText, summaryText] = await Promise.all([text('/api/spans/history'), text('/api/summary')]);
      expectAllCoveredMethodsAndGuards(JSON.parse(historyText).spans, JSON.parse(summaryText), [historyText, summaryText]);
    },
    TIMEOUT_MS,
  );
});
