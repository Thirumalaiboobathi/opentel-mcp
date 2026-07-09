# ADR 001: Tool-call wrapping strategy

## Context

`instrumentMcpServer(server, options)` needs to wrap every MCP tool
invocation in an OTel span. Reading the `@modelcontextprotocol/sdk` source
(`shared/protocol.js`, `server/index.js`, `server/mcp.js`) shows that both
the low-level `Server` class and the high-level `McpServer` class funnel
tool-call registration through the same method: `Server.prototype.setRequestHandler`.
`McpServer` has no `setRequestHandler` of its own — it lazily calls
`this.server.setRequestHandler(CallToolRequestSchema, dispatcherFn)` on its
internal `Server` instance the first time a tool is registered. The SDK
exposes no hook, event, or public accessor for handlers already registered;
the only extension point is this one method.

## Decision

Patch `setRequestHandler` on the **server instance** (not `Server.prototype`):
any call where the schema argument is reference-equal to the SDK's exported
`CallToolRequestSchema` gets its handler wrapped in span-creation logic
before being passed to the original method. Idempotency is guarded by a
`Symbol` property set on the instrumented instance, checked and returned
early on a second call.

## Constraints accepted

- **Instrument-first ordering.** `instrumentMcpServer()` must be called
  before any `'tools/call'` handler is registered, since it only intercepts
  future calls to `setRequestHandler`. Calling it against a `Server` that
  isn't a recognized low-level `Server` instance throws immediately rather
  than silently no-op'ing.
- **Low-level `Server` only in v0.1.** `McpServer` is not detected or
  supported yet.

## Alternatives rejected

- **Patching `Server.prototype.setRequestHandler`** — affects every
  `Server` instance process-wide, not just the one being instrumented.
- **Reading/rewriting `Protocol`'s private `_requestHandlers` Map directly**
  — would support both registration orderings, but couples us to an
  underscore-prefixed internal field with no stability guarantee across
  SDK versions.
- **Deriving the `'tools/call'` method string from the zod schema** — the
  SDK itself has to branch on zod v3 vs v4 internals to do this; reference
  equality against the exported schema constant avoids that coupling
  entirely.

## Consequences

`McpServer` support is deferred to v0.2, to be added by detecting a
`.server` property that is a `Server` instance and instrumenting that
instead. Real-world servers that register tools before instrumentation
(e.g. import-time `.tool()` calls) are not covered until then.

**Update (2026-07-09):** McpServer support was pulled into the initial
release instead of deferred to v0.2, via duck-typed detection of a
`.server` object (not an `instanceof McpServer` check, to avoid importing
the class at all — see the `detectServerKind` comment in `src/instrument.js`
and no dedicated ADR was deemed necessary since it's a direct, unmodified
application of this ADR's existing unwrap-and-instrument strategy).
Instrument-before-registration is still required, now covering both
`server.setRequestHandler(CallToolRequestSchema, ...)` and
`.tool()`/`.registerTool()`.
