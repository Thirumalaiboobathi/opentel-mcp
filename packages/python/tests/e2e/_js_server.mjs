// A reference JS server for the cross-language e2e test: serves the tool definitions given in TOOLS_JSON, with tool
// integrity pinned to a deliberately wrong hash for every tool, and exports to the dashboard at EXPORTER_URL.
// stdout stays clean; progress goes to stderr. Driven through the SDK's in-memory transport (no sockets).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../../../core/src/instrument.js';

const tools = JSON.parse(process.env.TOOLS_JSON);
const wrongPin = 'sha256:' + '0'.repeat(64);
const server = new Server({ name: 'js-reference', version: '0.0.0' }, { capabilities: { tools: {} } });
instrumentMcpServer(server, {
  setupNodeSdk: true,
  serviceName: 'js-reference',
  exporterUrl: process.env.EXPORTER_URL,
  toolIntegrity: { enabled: true, pins: Object.fromEntries(tools.map((t) => [t.name, wrongPin])) },
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'fine' }] }));

const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'c', version: '0' });
await Promise.all([server.connect(a), client.connect(b)]);
await client.listTools();
await client.close();
await server.shutdown(); // flush the exporter before the process ends
