# ADR 032: Sensitive tool auditing

**Status:** Accepted (core 0.18.0).

## Context

Some tools do things you want a reviewable record of: delete, deploy, send,
pay. Today a call to them looks like any other call: the span has the tool
name, argument *count*, status, duration and (on failure) a category
(`instrument.js:2051-2062`, `:2077-2160`), but nothing marks the call as
sensitive, so finding "every call to a destructive tool, and how it ended"
means writing a query that hard-codes tool names in every backend.

## Decision

### 1. Option

```js
sensitiveTools: ["delete_record", "deploy_*"]   // default []
```

Exact names, plus `*` wildcards matching any run of characters (including
none). Everything else is literal: no regex, no `?`, no character classes.
Matching is case-sensitive, on the `tools/call` request's tool name (the same
value as `gen_ai.tool.name`).

- Patterns are compiled once when `instrumentMcpServer` is called.
- Matching uses a linear-time glob matcher (split on `*`, anchored first and
  last segments, `indexOf` for the middle ones), not a regex built from user
  text, so a hostile pattern or name cannot cause catastrophic backtracking.
- Invalid entries (non-string, empty, longer than 256 characters) warn once and
  are skipped; entries beyond 1000 are ignored with the same warning. A
  non-array value warns once and is ignored. Default `[]` means the feature is
  off and costs nothing per call.

### 2. What is recorded

For a matching call:

- Span attribute `mcp.tool.sensitive = true`, set at span start (known before
  the handler runs).
- One span event `mcp.audit.sensitive_call` added when the call ends, on every
  path (success, silent failure, thrown), with attributes:
  `gen_ai.tool.name`, `mcp.tool.outcome` (`success` | `silent_failure` |
  `error`, the existing `ATTR_MCP_TOOL_OUTCOME` values, `attributes.js:129-138`),
  `mcp.tool.duration_ms` (number) and, on failure when the failure category was
  computed, `mcp.failure.category`.
- The trace id, span id and timestamps come with the span. There is no
  separate audit record.

Never recorded: arguments, argument values or names, results, error messages
beyond what existing options already put on the span.

No new metric. The boolean attribute and event live on the span only.

### 3. What this is not

Span events are telemetry, not a tamper-evident audit log. If spans are
sampled out, dropped by an exporter, or the process dies before the batch
exports, the record is lost, and anyone who controls the process can control
its telemetry. Documentation recommends a tail-sampling rule that keeps traces
where `mcp.tool.sensitive = true`, and says plainly that this does not meet an
audit-log requirement by itself.

## Alternatives considered

- **Regex patterns.** Rejected: ReDoS surface and harder to review; `*` covers
  the real need.
- **A metric** (`mcp.tool.sensitive_calls`). Rejected: spans already carry the
  attribute and the event; the brief adds no new label keys.
- **OTel Logs for audit events.** Rejected: the package emits no logs and has
  no Logs SDK wiring; a span event inherits trace context for free.
- **Auto-detecting sensitive tools** from names or annotations
  (`destructiveHint`). Rejected: guessing is the wrong default for an audit
  list; `annotations.destructiveHint` can inform a later opt-in ADR.
- **Recording argument keys.** Rejected: derived signals only.

## Consequences

Backends can filter on one boolean. Config drift is the operator's problem: a
tool not on the list is not audited. Wildcards can over-match; that fails safe
(more is audited).
