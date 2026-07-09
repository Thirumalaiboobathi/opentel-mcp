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
 * You should see an OTel span (name "mcp.tool.call", mcp.tool.name "echo",
 * mcp.tool.status "ok") printed to stderr, and the JSON-RPC response on
 * stdout, untouched. setupNodeSdk's exporter writes to stderr specifically
 * so it's safe to run alongside StdioServerTransport — see ADR 003.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new Server({ name: 'hello-server', version: '0.1.0' }, { capabilities: { tools: {} } });

// Must run before any tools/call handler is registered — see ADR 002.
instrumentMcpServer(server, {
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
