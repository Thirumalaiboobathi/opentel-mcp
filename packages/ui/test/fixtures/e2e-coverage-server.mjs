// Real opentel-mcp-instrumented MCP server with core's opt-in
// `coverage: { resources, prompts }` enabled, for
// test/e2e-resources-prompts.test.js. Spawned as a child process and driven
// over real stdio; exports spans over OTLP/HTTP JSON to
// OPENTEL_MCP_E2E_EXPORTER_URL. stdout belongs to the MCP protocol.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new McpServer({ name: 'e2e-coverage', version: '0.0.0' });

instrumentMcpServer(server, {
  serviceName: 'e2e-coverage',
  setupNodeSdk: true,
  exporterUrl: process.env.OPENTEL_MCP_E2E_EXPORTER_URL,
  coverage: { resources: true, prompts: true },
});

server.registerTool('ping', { description: 'always succeeds' }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

server.registerResource('doc', 'doc://canary-uri-7d41/readme', { description: 'a doc' }, async (uri) => ({
  contents: [{ uri: uri.href, text: 'hello' }],
}));
server.registerResource(
  'item',
  new ResourceTemplate('item://canary-uri-7d41/{id}', { list: undefined }),
  { description: 'templated' },
  async (uri) => {
    throw new Error('item lookup failed');
  },
);

server.registerPrompt('greet', { description: 'greets', argsSchema: { who: z.string() } }, async ({ who }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `hi ${who}` } }],
}));

await server.connect(new StdioServerTransport());
