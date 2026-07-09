/**
 * Minimal McpServer (high-level API) server demonstrating opentel-mcp.
 *
 * How to run:
 *   cd examples/hello-mcpserver
 *   npm install
 *   npm start
 *
 * Same idea as examples/hello-server, but using McpServer's `.tool()`
 * registration API instead of the low-level Server's
 * `setRequestHandler(CallToolRequestSchema, ...)` — this is the API most
 * MCP servers actually use. instrumentMcpServer() auto-detects McpServer
 * by duck-typing (see detectServerKind in src/instrument.js) and
 * instruments its inner Server transparently.
 *
 * Pipe a single CallToolRequest in as one line of JSON to see a tool call
 * fire — see README.md for the exact command. Spans go to stderr; the
 * JSON-RPC stream on stdout is untouched (ADR 003).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { instrumentMcpServer } from 'opentel-mcp';
import { z } from 'zod';

const server = new McpServer({ name: 'hello-mcpserver', version: '0.1.0' });

// Must run before any .tool()/.registerTool() call — see ADR 002.
instrumentMcpServer(server, {
  serviceName: 'hello-mcpserver',
  setupNodeSdk: true,
});

server.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: JSON.stringify({ echoed: text }) }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
