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
  traceId: '295f095cb5eb86da043cf9314bea63f4',
  name: 'tools/call echo',
  kind: 1,
  id: '76b71d6bf184c089',
  timestamp: [ 1783599723, 215000000 ],
  duration: [ 0, 4830875 ],
  attributes: {
    'mcp.method.name': 'tools/call',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'echo',
    'mcp.tool.argument_count': 1,
    'jsonrpc.request.id': '1'
  },
  status: { code: 1 },
  events: []
}
```

`kind: 1` is `SpanKind.SERVER`. Identical shape to `examples/hello-server`'s
span — proof that `instrumentMcpServer()` behaves the same regardless of
which MCP server API you build on. Attribute names follow the [MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
(Development-stage spec) — see the main README's "Semantic conventions"
section and ADR 004. `mcp.tool.argument_count` is opentel-mcp's own
custom addition, not part of the spec.
