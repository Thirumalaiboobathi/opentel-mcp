# opentel-mcp hello-mcpserver example

## What this is

The same "echo" tool as `examples/hello-server`, but built on `McpServer`
— the high-level `.tool()` registration API most real MCP servers use —
instead of the low-level `Server` class. `instrumentMcpServer()`
auto-detects `McpServer` by duck-typing (see `detectServerKind` in
`src/instrument.js`) and instruments its inner `Server` transparently, no
different call needed.

## How to run

```sh
cd examples/hello-mcpserver
npm install
```

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello from McpServer"}}}' | node server.js
```

## What you'll see

stdout carries only the JSON-RPC response:

```
{"result":{"content":[{"type":"text","text":"{\"echoed\":\"hello from McpServer\"}"}]},"jsonrpc":"2.0","id":1}
```

stderr carries the span (both captured from a real run of the command
above):

```
{
  resource: { attributes: { 'service.name': 'hello-mcpserver' } },
  traceId: 'cb8417c1bdb5084c4b15b87a75358107',
  name: 'mcp.tool.call',
  id: '7b39c34450336ee3',
  timestamp: [ 1783581466, 140000000 ],
  duration: [ 0, 4796772 ],
  attributes: {
    'mcp.tool.name': 'echo',
    'mcp.tool.argument_count': 1,
    'mcp.request.id': '1',
    'mcp.tool.status': 'ok'
  },
  status: { code: 1 },
  events: []
}
```

Identical shape to `examples/hello-server`'s span — proof that
`instrumentMcpServer()` behaves the same regardless of which MCP server
API you build on.
