# ADR 002: Instrument-first violation detection

## Context

ADR 001 requires `instrumentMcpServer()` to run before any `tools/call`
handler is registered, since it works by patching `setRequestHandler` on
the server instance. If a handler is already registered by the time
`instrumentMcpServer()` runs, that registration bypassed the patch entirely
and will never be wrapped in a span. This should fail loudly rather than
silently produce an uninstrumented server. The SDK does not expose a
public getter for "is a handler registered for method X" — but `Protocol`
(inherited by `Server`) does expose `assertCanSetRequestHandler(method)`,
a public, non-underscore-prefixed method that throws if a handler already
exists for the given method. `McpServer` itself calls this exact method
internally before installing its own `tools/call` dispatcher.

## Decision

Call `server.assertCanSetRequestHandler('tools/call')` in a try/catch
immediately before patching. If it throws, throw
`instrumentMcpServer`'s own actionable error instead of the SDK's generic
one. The call is guarded by `typeof server.assertCanSetRequestHandler === 'function'`;
if that check fails (a future SDK version removes or renames the method),
detection is skipped silently and only the `Symbol`-based idempotency
guard remains.

## Constraints accepted

- Detection depends on an SDK method whose own JSDoc frames it as being
  "in preparation for a new [handler] being automatically installed" —
  i.e. intended primarily for the SDK's internal coordination, not
  documented as public API for third parties. It is, however, unprefixed
  and already relied upon by `McpServer`, making it far more stable than
  reaching into `_requestHandlers` directly.
- If this method is ever removed, `instrumentMcpServer()` silently stops
  detecting instrument-after-registration misuse and falls back to
  documentation plus the idempotency guard alone — matching what we would
  have shipped by default had this method not existed.

## Alternatives rejected

- **Reading `Protocol`'s private `_requestHandlers` Map directly** — same
  objection as ADR 001: an underscore-prefixed internal field with no
  version-stability guarantee.
- **No detection, docs-only** — simplest and zero-coupling, but a
  misordered call would silently no-op instead of failing with an
  actionable message; rejected in favor of real detection since a stable,
  public entry point (`assertCanSetRequestHandler`) already exists for it.

## Consequences

Instrument-first violations fail fast with a message telling the caller
exactly what to move and where. This detection is inherently best-effort:
it degrades gracefully (per the `typeof` guard) if the SDK ever changes,
at which point this ADR's fallback behavior — documentation-only — takes
over automatically without a code change on our side.
