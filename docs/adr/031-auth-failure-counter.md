# ADR 031: Auth failure counter

**Status:** Accepted (core 0.18.0).

## Context

Repeated 401/403/permission failures on a tool are the visible edge of
credential probing, a broken deployment, or an agent hitting something it should
not. The data is mostly already there:

- The classifier already has an `auth` category: 401/403 on `status` or
  `statusCode`, names `UnauthorizedError`/`ForbiddenError`/`AuthError`, codes
  `EACCES`/`EPERM`, and wording such as "unauthorized", "forbidden",
  "authenticat…", "not authorized", "permission(s) denied", "access denied",
  "insufficient permission(s)" (`fingerprint/classify/auth.js:46-66`).
- The category is computed for both failure channels: `isError: true` results
  (silent failures, `instrument.js:2077-2095`) and thrown errors
  (`instrument.js:2177-2190`), and is stored on the span as `mcp.failure.category`.
- It is **only computed when `fingerprinting` is on**, which is the default
  (`config.js:345`); `failureCategory` is `''` otherwise
  (`instrument.js:2084`, `:2177`).
- `mcp.failure.category` is already an allowed label on `mcp.tool.errors`,
  `mcp.tool.silent_failures` and `mcp.tool.duration`
  (`metrics.js:143-165`, `fingerprint/attributes.js:87`). So "auth failures per
  tool" is derivable today, but only by summing two counters filtered on a label
  of each.

## Decision

Counter `mcp.tool.auth_failures`, label `gen_ai.tool.name` only, incremented
once per failed call (silent **or** thrown) whose classified category is `auth`.
Implemented as `recordAuthFailure(toolName)` in `metrics.js` next to
`recordStaleResponse` (`metrics.js:118-133`) and called from the two existing
branches (`instrument.js:2144`, `:2221`) when `failureCategory === 'auth'`.

- **Always on, no option.** One counter add per auth failure; it reveals
  nothing new, since the category is already on the span and on existing
  metrics. It still obeys `enableMetrics`.
- **Same definition of "auth" as the span.** No second classifier. So it
  inherits that classifier's reach and false positives: `EACCES`/`EPERM` also
  covers local filesystem permission errors, and a message containing
  "forbidden" counts. The counter means "failures classified as auth", not
  "credential attacks".
- **Depends on fingerprinting.** With `fingerprinting: false` no category is
  computed, so the counter stays at zero. Documented rather than worked around:
  running the classifier separately would duplicate the work fingerprinting
  skips on purpose.
- **Burst detection is not in core.** Core stays a recorder. A burst is a rate
  over a window; the UI (ADR 033) computes it from spans, and operators can
  alert on `rate(mcp_tool_auth_failures[...])` in their backend.

Why a new counter when the data is derivable: one series per tool unifying both
channels is what an alert or a dashboard panel wants; the existing form needs
two metrics and a label filter, and the new counter makes the intent explicit
in the metric name. The label set is the existing `gen_ai.tool.name`, so ADR 021
is unaffected and no allowlist changes.

## Alternatives considered

- **Add the counter behind an option.** Rejected: no cost, no new data.
- **A separate auth-only classifier** that runs even without fingerprinting.
  Rejected: duplicated logic that would drift from the span's category.
- **Label by failure channel (silent vs thrown).** Rejected: a new label key;
  the channel is on the span.
- **Burst detection in core** (sliding window, threshold option). Rejected:
  new state and a threshold policy for no extra data; the UI and backends can
  compute it.

## Consequences

An operator gets a per-tool auth-failure rate with no configuration. The
meaning is limited to the classifier's, and the counter is silent when
fingerprinting is disabled.
