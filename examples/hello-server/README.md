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

stderr carries the span, then the metrics (this and the line above are
both real output from running the command above, captured separately):

```
{
  resource: { attributes: { 'service.name': 'hello-server' } },
  traceId: '358ebcd0e263f341006b5daf49fca357',
  name: 'tools/call echo',
  kind: 1,
  id: '2ab8acbd7732fa8b',
  timestamp: [ 1783599710, 354000000 ],
  duration: [ 0, 2306889 ],
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
[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=echo,mcp.method.name=tools/call} = 1
[opentel-mcp metrics] mcp.tool.duration{gen_ai.tool.name=echo,mcp.tool.outcome=success} count=1 avg=1.2ms
```

`status.code: 1` is `SpanStatusCode.OK`. `kind: 1` is `SpanKind.SERVER`.
The tool's actual response is `{"echoed":"hello opentel-mcp"}`, visible in
the stdout JSON-RPC result.

The metrics lines (v0.15.0+, ADR 023) are a forced flush, not the normal
5-second periodic export — this one-shot piped run exits before that
interval, so `server.js` flushes once via `process.on('beforeExit', ...)`
right before exiting. A real, long-running server sees the same lines
appear on their own, repeating every 5 seconds, with no equivalent code
needed.

The span name (`tools/call echo`), kind (`SERVER`), and attribute names
follow the [MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
(Development-stage spec) — see the main README's "Semantic conventions"
section and ADR 004. `mcp.tool.argument_count` is opentel-mcp's own
custom addition, not part of the spec.
