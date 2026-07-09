# opentel-mcp

> OpenTelemetry instrumentation for Model Context Protocol (MCP) servers.
> Zero-config visibility into which tools your AI agent is calling, how
> long they take, and which ones fail — via standard OTel traces.

[![CI](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opentel-mcp.svg)](https://www.npmjs.com/package/opentel-mcp)
[![license](https://img.shields.io/npm/l/opentel-mcp.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/LICENSE)

## Why

When Claude Code calls 15 MCP tools across 3 servers, you have zero
visibility into which was slow, which errored silently, which sequence
ran. opentel-mcp wraps any MCP server and emits one OTel span per tool
invocation with rich attributes, using standard OpenTelemetry APIs so
it plugs into your existing observability stack (Jaeger, Grafana Tempo,
Honeycomb, Datadog, whatever).

## Install

```bash
npm install opentel-mcp @opentelemetry/api
```

## Quickstart (5-line usage)

Works with either the low-level `Server` API:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new Server({ name: 'my-server', version: '1.0.0' }, {
  capabilities: { tools: {} }
});

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,  // dev-friendly stderr output; omit in prod
                        // if you already have OTel configured
});

// ...register tools as usual...
server.setRequestHandler(CallToolRequestSchema, async (request) => { /*...*/ });
```

...or the high-level `McpServer` API most servers actually use:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpServer } from 'opentel-mcp';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
});

// ...register tools as usual...
server.tool('my-tool', async (args) => { /*...*/ });
```

Either way, `instrumentMcpServer()` must run before any tool is
registered — see "Ordering constraint" below.

## Span attributes emitted

| Attribute | Description | Example |
|---|---|---|
| mcp.tool.name | Tool name from request | "echo" |
| mcp.tool.status | "ok" or "error" | "ok" |
| mcp.tool.argument_count | Number of arguments (values not captured) | 2 |
| mcp.request.id | JSON-RPC request id | "abc-123" |
| mcp.tool.error.type | Error class name (on failure) | "TypeError" |
| mcp.tool.error.message | Error message (on failure) | "Invalid input" |

Span name: `mcp.tool.call` (constant — low-cardinality per OTel best
practice; use mcp.tool.name attribute for per-tool filtering).

## Two modes

**Zero-config (dev):** `setupNodeSdk: true` sets up a NodeTracerProvider
that prints spans to stderr (safe alongside stdio-transport MCP servers —
see ADR 003), optionally + an OTLP exporter if `exporterUrl` is provided.

**Bring-your-own-SDK (prod):** Omit `setupNodeSdk` (default false).
opentel-mcp uses whatever tracer provider you've already registered
via `trace.setGlobalTracerProvider()`. This means it plugs into any
existing OTel setup without conflict.

## Ordering constraint

Call `instrumentMcpServer()` BEFORE registering any tool handlers —
before `server.setRequestHandler(CallToolRequestSchema, ...)` (low-level
`Server`) or before any `.tool()`/`.registerTool()` call (`McpServer`).
See ADR 002 in docs/adr/ for why.

## Compatibility

- Node.js 20+
- Windows, macOS, Linux (CI matrix tested)
- Pure JavaScript, zero native dependencies
- Supports both low-level `Server` and high-level `McpServer` APIs
- @modelcontextprotocol/sdk ^1.0.0
- @opentelemetry/api ^1.9.0

## Roadmap

- v0.2: OTel metrics (invocation counter + duration histogram) alongside traces
- v0.3: Client-side instrumentation + trace-context propagation via MCP's
  `_meta` field, so a single trace can span the client call and the
  server's tool execution
- Future: alignment with OTel GenAI SIG's MCP semantic conventions
  when published

## Contributing

See CONTRIBUTING.md and docs/adr/ for architecture decisions.
Issues and PRs welcome.

## License

MIT © Thirumalaiboobathi B
