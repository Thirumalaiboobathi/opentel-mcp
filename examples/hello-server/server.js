/**
 * Minimal MCP server demonstrating opentel-mcp.
 *
 * How to run:
 *   cd examples/hello-server
 *   npm install
 *   npm start
 *
 * The server speaks MCP over stdio (newline-delimited JSON-RPC on
 * stdin/stdout). To see a tool call fire without writing a full MCP
 * client, pipe a single CallToolRequest in as one line of JSON — see
 * README.md for the exact command.
 *
 * You should see an OTel span (name "tools/call echo", kind SERVER,
 * gen_ai.tool.name "echo", status OK) printed to stderr, and the JSON-RPC
 * response on stdout, untouched. setupNodeSdk's exporter writes to stderr
 * specifically so it's safe to run alongside StdioServerTransport — see
 * ADR 003. Span shape follows the MCP semantic conventions — see ADR 004.
 * Metrics (v0.15.0+, ADR 023) print to stderr too, every 5 seconds while
 * the process stays alive — this one-shot piped run exits before that,
 * so the beforeExit hook below flushes once, same shutdown() a real
 * long-lived server's own exit sequence would make anyway.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new Server({ name: 'hello-server', version: '0.1.0' }, { capabilities: { tools: {} } });

// Must run before any tools/call handler is registered — see ADR 002.
const instrumented = instrumentMcpServer(server, {
  serviceName: 'hello-server',
  setupNodeSdk: true,
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { text } = request.params.arguments ?? {};
  return {
    content: [{ type: 'text', text: JSON.stringify({ echoed: text }) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

let flushed = false;
process.on('beforeExit', () => {
  if (flushed) return;
  flushed = true;
  instrumented.shutdown();
});
