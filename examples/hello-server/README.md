# opentel-mcp hello-server example

## What this is

The smallest possible MCP server ("echo" — one tool, one file) instrumented
with `opentel-mcp` using `setupNodeSdk: true`, so it prints OTel spans
with zero extra infrastructure. Spans go to stderr; the JSON-RPC stream
on stdout is untouched (see ADR 003) — safe to run as a real MCP server,
not just a demo.

## How to run

```sh
cd examples/hello-server
npm install
```

The server speaks MCP over stdio (newline-delimited JSON-RPC on
stdin/stdout). To see a tool call fire without writing a full MCP client,
pipe a single `tools/call` request in as one line of JSON:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello opentel-mcp"}}}' | node server.js
```

## What you'll see

stdout carries only the JSON-RPC response — exactly what a real MCP
client would receive:

```
{"result":{"content":[{"type":"text","text":"{\"echoed\":\"hello opentel-mcp\"}"}]},"jsonrpc":"2.0","id":1}
```

stderr carries the span (this and the line above are both real output
from running the command above, captured separately):

```
{
  resource: { attributes: { 'service.name': 'hello-server' } },
  traceId: 'a9571e998f8c302869cc269e066679c0',
  name: 'mcp.tool.call',
  id: 'd74d6d98328903b8',
  timestamp: [ 1783581129, 100000000 ],
  duration: [ 0, 3106818 ],
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

`status.code: 1` is `SpanStatusCode.OK`. The tool's actual response is
`{"echoed":"hello opentel-mcp"}`, visible in the stdout JSON-RPC result.
