# Changelog

## 0.1.0

First release of the Python port (ADR 028). Contract: core 0.17.0.

* `instrument_mcp_server()` for the low-level `Server`, `FastMCP` (mcp 1.x) and `MCPServer` (mcp 2.x); `mcp>=1.25,<3`.
* `tools/call` span, silent-failure detection, fingerprints / categories / channel, four core metrics.
* `error_recording` modes (`full`, `normalized`, `none`), redactor, secret scrubbing, length caps.
* mcp 2.x: `sdk_tracing="replace"` (default) or `"enrich"`, exactly one `tools/call` span, cause capture for
  `UnexpectedToolError`.
* Dev mode (`setup_sdk=True`): stderr exporters, OTLP/HTTP JSON to `opentel-mcp-ui`, flush on exit.
* Deferred: validation paths, unactionable errors, staleness, thrash, schema drift, resources/prompts, cost.
