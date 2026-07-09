# ADR 004: Semantic conventions alignment

## Context

The OTel GenAI SIG publishes semantic conventions for Model Context
Protocol (MCP) in `open-telemetry/semantic-conventions-genai`. They moved
there from the main `open-telemetry/semantic-conventions` repo, where MCP
conventions are now marked deprecated in favor of the genai repo's copy.
Their status is **Development** — explicitly not Stable — meaning
attribute names, requirement levels, and even the span-naming scheme can
still change before the spec graduates.

v0.1.0 shipped its own attribute names (`mcp.tool.name`, `mcp.tool.status`,
`mcp.request.id`, `mcp.tool.error.type`, `mcp.tool.error.message`) chosen
before this spec was reviewed against the codebase, plus a fixed
low-cardinality span name (`mcp.tool.call`) and default `INTERNAL` span
kind. Nothing has been published to npm yet, so there are no external
consumers depending on those names.

## Decision

Align to the MCP server-span conventions as currently published in the
Development-stage spec, now, before first publish — rather than shipping
our own naming and reconciling later. Concretely (see the spec's Server
span section for the full authoritative table):

- Span name: `{mcp.method.name} {target}` (target = tool name), falling
  back to `{mcp.method.name}` alone when no low-cardinality target exists.
- Span kind: `SERVER`.
- Span status: `ERROR` when `error.type` is set — either the handler threw,
  or it returned a `CallToolResult` with `isError: true` (recorded as
  `error.type = "tool_error"`, without throwing, since the JSON-RPC call
  itself succeeded); status description carries the error message.
- Attributes renamed to spec names: `mcp.tool.name` → `gen_ai.tool.name`,
  `mcp.request.id` → `jsonrpc.request.id`, `mcp.tool.error.type` →
  `error.type`.
- `mcp.method.name` added (Required; not previously emitted at all).
- `gen_ai.operation.name` added (Recommended; `"execute_tool"` for tool
  calls).
- `mcp.tool.status` and `mcp.tool.error.message` dropped — the spec
  expresses both through span status (code + description), not attributes.

## Constraints accepted

- The spec is Development-stage. It may still rename attributes, change
  requirement levels, or revise the span-naming scheme before it
  stabilizes. This package will need to follow those changes when they
  land, which may mean further attribute renames in a future release. That
  risk will be signaled explicitly in the README and in release notes,
  rather than presenting today's attribute set as more stable than it is.
- Several Recommended/Conditionally-Required attributes from the spec
  (`mcp.session.id`, `mcp.protocol.version`, `network.transport`,
  `client.address`/`client.port`, `rpc.response.status_code`,
  `jsonrpc.protocol.version`) are not emitted in this pass — the server
  doesn't currently have clean access to session/transport/network-layer
  data at the point `wrapToolCallHandler` runs. Tracked as roadmap, not
  silently dropped.
- `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` (Opt-In,
  sensitive) are intentionally not implemented yet — deferred to a
  dedicated opt-in feature with a redaction callback, tracked in the
  roadmap.
- **On the thrown-exception path, `error.type` is set to the exception's
  class name (e.g. `"TypeError"`), not the JSON-RPC error code.** The
  spec's primary guidance is that `error.type` SHOULD be the string
  representation of the JSON-RPC error code, if one is returned — but
  that guidance is a SHOULD, not a MUST, and our wrapper sits *inside*
  the SDK's error-envelope layer (`wrapToolCallHandler` wraps the raw
  tool handler, per ADR 001's "innermost layer" decision), so the
  wire-level JSON-RPC error code doesn't exist yet at the point the span
  ends — it's assigned later, when the SDK's `Protocol` catches the
  rethrown error and serializes the JSON-RPC error response. Capturing
  the real code would require wrapping at that outer layer instead, which
  ADR 001 explicitly rejected (patching `Protocol`'s response-serialization
  path is a larger, less stable surface than patching `setRequestHandler`).
  The exception class name is a reasonable substitute: it's low-cardinality
  and still useful for grouping/alerting. Revisit this if a future SDK
  version exposes the final JSON-RPC error code back to the handler layer
  (e.g. via a hook after serialization) or if the spec's guidance hardens
  from SHOULD to MUST.

## Alternatives rejected

- **Publish with our own names, rename to spec names later.** This is a
  breaking change on day two for anyone who adopted v0.1.0's attribute
  names, and forces every consumer's dashboards/queries to be rewritten
  almost immediately after they set them up. Since nothing is published
  yet, there is no cost to doing it right the first time instead.
- **Wait for the spec to stabilize, then align once.** Unbounded delay —
  Development-stage OTel semconv efforts commonly take many months to
  reach Stable, and this package would ship with self-invented,
  non-interoperable names in the meantime (or not ship at all). Every
  competing MCP instrumentation is chasing the same moving target; waiting
  doesn't avoid the churn, it just delays first publish for no benefit.

## Consequences

- `mcp.tool.argument_count` remains as a documented custom (non-spec)
  attribute — see the comment in `src/attributes.js` and the README's
  "Semantic conventions" section. It exists as a privacy-preserving
  alternative to the spec's opt-in `gen_ai.tool.call.arguments`: it gives
  shape/anomaly signal (argument count changed) without capturing argument
  values.
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, MCP metrics
  (`mcp.server.operation.duration`, `mcp.server.session.duration`), and
  `params._meta`-based trace-context propagation (SEP-414) are tracked in
  the README roadmap for v0.2/v0.3, not implemented here.
- Future spec revisions may require another attribute-naming pass; this
  ADR's "align now, signal instability" stance is expected to repeat, not
  a one-time event.
