// A real, minimal opentel-mcp-instrumented MCP server for
// test/e2e-silent-failure.test.js. Spawned as a child process and driven
// over real stdio by the SDK's own StdioClientTransport. Exports spans over
// OTLP/HTTP JSON to the URL in OPENTEL_MCP_E2E_EXPORTER_URL -- exactly what
// the README tells a user to do with a running opentel-mcp-ui.
//
// stdout belongs to the MCP protocol: nothing here may write to it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { instrumentMcpServer } from 'opentel-mcp';

const exporterUrl = process.env.OPENTEL_MCP_E2E_EXPORTER_URL;

const server = new McpServer({ name: 'e2e-silent-failure', version: '0.0.0' });

// Instrument first, then register tools (ADR 001/002 ordering).
instrumentMcpServer(server, {
  serviceName: 'e2e-silent-failure',
  setupNodeSdk: true,
  exporterUrl,
});

// Returns a tool-level failure inside a successful JSON-RPC response --
// the silent failure a plain OTel setup renders green. The wording is
// chosen to hit core's timeout classifier (fingerprint/classify/timeout.js).
server.registerTool('fetch_report', { description: 'always fails silently' }, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'Upstream request timed out' }],
}));

server.registerTool('ping', { description: 'always succeeds' }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

await server.connect(new StdioServerTransport());
