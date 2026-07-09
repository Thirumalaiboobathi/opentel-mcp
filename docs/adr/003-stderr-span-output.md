# ADR 003: stderr for span output in setupNodeSdk mode

## Context

When `setupNodeSdk: true`, `instrumentMcpServer()` stands up its own
`NodeTracerProvider` for zero-infra, dev-friendly tracing. The natural
default exporter for this — `@opentelemetry/sdk-trace`'s
`ConsoleSpanExporter` — writes each span via `console.dir`, which goes to
stdout. `StdioServerTransport`, the primary MCP transport (it's how
Claude Code and most MCP clients talk to a server), also writes its
JSON-RPC protocol messages to stdout. Any other output sharing that
stream corrupts the protocol for a real client parsing stdout as
newline-delimited JSON-RPC. This made the original zero-config dev-mode
promise actively break the transport it's most likely to be used with.

## Decision

Ship a small custom `StderrSpanExporter` (`src/exporters/stderr.js`,
~20 lines) that mirrors `ConsoleSpanExporter`'s output shape but writes
via `console.error` instead of `console.dir`, landing on stderr. This is
the exporter `setupTracer()` uses by default when `setupNodeSdk` is true.
The OTLP exporter path (`exporterUrl` set) is unaffected — it exports over
the network and never touches stdout or stderr.

## Constraints accepted

- Span output is no longer literally `ConsoleSpanExporter`, so its exact
  console formatting (which OTel documents as "may change at any time")
  is instead owned by us — a small, stable maintenance surface, not a
  new dependency.
- Consumers who redirect or capture stderr for other purposes (e.g.
  piping error logs elsewhere) will now also see span dumps there. This
  is judged an acceptable tradeoff since stderr is the conventional home
  for diagnostic/log output in CLI and server tooling generally, whereas
  stdout for a stdio-transport MCP server is reserved, protocol-critical
  space.

## Alternatives rejected

- **Default `ConsoleSpanExporter` (stdout)** — the original v0.1.0
  behavior; corrupts `StdioServerTransport`, the primary MCP transport,
  making the zero-config dev-mode promise broken for the actual intended
  user.
- **File-based span output** — avoids both streams entirely, but adds
  path-handling complexity (where to write, rotation, cleanup) and is
  less discoverable for a first-run "just try it and see spans" DX than
  something that appears immediately in the terminal. Deferred to a
  future release if there's demand, not ruled out permanently.

## Consequences

Running with `setupNodeSdk: true` alongside `StdioServerTransport` is now
safe: spans print to stderr, the JSON-RPC stream on stdout stays clean.
`examples/hello-server` and its README were updated to drop the earlier
"don't combine these in production" warning in favor of a short
compatibility note, since the underlying corruption risk no longer
exists.
