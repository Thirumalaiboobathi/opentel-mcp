# opentel-mcp (Python)

OpenTelemetry instrumentation for MCP servers built on the official Python SDK (`mcp`), with a tool-call span,
failure fingerprints and metrics that match the [JavaScript `opentel-mcp`](https://github.com/Thirumalaiboobathi/opentel-mcp/tree/main/packages/core)
package field for field, so the same dashboard (`opentel-mcp-ui`) works for both.

> **Contract:** core 0.17.0. **Python:** 3.10 to 3.14. **MCP SDK:** `mcp>=1.25,<3` (1.x and 2.x), detected at runtime.

## Why

Most tool failures never raise. An MCP tool that returns `isError: true` is a **successful JSON-RPC response**, so
a trace backend shows a green request while the agent just got an error. This package makes that failure visible:

* the `tools/call` span is marked `ERROR` with `error.type = tool_error` (a **silent failure**);
* every failure gets a stable **fingerprint**, a **category** (`validation`, `timeout`, `network`, `auth`,
  `dependency`, `serialization`, `internal`) and a **channel** (`execution` or `protocol.*`), so "the same bug"
  groups together across ids, timestamps and paths;
* four metrics, including `mcp.tool.silent_failures`;
* exceptions are recorded with **credentials scrubbed**, length-capped, and optionally normalized or dropped.

On mcp 2.x the SDK already marks an `isError` span red; what it does not give you is the fingerprints, categories,
metrics and privacy controls above.

## Install

```sh
pip install opentel-mcp            # needs opentelemetry-api; you bring `mcp` and your own OpenTelemetry SDK
pip install "opentel-mcp[dev]"     # + opentelemetry-sdk, for dev mode with the local dashboard
```

`mcp` is deliberately not a dependency: this library does not choose your SDK version.

## Quickstart

### FastMCP (mcp 1.x) / MCPServer (mcp 2.x)

```python
from mcp.server.fastmcp import FastMCP  # mcp 2.x: from mcp.server.mcpserver import MCPServer
from opentel_mcp import instrument_mcp_server

mcp = FastMCP("demo")  # mcp 2.x: MCPServer("demo")


@mcp.tool()
def lookup(user_id: int) -> str:
    raise RuntimeError(f"user {user_id} not found in the directory")


instrument_mcp_server(mcp)  # one line; returns the same object

if __name__ == "__main__":
    mcp.run()
```

### Low-level `Server`

```python
from mcp.server.lowlevel import Server  # mcp 2.x: from mcp.server import Server
from opentel_mcp import instrument_mcp_server

server = Server("demo")
# mcp 1.x: instrument before or after registering handlers, order does not matter.
# mcp 2.x: register your tools/call handler first (Server("demo", on_call_tool=...)), then instrument.
instrument_mcp_server(server)
```

### Production: your own OpenTelemetry providers

`instrument_mcp_server` uses the **global** tracer and meter providers, like any OpenTelemetry instrumentation.
Configure them once at startup with the standard SDK and the standard OTLP exporter:

```python
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

resource = Resource.create({"service.name": "my-mcp-server"})
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(tracer_provider)
metrics.set_meter_provider(
    MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
)
```

(`pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http`; endpoint and headers come from the usual
`OTEL_EXPORTER_OTLP_*` environment variables.) The JSON exporter described under dev mode is **not** for production.

## Dev mode and the dashboard

For local development, `setup_sdk=True` builds the providers for you and `opentel-mcp-ui` shows what happens:

```sh
npx opentel-mcp-ui          # dashboard on http://localhost:4319 (needs Node)
```

```python
instrument_mcp_server(
    mcp,
    setup_sdk=True,
    service_name="my-mcp-server",  # required with setup_sdk
    exporter_url="http://127.0.0.1:4319/v1/traces",  # send spans to the dashboard
)
```

Dev mode (`pip install "opentel-mcp[dev]"`) registers a tracer and meter provider, prints spans and metrics to
**stderr** (never stdout, which is the JSON-RPC channel of stdio servers), posts spans to `exporter_url` as OTLP/HTTP
JSON, and **flushes on exit**, including on `SIGTERM`/`SIGINT`. Call `opentel_mcp.force_flush()` to flush sooner; it returns within its `timeout_ms` (default 5000) whatever the endpoint does, logging one warning if it could not finish. If
a provider is already registered, dev mode warns and reuses it. The small JSON exporter exists only because the
dashboard accepts OTLP/HTTP JSON and the standard Python exporter sends protobuf; it is private and not a general
purpose exporter.

## Options

```python
instrument_mcp_server(
    server,
    *,
    enabled=True,            # False: no-op
    enable_metrics=True,
    fingerprinting=True,     # mcp.failure.* attributes and the category metric label
    error_recording=None,    # {"mode": "full" | "normalized" | "none", "redactor": callable}
    setup_sdk=False,         # dev mode
    service_name=None,       # required when setup_sdk=True (raises ValueError at startup otherwise)
    exporter_url=None,       # dev mode: OTLP/HTTP JSON endpoint, e.g. opentel-mcp-ui
    flush_on_exit=None,      # dev mode: True | False | {"timeout_ms": 2000}
    sdk_tracing="replace",   # mcp 2.x only: "replace" | "enrich"
)
```

An invalid value falls back to its default with one warning on the `opentel_mcp` logger. A second call on the same
server is a no-op. Nothing here ever raises into your server, except the `service_name` check above.

### `sdk_tracing` on mcp 2.x: `"replace"` or `"enrich"`

mcp 2.x already emits its own `tools/call` span (scope `mcp-python-sdk`). Both modes leave you with **exactly one**
`tools/call` span.

| | `"replace"` (default) | `"enrich"` |
|---|---|---|
| Whose span | ours (scope `opentel-mcp`); the SDK's `tools/call` span is switched off, its spans for `initialize`, `tools/list`, `resources/*`, `prompts/*` are kept | the SDK's span, with our attributes and metrics added |
| Exceptions | recorded by us: **credentials scrubbed**, capped, `error_recording` modes and the redactor apply | recorded by the SDK: **raw**, see below |
| `error.type` on a raised exception | `type(e).__name__` | the SDK's `type(e).__qualname__` (or the JSON-RPC code for an MCP error) |
| Bad params, calls before `initialize` | no span (nothing reached your tool) | the SDK's span, `error.type = "-32602"` |
| Span duration | the tool handler | the whole request (lookup, validation, serialization) |

> **Warning, `"enrich"`:** the SDK records every raised exception on its span with the **full message and stack,
> unscrubbed and uncapped**. `error_recording` modes `normalized` and `none`, secret scrubbing and the length caps
> **cannot apply** to that span (an MCPServer only lets `MCPError` through; a low-level `Server` lets every
> exception through). We warn once at startup if you combine `"enrich"` with a mode or redactor that expects
> otherwise. Prefer the default.

If a future SDK release changes the middleware so it cannot be replaced, `"replace"` falls back to `"enrich"` with
one warning and never throws. If you already removed the SDK's middleware yourself, our own span is used.

## What is recorded

**Span** `tools/call <tool>` (kind SERVER), parented from `params._meta` (W3C trace context):

| Attribute | |
|---|---|
| `mcp.method.name` = `tools/call`, `gen_ai.operation.name` = `execute_tool` | always |
| `gen_ai.tool.name`, `jsonrpc.request.id` (string) | when known |
| `mcp.tool.argument_count` | an integer: how many arguments, never what they were |
| `error.type`, status `ERROR` | `tool_error` for an `isError` result; the exception class name when one is raised |
| `mcp.failure.fingerprint`, `.signature`, `.category`, `.origin`, `.error_class`, `.channel` | on failures |

Status is `OK` on success. A raised exception also gets an `exception` event (see `error_recording`).

**Metrics** (scope `opentel-mcp`): `mcp.tool.calls`, `mcp.tool.errors` (raised), `mcp.tool.silent_failures`
(`isError`), `mcp.tool.duration` (histogram, `ms`, with `mcp.tool.outcome` = `success` / `error` / `silent_failure`).
Labels are limited to an allowlist (tool name, method, outcome, `error.type`, failure category); fingerprints and
free text never become metric labels.

**`error_recording`** (also `OTEL_MCP_ERROR_RECORDING_MODE`):

* `full` (default): `exception.type`, `exception.message` (scrubbed, 4096 chars) and `exception.stacktrace` (scrubbed,
  16384 chars). Ids, paths and URLs are kept.
* `normalized`: only the normalized message (`user <UUID> failed at <PATH>`) and `fn@file:line` frames. An optional
  `redactor` runs first: `redactor({"message": str, "stack": str | None}) -> {"message": str, "stack": str | None}`;
  if it raises or returns the wrong shape, nothing is recorded for that event, with one warning.
* `none`: status only.

A tool that raises inside an mcp 2.x `MCPServer` becomes an `isError` result before any hook sees it; we capture
the original exception, so such crashes fingerprint by their real class and stack (not one fingerprint per tool),
and the span records them through `error_recording`. This is server-side telemetry: the client only sees the SDK's
generic message.

## Privacy

Instrumentation never captures **tool arguments, result content, resource URIs or prompt arguments**. Only the
number of arguments is recorded. For an `isError` result the first text block is normalized and hashed into the
fingerprint, but the text itself is not stored on the span. Credentials in recorded exceptions (URL userinfo, JWTs,
`Bearer`/`Basic` tokens, AWS key ids, provider API keys, `password=`/`token=` style values) are replaced by
`<SECRET>`. The library never writes to stdout, and every hook is wrapped: a failure inside it degrades to one
warning and your server carries on. A test with a canary string enforces all of this.

## Python vs the JavaScript package

The fingerprint algorithm, categories, channel and hash are the same, and an `isError` result gives a
**byte-identical fingerprint** in both languages (enforced by the [shared conformance suite](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/conformance/README.md)).
Differences:

* Thrown-exception fingerprints and signatures never equal the JS ones (a Python traceback is not a V8 stack).
* `str(e)` is not `err.message` (`KeyError('x')` stringifies to `'x'` with quotes), and the SDKs word errors
  differently, so the same logical failure can fingerprint differently across languages.
* An `OSError` raised by the OS (connection refused, timed out, reset, ...) fingerprints from its canonical code
  (`ECONNREFUSED`), not from `str(e)`, so the same failure has the same fingerprint on Linux, macOS and Windows
  (their errno numbers and message wording differ). Windows' `WSAE...` names are mapped to the POSIX/Node ones.
* Python-only exception names (`JSONDecodeError`, `httpx.ConnectTimeout`, `CancelledError`) are not classified by
  name; they fall through to message rules or `internal`. Category rules are shared with JS and are not
  Python-specific.

## v0.1 scope

**In:** the `tools/call` span with the exact core 0.17.0 attributes, silent-failure detection, the thrown path,
fingerprints / categories / channel, the four core metrics, `error_recording` modes with redactor and scrubbing,
trace-context extraction, never-throw, dev mode (stderr exporters, OTLP/JSON to the dashboard, flush on exit),
`sdk_tracing`, MCPServer cause capture.

**Deferred** (in rough order): `mcp.failure.validation_paths` (0.2), unactionable errors (0.3), staleness (0.4),
thrash detection (0.5), schema drift (0.6), resources and prompts coverage (0.7), cost attribution (0.8). The
standalone [`fastmcp`](https://gofastmcp.com) package is not supported yet.

## License

MIT
