# opentel-mcp (Python)

OpenTelemetry instrumentation for MCP servers built on the official Python SDK (`mcp`), with a tool-call span,
failure fingerprints and metrics that match the [JavaScript `opentel-mcp`](https://github.com/Thirumalaiboobathi/opentel-mcp/tree/main/packages/core)
package field for field, so the same dashboard (`opentel-mcp-ui`) works for both.

> **Contract:** shared conformance contract v2 (core 0.18.x). **Python:** 3.10 to 3.14. **MCP SDK:** `mcp>=1.25,<3` (1.x and 2.x), detected at runtime.

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
    sensitive_tools=None,          # ["delete_*", "send_email"]: audit these calls (see Security observability)
    secret_leak_detection=None,    # {"enabled": True, "max_scan_bytes": 65536}
    tool_integrity=None,           # {"enabled": True, "pins": {"tool": "sha256:..."}}
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

## Security observability

New in 0.2.0, matching core 0.18 field for field (names, semantics, caps; options in `snake_case`). These signals help
you **notice** that something looks wrong. They never block a call, change a response or authenticate anyone, and they
run inside the process they observe: anyone who controls the process can silence them. See [Limits](#limits).

| Signal | Option | Records |
|---|---|---|
| Tool definition integrity ("rug pull" detection) | `tool_integrity` (opt-in) | events `mcp.tool.integrity.changed` / `.pin_mismatch` / `.added` / `.removed` on the `tools/list` span; counter `mcp.tool.integrity_violations` |
| Secret leak in tool output | `secret_leak_detection` (opt-in) | span attributes `mcp.tool.secret_leak.detected` / `.types` / `.count` / `.scan_truncated`; counter `mcp.tool.secret_leaks` |
| Sensitive tool auditing | `sensitive_tools` (opt-in) | `mcp.tool.sensitive = true` and one `mcp.audit.sensitive_call` event (outcome, `mcp.tool.duration_ms`, failure category) per call |
| Auth failure counter | always on | counter `mcp.tool.auth_failures` (label: tool name) for failures classified `auth`; needs `fingerprinting=True` (the default) |

The dashboard's **Security** panel (`npx opentel-mcp-ui`) draws all four from the spans, whichever language sent them.

### Try it (about a minute)

Start the dashboard in one terminal (`npx opentel-mcp-ui`, it listens on http://localhost:4319), then run this in another.
It needs `pip install "opentel-mcp[dev]" mcp` and works on mcp 1.x and 2.x. The key-shaped string is assembled at run
time on purpose, so no credential-looking text sits in your source. Dev mode also prints every span and metric to
stderr, so expect a lot of JSON in that terminal.

```python
import anyio

from opentel_mcp import force_flush, instrument_mcp_server

try:  # mcp 2.x
    from mcp import Client
    from mcp.server.mcpserver import MCPServer as FastServer

    def connect(server):
        return Client(server)

except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as FastServer
    from mcp.shared.memory import create_connected_server_and_client_session

    def connect(server):
        return create_connected_server_and_client_session(server._mcp_server)


server = FastServer("security-demo")


@server.tool()
def get_quote(symbol: str) -> str:
    """Latest quote for a symbol."""
    return f"{symbol}: 101.25"


@server.tool()
def read_config() -> str:
    """Returns the deployment config (and, by mistake, a credential)."""
    return "region=eu-west-1 access_key=" + "AKIA" + "IOSFODNN7" + "EXAMPLE"


@server.tool()
def send_email(to: str) -> str:
    """Sends an email."""
    raise RuntimeError("401 Unauthorized")


instrument_mcp_server(
    server,
    setup_sdk=True,
    service_name="security-demo",
    exporter_url="http://127.0.0.1:4319/v1/traces",  # the dashboard
    sensitive_tools=["send_*"],
    secret_leak_detection={"enabled": True},
    tool_integrity={"enabled": True, "pins": {"get_quote": "sha256:" + "0" * 64}},  # a wrong pin, on purpose
)


async def main():
    async with connect(server) as client:
        await client.list_tools()  # integrity: get_quote does not match its pin
        await client.call_tool("get_quote", {"symbol": "ACME"})
        await client.call_tool("read_config", {})  # a credential-shaped string in the output
        for _ in range(5):  # five auth failures in a row: the panel's burst highlight
            await client.call_tool("send_email", {"to": "ops@example.com"})
    force_flush()


anyio.run(main)
```

The Security panel then shows a high-severity pin mismatch for `get_quote` (hash prefixes only), one secret-leak
signal for `read_config` (`aws_access_key_id`, a count; never the text), five auth failures for `send_email` with the
burst highlight, and the five sensitive calls with their outcome (`silent_failure` here, as the SDK turns the
exception into an error result).

### Tool definition integrity and pinning

```python
instrument_mcp_server(server, tool_integrity={"enabled": True})
```

Every `tools/list` response is hashed per tool: `"sha256:" + 64 hex` over the canonical JSON of the tool's `name`,
`title`, `description`, `inputSchema`, `outputSchema` and `annotations` (those present). The hash is **byte-identical**
with the JavaScript package for the same definition (keys sorted by UTF-16 code unit, ECMAScript number formatting,
`JSON.stringify` escaping; enforced by 93 shared test vectors), so one pin works for a server in either language.
`_meta`, `icons` and vendor keys are not covered.

* The **first** hash seen for a tool is trusted. If it later differs, `mcp.tool.integrity.changed` fires once per
  distinct new hash (edge-triggered: a persistent change does not flood).
* **Pin** the hashes you reviewed and `mcp.tool.integrity.pin_mismatch` (`severity = "high"`) fires when the server
  serves anything else, including on the very first listing:

  ```python
  instrument_mcp_server(
      server,
      tool_integrity={
          "enabled": True,
          "pins": {"get_quote": "sha256:5c95b6691da4153e7d523b1ba96336dc56bb500ec5a77e53021815906fb3873e"},
      },
  )
  ```
* `added` / `removed` are reported only on **complete** listings (a request with a `cursor`, or a result with
  `nextCursor`, is a page; the hashes of its tools are still checked).
* One `mcp.tool.integrity_violations` increment per tool per `tools/list` that newly reports a change and/or a pin
  mismatch (never for added/removed).

Getting the hashes to pin:

```python
from opentel_mcp import compute_tool_definition_hash

compute_tool_definition_hash(
    {"name": "get_quote", "description": "Latest quote", "inputSchema": {"type": "object"}}
)
# 'sha256:...'  (also accepts an mcp Tool model; returns None for something that is not a hashable definition)

server.get_tool_integrity_hashes()  # {"get_quote": "sha256:..."} from the last tools/list the server answered
```

In dev mode (`setup_sdk=True`) the current hashes are also printed once, after the first complete listing, as a
copy-pasteable `tool_integrity={...}` snippet on **stderr** (never stdout).

Which span holds the events: on mcp 2.x the SDK's own `tools/list` span. mcp 1.x has no spans at all, so when
`tool_integrity` is on, opentel-mcp starts a minimal `tools/list` span (`mcp.method.name`, `jsonrpc.request.id`,
status) to hold them; the same happens on 2.x if you removed the SDK's tracing middleware. With the option off nothing
is wrapped and no extra span exists.

### Secret leak detection in tool output

```python
instrument_mcp_server(server, secret_leak_detection={"enabled": True, "max_scan_bytes": 65536})
```

The `text` content items of successful **and** `isError` results are checked, in process, with the same detectors that
scrub error text. The span gets `mcp.tool.secret_leak.detected = true`, `.types` (a sorted subset of
`url_credentials`, `jwt`, `http_auth_credential`, `aws_access_key_id`, `provider_api_key`, `secret_assignment`),
`.count` (matches summed over detectors, capped at 1000: a magnitude, not a distinct-secret count) and, when the
budget ran out, `.scan_truncated = true`; the counter `mcp.tool.secret_leaks` goes up by one per call. **A leak never
changes the span status**: it is a signal, not an error.

`max_scan_bytes` (default 65536) is a budget in **UTF-16 code units**, the unit JavaScript counts in, not bytes and
not Python characters (an emoji spends two). That is what makes a result get cut at the same place in both languages.
Text is scanned in 4096-unit windows overlapping by 256, in order, until the budget is spent; the item that crosses it
is cut, and the rest is skipped. Not scanned: images, embedded resources, `structuredContent`, `_meta`, and a secret
split across two items.

### Sensitive tool auditing

```python
instrument_mcp_server(server, sensitive_tools=["delete_record", "deploy_*"])
```

Exact names plus `*` (any run of characters, including none). Everything else is literal: no regular expressions, no
`?`, case-sensitive. Entries are compiled once and matched in linear time, so a hostile pattern or tool name cannot
cause catastrophic backtracking. Invalid entries (not a string, empty, over 256 characters; over 1000 entries) warn
once and are skipped. A matching call gets `mcp.tool.sensitive = true` when the span starts and one
`mcp.audit.sensitive_call` event when it ends, on every path, with `gen_ai.tool.name`, `mcp.tool.outcome`
(`success` / `silent_failure` / `error`), `mcp.tool.duration_ms` and, on failure when fingerprinting is on,
`mcp.failure.category`. A tail-sampling rule that keeps traces with `mcp.tool.sensitive = true` is the way to keep
these from being sampled out.

### Auth failure counter

Nothing to configure. `mcp.tool.auth_failures` (label `gen_ai.tool.name` only) goes up once per failed call, silent or
raised, whose failure category is `auth` (HTTP 401/403, names like `UnauthorizedError`, `EACCES`/`EPERM`, messages such
as "access denied" or "insufficient permissions"). It inherits the classifier's reach and false positives (a local file
permission error counts), stays at zero with `fingerprinting=False`, and obeys `enable_metrics`. Alert on its rate in
your backend; the dashboard highlights five or more for one tool within 60 seconds.

### What is, and is not, recorded

Only **derived** signals: booleans, counts, closed-set type names, tool names and SHA-256 hashes. Never:

* tool arguments, argument names or values;
* tool result content, or any text that matched a secret detector, its position or its surroundings;
* description, title, schema or annotation text (only their hash);
* matched secret text in logs or `warnings`: warnings name the option and never echo a value.

No new metric label keys: the three new counters are labelled by tool name only, which is already on the allowlist
(secret *types* are span-only). Everything is wrapped so a failure inside it costs at most one warning and your server
carries on; the original result or exception always reaches the client untouched. Tests assert all of this with
canary strings across both SDK lines.

### Limits

* **Detection, not prevention.** Nothing is blocked, redacted or reverted; the changed definition has already been
  served, and the leaked credential has already left.
* **Pattern-based secret detection.** It misses formats (no entropy analysis, no cloud-specific keys beyond the
  documented list, secrets split across items or cut by `max_scan_bytes`) and fires on look-alikes (a documentation
  `password=...`, a test AKIA-shaped value). Read a detection as "this output *looked like* a credential", never a
  missing detection as "no secret was returned".
* **The first definition seen is trusted** unless you pin it. A pinned tool that never appears produces no event.
* **Span events are telemetry, not a tamper-evident audit log.** Sampled-out or undelivered spans are lost; whoever
  controls the process controls its telemetry.
* **Auth is whatever the classifier matched**, not "credential attacks".
* **Clock skew is not in Python yet.** The `mcp.tool.freshness.clock_skew_ms` attribute and
  `staleness.clockSkewToleranceMs` need staleness detection, which is deferred (see below).
* `tools/list` handlers registered *after* `instrument_mcp_server()` are not observed on mcp 2.x (as for `tools/call`).

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

## Scope

**In (0.1):** the `tools/call` span with the exact core attributes, silent-failure detection, the thrown path,
fingerprints / categories / channel, the four core metrics, `error_recording` modes with redactor and scrubbing,
trace-context extraction, never-throw, dev mode (stderr exporters, OTLP/JSON to the dashboard, flush on exit),
`sdk_tracing`, MCPServer cause capture.

**In (0.2):** the v0.18 security observability signals above: tool definition integrity with pinning, secret leak
detection in tool output, the auth failure counter and sensitive tool auditing, with shared conformance fixtures
generated from the JS implementation.

**Deferred** (in rough order): staleness detection and its clock-skew attribute, thrash detection, schema drift, cost
attribution, resources and prompts coverage, unactionable errors, `mcp.failure.validation_paths`. The
standalone [`fastmcp`](https://gofastmcp.com) package is not supported yet.

## Security and privacy

Designed to record only derived signals (counts, lengths, hashes), never tool arguments or result content, and to send
nothing to the maintainer. Thrown-error text is credential-scrubbed by default and can be reduced further with `error_recording`.
See the [security documentation](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/docs/security/README.md) (threat model, data handling, release verification) and
the [security policy](https://github.com/Thirumalaiboobathi/opentel-mcp/blob/main/SECURITY.md) for how to report a vulnerability.

## License

MIT
