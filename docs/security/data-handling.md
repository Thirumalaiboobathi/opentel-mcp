# Data handling

What each package records, where it goes, and how to record less. Everything here was checked against the code on
2026-11-07 (core 0.18.0, ui 0.4.0, python 0.1.0); file paths are given so you can re-check.

## Summary

- Tool **arguments, tool result content, resource URIs and prompt arguments are never recorded.** Only derived
  signals: counts, lengths, booleans, hashes, fixed categories ([`threat-model.md`](threat-model.md) #1).
- The one place free text can enter telemetry is **error messages and stacks** of thrown errors, controlled by
  `errorRecording` (below).
- Data goes only to OpenTelemetry exporters **you** configure. The libraries have no telemetry to the maintainer.
- The dashboard keeps data **in memory** on `127.0.0.1` and loses it on exit.

## `opentel-mcp` (npm, `packages/core`)

| Signal | What is recorded | Source |
| --- | --- | --- |
| Span (per MCP request), name `{method} {tool}`, kind SERVER | `mcp.method.name`, `gen_ai.tool.name`, `gen_ai.operation.name`, `jsonrpc.request.id`, `error.type`, `mcp.tool.argument_count` (a number), outcome | [`src/attributes.js`](../../packages/core/src/attributes.js), [README "Span attributes"](../../packages/core/README.md#span-attributes) |
| Failure fingerprint (on by default) | `mcp.failure.fingerprint`/`signature` (hashes), `category`, `origin`, `channel`, `error_class` | [`src/fingerprint/attributes.js`](../../packages/core/src/fingerprint/attributes.js) |
| Cost attribution | `mcp.tool.model` (shape-checked name) and token counts that a tool result *declares* (`usage`/`model`, `_meta.usage`/`_meta.model`, or a JSON first text block); computed cost | [`src/cost/`](../../packages/core/src/cost) |
| Unactionable-error detection, resources/prompts (opt-in) | Booleans/verdicts derived from text **lengths**; method and counts only | [`src/unactionable.js`](../../packages/core/src/unactionable.js) |
| Staleness | Verdict and derived numbers from three freshness fields of one namespaced `_meta` key, plus (v0.18.0) the integer `mcp.tool.freshness.clock_skew_ms` when `asOf` is ahead of this process's clock | [`src/staleness.js`](../../packages/core/src/staleness.js) |
| Schema drift | Hashes of a tool's `inputSchema` and the **names** of added/removed/changed schema properties (never `description`) | [`src/schema-drift/`](../../packages/core/src/schema-drift) |
| Tool definition integrity (v0.18.0, **opt-in**: `toolIntegrity`) | Span events on `tools/list`: `mcp.tool.integrity.changed` (`gen_ai.tool.name`, `old_hash`, `new_hash`), `.pin_mismatch` (`expected_hash`, `actual_hash`, `severity: "high"`), `.added` (`new_hash`), `.removed` (`old_hash`); counter `mcp.tool.integrity_violations` (label `gen_ai.tool.name`). Hashes are `sha256:` + 64 hex over a canonical JSON form of the tool's name, title, description, inputSchema, outputSchema, annotations | [`src/tool-integrity/`](../../packages/core/src/tool-integrity) |
| Secret leak detection (v0.18.0, **opt-in**: `secretLeakDetection`) | Span attributes `mcp.tool.secret_leak.detected` (boolean), `.types` (sorted names from a closed set of six), `.count` (capped number), `.scan_truncated` (boolean, only when true); counter `mcp.tool.secret_leaks` (label `gen_ai.tool.name`) | [`src/secret-leak.js`](../../packages/core/src/secret-leak.js) |
| Auth failures (v0.18.0, always on) | Counter `mcp.tool.auth_failures` (label `gen_ai.tool.name`), +1 per failed call classified `auth`; the category itself was already on the span | [`src/metrics.js`](../../packages/core/src/metrics.js) |
| Sensitive tool auditing (v0.18.0, **opt-in**: `sensitiveTools`) | Span attribute `mcp.tool.sensitive` (boolean) and span event `mcp.audit.sensitive_call` (`gen_ai.tool.name`, `mcp.tool.outcome`, `mcp.tool.duration_ms`, `mcp.failure.category` on failure) | [`src/sensitive-tools.js`](../../packages/core/src/sensitive-tools.js) |
| Thrash (loop) detection | Counts, lengths, durations, wasted tokens/cost | [`src/thrash/`](../../packages/core/src/thrash) |
| Metrics (16 `mcp.tool.*` instruments) | Counters/histograms labelled only from allowlisted attributes (tool name, method, outcome, error type, model, failure category/origin, pricing status) | [`src/metrics.js`](../../packages/core/src/metrics.js), [`src/attributes.js`](../../packages/core/src/attributes.js) |
| Exception event / span status (thrown errors only) | Depends on `errorRecording.mode` below | [`src/instrument.js`](../../packages/core/src/instrument.js) `recordThrownException` |

Never recorded: tool arguments (only the count), tool result text, `structuredContent`, other `_meta` fields, resource
URIs, prompt arguments, messages of failed resource/prompt requests, tool `description`.

What the v0.18.0 features additionally **never** record, whatever you configure:

- **Tool integrity:** the description, title, schema or annotation **text**. Only hashes of them, and tool names.
- **Secret leak detection:** the matched text, its position or any surrounding content. Only a boolean, type names
  from a closed set (`url_credentials`, `jwt`, `http_auth_credential`, `aws_access_key_id`, `provider_api_key`,
  `secret_assignment`) and a count. The type is a span attribute only, never a metric label. A leak does not change
  span status. Detection is pattern-based: absence of a detection does not mean no secret was returned.
- **Auth failures:** nothing beyond the tool name; the error text is not read for this counter.
- **Sensitive tool auditing:** arguments, argument names or values, results.
- **Clock skew:** the freshness values themselves; only the difference as an integer.

All of these are derived signals: booleans, counts, enums, hashes. None adds a metric label key (the three new
counters use `gen_ai.tool.name`, already on the allowlist).

## `opentel-mcp` (PyPI, `packages/python`, v0.1.0)

Records: span (or enrichment of the SDK's `tools/call` span on `mcp` 2.x) with the same names as above
(`mcp.method.name`, `gen_ai.tool.name`, `jsonrpc.request.id`, `error.type`, `mcp.tool.argument_count`,
`mcp.tool.outcome`, `mcp.tool.model`), failure fingerprint attributes, and metrics `mcp.tool.calls`, `errors`,
`silent_failures`, `duration` ([`_contract.py`](../../packages/python/src/opentel_mcp/_contract.py),
[`_metrics.py`](../../packages/python/src/opentel_mcp/_metrics.py)). Error recording modes and secret scrubbing mirror
core ([`_recording.py`](../../packages/python/src/opentel_mcp/_recording.py),
[`_secrets.py`](../../packages/python/src/opentel_mcp/_secrets.py)). Never recorded: argument values, result content
(canary test: [`test_privacy_and_safety.py`](../../packages/python/tests/instrumentation/test_privacy_and_safety.py)).
Features of the npm package such as staleness, thrash, cost and schema-drift detection: not verified for Python in this
review; see [ADR 028](../adr/028-python-port.md) for the port's scope.

## `opentel-mcp-ui` (dashboard)

| | |
| --- | --- |
| Receives | OTLP/HTTP **JSON** traces at `POST /v1/traces` from your server (dev mode) |
| Stores | Per span: id, trace id, name, start, duration, status, a few named fields (tool name, error type, failure fields) and the remaining span **attributes** as received. Span events are not in the serialized span, **except** a fixed whitelist of the v0.18 security events (tool integrity events on `tools/list` spans and the sensitive-call audit event), each reduced to its known attribute keys with string (≤256 chars), finite-number or boolean values and at most 32 per span ([`security-events.js`](../../packages/ui/src/security-events.js)); exception events are not retained ([`serialize-span.js`](../../packages/ui/src/serialize-span.js)). If you send other spans with sensitive attributes to it, those attributes are shown. |
| Where | Process memory only: a fixed-capacity ring buffer, 1000 spans by default ([`span-buffer.js`](../../packages/ui/src/span-buffer.js)); oldest evicted; nothing is written to disk (no file writes in `packages/ui/src`). Gone when the process exits. |
| Browser | The page stores only the light/dark theme choice in `localStorage` ([`ThemeProvider.tsx`](../../packages/ui/web/theme/ThemeProvider.tsx)). |
| Network | Listens on `127.0.0.1` only. No outbound requests from the dashboard server were found in `packages/ui/src` (not covered by an automated test). |

## Error recording modes

Option `errorRecording.mode` (Python: `error_recording={"mode": ...}`).

| Mode | Exception event | Span status message | Notes |
| --- | --- | --- | --- |
| `full` (default) | `exception.type`, `exception.message`, `exception.stacktrace` from the raw error, credentials replaced by `<SECRET>`, ids/paths/URLs/line numbers kept; message ≤ 4096, stack ≤ 16384 chars, type ≤ 128 | scrubbed message | Anything else in the message, such as a customer name, **is recorded** |
| `normalized` | type; message with ids, paths, URLs, numbers and secrets replaced; stack reduced to function/file/line frames | normalized message | A `redactor(input) → {message, stack}` runs first; if it throws or returns the wrong shape the event falls back to status only, never to raw content |
| `none` | none | none (status `ERROR` only) | Minimum |

Tests: [`security.secrets.test.js`](../../packages/core/test/security.secrets.test.js),
[`instrument.error-recording.test.js`](../../packages/core/test/instrument.error-recording.test.js),
[`instrument.error-recording.redactor.test.js`](../../packages/core/test/instrument.error-recording.redactor.test.js).
Design: [ADR 020](../adr/020-redactor-hook.md).

## Secret scrubbing: coverage and limits

Replaced with `<SECRET>` ([`secrets.js`](../../packages/core/src/fingerprint/normalize/secrets.js)): `Bearer`/`Basic`
credentials with long tokens, AWS key ids (`AKIA`/`ASIA`/...), provider-prefixed API keys (`sk-`, `sk-ant-`,
`sk-proj-`, Stripe `sk_`/`rk_`, GitHub `ghp_`…/`github_pat_`, Slack `xox…`, Google `AIza…`), JWTs, passwords in URLs
(`scheme://user:pass@host`), and values assigned to secret-named keys (`token=`, `api_key=`, `password=`,
`client_secret`, `private_key`, ...).

Limits: it is pattern-based and deliberately conservative to avoid mangling ordinary text. It **can miss** credentials
in unusual or short formats, secrets without a recognizable prefix or key name, and any non-credential personal or
business data in a message. It is not a PII filter. If error text can contain sensitive data, use `normalized`, `none`
or a `redactor`.

## Recording less

- `errorRecording: { mode: 'none' }` — no error text at all.
- `errorRecording: { mode: 'normalized', redactor }` — your own redaction before normalization.
- Switch features off: `fingerprinting: false` (failure fingerprints; thrash detection depends on it),
  `costTracking: { enabled: false }`, `enableMetrics: false`. Resources/prompts coverage is opt-in. See the
  [core README](../../packages/core/README.md) and [`src/config.js`](../../packages/core/src/config.js) for the
  remaining options.
- Configure your exporter/Collector to drop attributes you don't want (for example `jsonrpc.request.id`).
- Don't send production telemetry to the dashboard; it is intended for local development.
