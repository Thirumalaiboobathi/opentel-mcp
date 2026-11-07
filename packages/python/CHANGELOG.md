# Changelog

## 0.2.0

Security observability, matching core 0.18 (ADRs 029 to 032; Python amendment in ADR 028). Conformance contract v2.
Every new feature is opt-in except the auth failure counter, which is always on (as in JS). No metric label key was
added, and nothing here records tool arguments, result content, description or schema text, or matched secret text.

### Security

* **Tool definition integrity** (`tool_integrity={"enabled": True, "pins": {...}}`): hashes every tool definition from
  `tools/list` (`sha256:` + 64 hex over the canonical JSON of name, title, description, input/output schema,
  annotations), byte-identical with the JS package (93 shared vectors: UTF-16 key order, ECMAScript number
  formatting, `__proto__`, ...). Edge-triggered `mcp.tool.integrity.changed` / `.pin_mismatch` / `.added` /
  `.removed` span events and the `mcp.tool.integrity_violations` counter. New: `compute_tool_definition_hash()`,
  `server.get_tool_integrity_hashes()`, and in dev mode a `pins` snippet printed once to stderr. On mcp 1.x (and on
  2.x without the SDK's tracing middleware) a minimal `tools/list` span is started to hold the events, only when the
  option is on.
* **Secret leak detection in tool output** (`secret_leak_detection={"enabled": True, "max_scan_bytes": 65536}`):
  `mcp.tool.secret_leak.detected` / `.types` / `.count` / `.scan_truncated` and the `mcp.tool.secret_leaks` counter.
  The budget is in UTF-16 code units (like JS), scanned in bounded windows. A leak never changes the span status.
* **Sensitive tool auditing** (`sensitive_tools=["delete_*", "send_email"]`): `mcp.tool.sensitive` and one
  `mcp.audit.sensitive_call` event (outcome, `mcp.tool.duration_ms`, failure category) per call, on every path.
  Linear-time matching, no regular expressions.
* **Auth failure counter**: `mcp.tool.auth_failures` (label: tool name), +1 per failed call classified `auth`;
  needs `fingerprinting=True`.
* Not in Python yet: clock skew (needs staleness detection, deferred).

### Internal

* Shared conformance suite: the contract has its own `contractVersion` (now 2) instead of the core version; six new
  fixture files generated from the JS implementation (`tool-hash`, `secret-types`, `secret-scan`, `auth`,
  `sensitive-tools`, `integrity-tracker`).
* README: "Security observability" section with a runnable example and the limits.

## 0.1.0

First release of the Python port (ADR 028). Contract: core 0.17.0.

* `instrument_mcp_server()` for the low-level `Server`, `FastMCP` (mcp 1.x) and `MCPServer` (mcp 2.x); `mcp>=1.25,<3`.
* `tools/call` span, silent-failure detection, fingerprints / categories / channel, four core metrics.
* `error_recording` modes (`full`, `normalized`, `none`), redactor, secret scrubbing, length caps.
* mcp 2.x: `sdk_tracing="replace"` (default) or `"enrich"`, exactly one `tools/call` span, cause capture for
  `UnexpectedToolError`.
* Dev mode (`setup_sdk=True`): stderr exporters, OTLP/HTTP JSON to `opentel-mcp-ui`, flush on exit.
* Deferred: validation paths, unactionable errors, staleness, thrash, schema drift, resources/prompts, cost.
