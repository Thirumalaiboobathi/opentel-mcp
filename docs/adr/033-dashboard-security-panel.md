# ADR 033: Dashboard Security panel

**Status:** Accepted (opentel-mcp-ui 0.4.0; needs core 0.18.0 for most of its data).

## Context

ADRs 027 (clock skew), 029 to 032 add security-relevant signals to core. They are
only useful if someone looks at them, and the local dashboard is where a
developer looks. The dashboard today cannot show most of them:

- **Events are dropped.** `SerializedSpan` is a projection of attributes only
  (`serialize-span.js:85-99`, `types.d.ts:30-83`); span events are not carried.
  Integrity, pin-mismatch and audit data are span events (ADRs 029, 032).
- **`tools/list` spans are dropped.** The in-process path returns early unless
  the span name starts with `tools/call` (`collector-span-processor.js:74`) and
  so does the OTLP receiver (`otlp-json-receiver.js:90`). Integrity events live
  on the `tools/list` span.
- Everything downstream already filters by method, so non-`tools/call` spans in
  the ring would not change counts: `summary.js:33-35` and `App.tsx` use
  `isToolCallSpan`.
- Ingestion is already hardened and must stay so: loopback bind, Origin and
  Host checks (`request-guard.js`), 8 MiB OTLP body cap (`request-guard.js:26`),
  strict CSP (`csp.js`), no endpoint other than `POST /v1/traces` accepts input;
  the rest are `GET /api/*` (`server.js:12-15`, `:164-199`). The ring holds 1000
  spans (`span-buffer.js:18`).
- The UI already degrades by feature: `getFreshness()` returns null on spans
  without ADR 027 attributes and the UI shows nothing rather than "0 stale"
  (`web/data/freshness.ts:1-30`).

## Decision

### 1. Data path (small, whitelisted)

- `SerializedSpan` gains an optional `events: SerializedSpanEvent[]`.
  Only events whose name is in a fixed whitelist are kept:
  `mcp.tool.integrity.changed|pin_mismatch|added|removed` and
  `mcp.audit.sensitive_call`. Each event keeps only whitelisted attribute keys
  (those listed in ADRs 029 and 032) and only string, finite number or boolean
  values, strings capped at 256 characters; at most 32 events per span. This is
  the single place that defines what the UI will ever retain, and it matches
  what core is allowed to emit.
- Both ingestion paths (in-process processor, OTLP receiver) additionally admit
  a `tools/list` span **only if it carries at least one whitelisted event**, so
  ordinary `tools/list` traffic does not consume the 1000-span ring. Both paths
  share one function, as they already do for attributes
  (`spanFieldsFromAttributes`).
- `tools/call` spans already carry `mcp.tool.secret_leak.*`, `mcp.tool.sensitive`,
  `mcp.failure.category` and `mcp.tool.freshness.clock_skew_ms` as attributes
  (ADRs 027, 030, 032): they flow through the existing passthrough bag.

### 2. The panel

A read-only "Security" section on the main page, in the existing React app
(`web/components/SecurityPanel.tsx`), computed in the browser from spans
already delivered over SSE and history; no new endpoint, no new input.

- **Tool definitions:** integrity changes and pin mismatches: tool, old/new
  (expected/actual) hash **prefixes (first 12 characters)**, time. Pin
  mismatches are visually distinct (high severity).
- **Secret leaks:** per tool, call count and the types seen.
- **Auth failures:** per tool counts from `mcp.failure.category === "auth"`,
  with a burst highlight computed in the UI: at least 5 auth failures for one
  tool within 60 seconds (constants in one place, not configurable).
- **Sensitive tool calls:** per tool with outcomes (success, silent failure,
  error).
- **Clock skew:** tools whose spans carry `mcp.tool.freshness.clock_skew_ms`,
  with the maximum skew seen.

### 3. Hidden on older cores

The panel renders only if the buffered spans contain at least one of the
security attributes or events above. Otherwise nothing is rendered: no empty
box, no "0 findings", no error. Auth failures are derived from
`mcp.failure.category`, which older cores also set, so the auth section appears
only when there is an auth failure to show. A sub-section with no data is
omitted.

### 4. No new attack surface

- Read-only: no buttons, links or inputs that act on a server. No endpoint
  accepts input beyond the existing OTLP receiver.
- Every value shown is rendered as React text; nothing uses
  `dangerouslySetInnerHTML`, `href` built from data, or `innerHTML`. A test
  renders hostile strings (`<img onerror>`, `javascript:` URLs, 10 KB values)
  and asserts they appear as text.
- Hashes are truncated for display; the full value is not shown or copyable
  from the panel (the full hash is in the span, if anyone needs it).
- The whitelist, caps and type checks in section 1 mean a hostile or buggy
  sender cannot grow memory beyond ring capacity times the per-span event cap.
- CSP, loopback, Origin/Host checks and the body limit are unchanged.

### 5. Demo fixtures

`--demo` tells the story on the existing demo calls (so the 42 / 7 / 11 mix and the per-tool grades do not move):
`send_email`'s definition changes and no longer matches its pin (changed and pin-mismatch events on a `tools/list`
span, plus an added tool), `read_file` returns secret-shaped output three times, five `send_email` auth failures
land seconds apart (the burst), `send_email` and `write_file` are sensitive tools with mixed outcomes, and three
`get_quote` responses carry a producer clock ahead of the observer.

The fixture contains **no key in any form**. The leak is represented only by what core emits: `detected`,
`types: ["aws_access_key_id"]`, `count`. There is nothing for GitHub push protection or a scanner to flag, and no
way to confuse the demo with a real leak. Tests that need a key-shaped string assemble it at runtime from fragments.

## Alternatives considered

- **A backend `/api/security` endpoint** that aggregates. Rejected: more
  server surface; the browser already has the spans.
- **Carry all span events.** Rejected: unbounded, and the UI would retain text
  it has no use for.
- **Store `tools/list` spans in the main ring unconditionally.** Rejected: it
  would let list traffic evict tool-call history.
- **Interactive actions** (acknowledge, mute, block a tool). Rejected: the
  dashboard is read-only by design.
- **Configurable burst thresholds.** Deferred; one constant is easier to reason
  about and to test.

## Consequences

`ui` 0.4.0 shows the new panel with core 0.18.0, and everything else is
unchanged on older cores (peer range `opentel-mcp >=0.8.0 <1.0.0` already
accepts 0.18.0). The `Operations` view (which sees all buffered spans) may list
the occasional admitted `tools/list` span; a test pins its output.
