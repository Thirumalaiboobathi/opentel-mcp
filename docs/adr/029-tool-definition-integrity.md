# ADR 029: Tool definition integrity ("rug pull" detection)

**Status:** Accepted (core 0.18.0). Extends [ADR 010](010-schema-drift.md); does not replace it.

## Context

An MCP server tells the model what its tools are and how to use them through
`tools/list`: name, description, input schema and, optionally, title, output
schema and annotations. All of it is text the model trusts. A server (or one
of its dependencies) that changes a description after a client has approved the
tool, or ships a poisoned description in a dependency update, changes the
model's behavior without changing any call-time signal: no error, no latency
change, a green span. This is the "rug pull" / tool-poisoning class of attack.

opentel-mcp already observes `tools/list`, but only for one purpose and only
part of the definition:

- `tools/list` is wrapped only when `schemaDrift.enabled`
  (`packages/core/src/instrument.js:581-589`, `:628`, `:690`, `:925`); with
  schema drift off there is no `tools/list` span and nothing is captured.
- The drift hash covers **`inputSchema` only**: `captureToolSchema()` reads
  `tool.name` and `tool.inputSchema` and nothing else
  (`schema-drift/compose.js:80-97`). The module states that `description` is
  deliberately never read (`schema-drift/compose.js:14-19`), because ADR 010
  decided description drift is an independent dimension and rejected "one
  combined fingerprint".
- That hash is `sha256(...).slice(0, 16)` (`fingerprint/hash.js:37`), prefixed
  `v1|` (`schema-drift/compose.js:36`), and is stored in a bounded per-server
  map (`schema-drift/detector.js:60-117`). It is a drift signal, not an
  integrity primitive: 64 bits, and blind to descriptions.
- Drift is reported as a counter plus a span event on the active `tools/list`
  span (`schema-drift/emitter.js`), and the wrapper catches and `diag.debug`s
  any capture failure so the real response is never affected
  (`instrument.js:2296-2310`).

## Decision

A separate, opt-in integrity tracker that rides on the same `tools/list`
observation point but shares no state with schema drift.

### 1. The hash

`computeToolDefinitionHash(definition)` returns `"sha256:" + <64 lowercase hex>`
over the UTF-8 bytes of a canonical JSON serialization of an object containing,
**when present**: `name`, `title`, `description`, `inputSchema`,
`outputSchema`, `annotations`. Canonical form: every object's keys sorted
(UTF-16 code-unit order, i.e. `Array.prototype.sort()` default) at every depth,
array order preserved, `JSON.stringify` with no whitespace. `undefined`-valued
keys are omitted; the canonical text is built directly (not by copying into a new object), so a key named `__proto__` is hashed like any other; no Unicode normalization (a homoglyph or normalization-form
change is a real change and must change the hash).

Anything not in the list (`_meta`, `icons`, `execution`, vendor keys) is not
covered. That is a stated limit, not an accident: the list is exactly the text
and structure a model reads to decide what a tool does.

The hash is versioned by its `sha256:` prefix and by this ADR; a future change
to the covered fields ships as a new prefix (`sha256v2:`), never a silent
reinterpretation. A definition that cannot be canonicalized (cycle, throwing
getter, `BigInt`) yields no hash for that tool and one `diag.debug`; it never
throws into `tools/list`.

ADR 010's `inputSchema` hash is unchanged.

### 2. Where it is observed

In `wrapToolsListHandler` (`instrument.js:2274`), after the original handler
returns, alongside the existing drift capture and inside its own `try/catch`.
`tools/list` is therefore wrapped when `schemaDrift.enabled || toolIntegrity.enabled`
(`instrument.js:581`, `:628`, `:690`, `:925` all gain the `||`), and the wrapper
tolerates a null drift detector. Integrity works with `schemaDrift: {enabled:false}`.
With both off nothing is wrapped (unchanged).

### 3. Option

```js
toolIntegrity: { enabled: false, pins: { "get_quote": "sha256:<64 hex>" } }
```

`enabled` defaults to **false**. `pins` is optional; entries must match
`^sha256:[0-9a-f]{64}$`, anything else warns once and is skipped. Non-object
`toolIntegrity` or `pins` warns once and is ignored. A tool not in `pins` gets
change detection only. A pinned tool that never appears in `tools/list` produces
no event (documented limit).

### 4. Events and metric

State per server instance (not per session; same reasoning as ADR 010 Q4) in a
bounded map (reuses `schema-drift/store.js`'s `BoundedMap`, cap 1000 tools).
Events are span events on the `tools/list` span, **edge-triggered**: they fire
when a tool's classification changes, not on every `tools/list`, so a
persistent mismatch does not flood.

| Event | When | Attributes |
|---|---|---|
| `mcp.tool.integrity.changed` | current hash differs from the first hash seen for the tool in this process (fires once per distinct new hash) | `gen_ai.tool.name`, `mcp.tool.integrity.old_hash`, `mcp.tool.integrity.new_hash` |
| `mcp.tool.integrity.pin_mismatch` | hash differs from the configured pin, including on first observation (fires once per distinct actual hash) | `gen_ai.tool.name`, `mcp.tool.integrity.expected_hash`, `mcp.tool.integrity.actual_hash`; severity: `mcp.tool.integrity.severity = "high"` |
| `mcp.tool.integrity.added` | tool absent from the first complete listing appears later | `gen_ai.tool.name`, `mcp.tool.integrity.new_hash` |
| `mcp.tool.integrity.removed` | tool in a previous complete listing is missing | `gen_ai.tool.name`, `mcp.tool.integrity.old_hash` |

`added`/`removed` are evaluated only on a complete listing: a request carrying a
`cursor`, or a result with `nextCursor`, is a page and is skipped for set
comparison (hashes of the tools it does contain are still checked).

Counter `mcp.tool.integrity_violations`, label `gen_ai.tool.name` only (already
in `METRIC_SAFE_ATTRIBUTES`, `attributes.js:302`), +1 per tool per `tools/list`
observation that newly reports `changed` and/or `pin_mismatch` (one increment
even if both fire). Not incremented for added/removed. Gated on `enableMetrics`
like the other emitters.

Events never carry description or schema text; hashes only. They are added to the `tools/list` span the wrapper holds, not to whatever span is active, so they appear even where the host registered no context manager.

### 5. Getting hashes to pin

- `computeToolDefinitionHash(definition)` is exported from the package root.
- The instrumented server gets `getToolIntegrityHashes()` returning the current
  `{ [toolName]: "sha256:..." }` map from the last observation (`{}` when
  disabled or nothing listed), attached like `getThrashSummary` (`instrument.js:530`).
- In dev mode (`setupNodeSdk: true`) with integrity enabled, after the first
  complete `tools/list` observation, a copy-pasteable `pins` snippet is written
  once to **stderr** (never stdout: stdio MCP transports use stdout for
  protocol). No CLI in this release.

### 6. Privacy

Tool names (already on every span) and hashes only. No description, title,
schema or annotation text reaches spans, events, metrics, logs or `diag`
messages; warnings name the option, never the value.

## Alternatives considered

- **Extend the ADR 010 hash** to include description. Rejected: it would
  silently change every existing `previous_hash`/`current_hash` consumers hold,
  re-trigger drift for all users, and contradicts ADR 010's separation of
  dimensions.
- **Reuse the schema-drift store and detector** for integrity. Rejected:
  integrity must run with drift disabled, the semantics differ (baseline is the
  *first* hash, not the last; pins; edge-triggering), and coupling the two
  would make a drift bug able to hide an integrity event.
- **Block or auto-revert on mismatch.** Rejected: opentel-mcp is an observer
  and must never alter the server's behavior or throw into it.
- **Truncated 16-hex hash** like ADR 010. Rejected: pinning is a security
  claim; use the full SHA-256.
- **Boolean span attribute** (`mcp.tool.integrity.violation`) on the span, as
  ADR 011 did for drift, for tail sampling. Not added now; the events and
  counter are the contract. Revisit with real use.
- **Per-session tracking.** Rejected for the reason in ADR 010 Q4.

## Consequences and limits

- Detection, not prevention: the changed definition has already been served.
- The first hash seen is trusted. If the server is malicious from process
  start, only pins catch it.
- Anyone who can modify the server can also change its telemetry; this is a
  signal for operators, not a tamper-proof record.
- Pagination limits `added`/`removed` as described above.
- Cost: one canonicalization and SHA-256 per tool per `tools/list`, only when enabled.
- Conformance: JS-only in 0.18 (ADR 034).
