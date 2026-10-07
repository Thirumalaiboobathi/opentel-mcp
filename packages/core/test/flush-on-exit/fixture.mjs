// Child process for test/flush-on-exit/flush-on-exit.test.js (ADR 024).
// An McpServer instrumented with setupNodeSdk: true makes one real tool
// call (so there's a metric to flush), then behaves per FIXTURE_MODE:
//
//   exit         - nothing keeps the loop alive: the process drains and exits
//   keepalive    - a ref'd interval keeps it alive until a signal arrives
//   host-handler - keepalive + the host's own SIGTERM listener, which exits 7
//
// Dev metrics only print every 5 s, so "[opentel-mcp metrics] mcp.tool.calls"
// on stderr before exit can only come from the shutdown-time flush.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpServer } from '../../src/index.js';

const mode = process.env.FIXTURE_MODE ?? 'exit';
const options = JSON.parse(process.env.FIXTURE_OPTIONS ?? '{}');

const server = new McpServer({ name: 'flush-fixture', version: '0.0.0' });
instrumentMcpServer(server, { serviceName: 'flush-fixture', setupNodeSdk: true, ...options });
server.registerTool('echo', { description: 'echo' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

const call = server.server._requestHandlers.get('tools/call');
await call(
  { method: 'tools/call', params: { name: 'echo', arguments: {} } },
  { requestId: 1, signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => {} },
);

if (process.env.FIXTURE_EXIT_CODE) process.exitCode = Number(process.env.FIXTURE_EXIT_CODE);

if (process.env.FIXTURE_EXPLICIT_SHUTDOWN === '1') {
  await server.shutdown();
  await server.shutdown();
  process.stderr.write('EXPLICIT SHUTDOWN DONE\n');
}

if (mode === 'host-handler') {
  process.on('SIGTERM', () => {
    process.stderr.write('HOST HANDLER\n');
    // Give flushOnExit time to flush, then exit the host's own way.
    setTimeout(() => process.exit(7), 1500);
  });
}

if (mode === 'keepalive' || mode === 'host-handler') {
  setInterval(() => {}, 1000);
}

process.stdout.write('READY\n');
