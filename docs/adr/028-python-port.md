# ADR 028: Python port (opentel-mcp for Python, v0.1.0)

**Status:** Accepted (2026-10-25)

## Maintainer decisions (2026-10-25)

Two rounds. In round 2, decision A supersedes round 1's decision 2. The
other round-1 decisions still stand.

### Round 1

1. **mcp range: both 1.x and 2.x, minimum `mcp>=1.25`.** On 1.x nothing
   else detects isError, so that is where our core value is unique. CI
   matrix: the oldest supported 1.x, the latest 1.x and the latest 2.x.
2. *(Superseded by round-2 decision A.)* **Do not replace the SDK's 2.x
   tracing middleware.** When it is active,
   *enrich* its existing `tools/call` span with our attributes (fingerprint,
   category, channel, error recording with scrubbing) and record our
   metrics, so there is exactly one span. Create our own span only on 1.x
   or when the SDK middleware is disabled. **Conditional on verification**
   that the SDK span's name, kind, `gen_ai.tool.name`, `mcp.method.name`
   and `error.type=tool_error` match our contract, and that its span is the
   current span inside the handler.
3. **Ship a small OTLP/HTTP JSON trace exporter inside the package, used
   only by dev mode (`setup_sdk=True`) to talk to opentel-mcp-ui.** It is
   not a general-purpose exporter. Production users keep the standard
   protobuf exporter. Trace and span ids are encoded as hex, not base64, and
   a test covers that. Protobuf ingestion in the UI is a separate, later UI
   release (see Follow-ups).

### Round 2 (answers to the open questions)

A. **New option `sdk_tracing: Literal["replace", "enrich"]`, default
   `"replace"`.** Round 1's verification found thrown-path differences in
   the SDK span, so the maintainer made the choice explicit.
   - `"replace"`: take the SDK's `tools/call` span away and create our own,
     so the full contract holds. That means scrubbing, error-recording
     modes, length caps, our `error.type` values, no span for bad params or
     pre-initialize requests, and our duration semantics. We log one
     info-level line saying the SDK middleware was replaced and how to opt
     out. If the SDK changes so that the middleware can't be found or
     removed, we fall back to `"enrich"` with one warning and never throw.
   - `"enrich"`: keep the SDK span and add our attributes and metrics. The
     docs state clearly that the SDK then records exceptions raw (no
     scrubbing or modes on that path), and list the `error.type`
     differences.
   - Both modes produce exactly one `tools/call` span, and the e2e test
     covers both.
   - Follow-up: open an upstream issue asking python-sdk for an option to
     disable its exception recording, and revisit the default if it lands.
B. **MCPServer 2.x `UnexpectedToolError` cause:** check whether the original
   exception is chained. If it is, fingerprint and classify the original;
   if not, document that these failures group together. **Checked: it is
   chained** (see Decision 3, "Cause capture").
C. **Python 3.10–3.14.** The CI matrix shrinks to about 10 jobs (Decision
   7).
D. **Standalone `fastmcp` (Prefect) is out of scope for v0.1** (Follow-ups).
E. **Manual publishing with twine** (build → `twine check` → TestPyPI →
   PyPI), using a project-scoped API token, with the steps in
   `CONTRIBUTING.md` (Decision 9).
F. **No Python-only classifier rules**, because the category is part of the
   fingerprint. A rule may be added only if the same rule exists in JS, and
   both must be covered by the shared conformance suite. Proposed shared
   additions are listed as a follow-up and are not added now.

## Verification of the mcp 2.x enrichment approach

The sources checked were `mcp-2.3.0`: `server/_otel.py`,
`shared/_otel.py`, `server/runner.py`, `server/lowlevel/server.py` and
`server/mcpserver/server.py`. Also checked: `anyio-4.15.1`
`_backends/_asyncio.py`.

**These hold:**

| Check | SDK behaviour | Our contract | Result |
|---|---|---|---|
| Span name | `f"{ctx.method}{f' {target}' if target else ''}"`, which gives `tools/call <tool>`, or `tools/call` when the name is missing or empty (`_otel.py:35-36`) | `instrument.js:2022` | ✅ same |
| Span kind | `SpanKind.SERVER` (`_otel.py:37`) | `instrument.js:2031` | ✅ same |
| `mcp.method.name` | `ctx.method`, which is `"tools/call"` (`_otel.py:22`) | `attributes.js:74` | ✅ same |
| `gen_ai.operation.name` | `"execute_tool"` on `tools/call` (`_otel.py:29`) | `attributes.js:71` | ✅ same |
| `gen_ai.tool.name` | the tool name when it is a `str` (`_otel.py:30-31`) | the tool name | ✅ same (both come from the validated `params.name`) |
| `jsonrpc.request.id` | `str(ctx.request_id)` when present (`_otel.py:25-26`) | `String(requestId)` | ✅ same |
| isError detection | `CallToolResult(is_error=True) \| {"isError": True}`, literal `True` only (`_otel.py:67`) | `result?.isError === true` (`instrument.js:1085`) | ✅ same strictness |
| isError attributes and status | `error.type="tool_error"`, `set_status(ERROR)` with no description (`_otel.py:68-69`) | `instrument.js:2077-2078` | ✅ same |
| Success status | the SDK never sets OK; the span stays UNSET | JS sets OK (`instrument.js:2152`) | ⚠️ the UI treats UNSET and OK alike (`summary.js:38-39` only checks `tool_error`/`ERROR`), and enrichment can set OK |
| Current span inside the handler | `start_as_current_span` (`shared/_otel.py:28`). The SDK middleware is the outermost entry (`lowlevel/server.py:451`), and `MCPServer` appends after it (`mcpserver/server.py:245-248`). `_inner` awaits the handler inline in the same task (`runner.py:217`). Sync `MCPServer` tools run in `anyio.to_thread.run_sync`, which executes them inside a `copy_context()` (`anyio _asyncio.py:2698,1100`). | — | ✅ the SDK span is `get_current_span()` in a middleware appended after it, in async handlers, and in sync tools |
| Result shape seen by an inner middleware | the wire dict: `_inner` returns `self._serialize(...)` (`runner.py:217-223`), so the key is camelCase `isError` | the wire shape | ✅ |
| Missing attribute | the SDK does not set `mcp.tool.argument_count` | `attributes.js:113` | ➕ we add it (`len(ctx.params["arguments"])`) |
| Extra attributes | `mcp.protocol.version` always; `rpc.response.status_code` on MCP or params errors | — | ➕ additive; the UI ignores them |

**These do not hold. All of them are on the thrown or protocol-error
path:**

1. **`error.type` on thrown exceptions.** The SDK sets
   `type(e).__qualname__` (`_otel.py:57`); our contract mirrors JS
   `err.name`, which is `type(e).__name__`. They differ for nested or local
   classes (`Outer.Err`, `make.<locals>.Err`). The SDK writes **after**
   `call_next` returns or raises, so its value overwrites anything an inner
   middleware set. The span would then disagree with our
   `mcp.tool.errors{error.type}` metric label and with
   `mcp.failure.error_class`.
2. **`error.type` on `MCPError`.** The SDK sets the JSON-RPC code as a
   string, e.g. `"-32602"`, and also `rpc.response.status_code`
   (`_otel.py:45-49`). The JS contract uses the error name (`McpError`).
3. **Params `ValidationError` and the not-initialized gate.** The SDK span
   gets `error.type="-32602"` and status ERROR (`_otel.py:50-55`,
   `runner.py:211-216`). JS wraps the innermost handler (ADR 001), so these
   protocol-level rejections **produce no span at all** in JS. With
   enrichment, they appear in the UI as errors and Python reports more
   errors than JS would. The UI counts `status ERROR` as an error
   (`summary.js:39`).
4. **Raw, unscrubbed exception recording: a privacy conflict.** For every
   non-MCP exception the SDK unconditionally calls
   `span.record_exception(e)` and `set_status(ERROR, str(e))`
   (`_otel.py:56-59`). That records the full message and stack trace, raw
   and uncapped. For `MCPError` it sets the raw `e.error.message` as the
   status description (`_otel.py:49`). An enriching middleware runs inside
   the SDK's span and **cannot remove an event or prevent a later status
   write**. So `error_recording` modes `normalized` and `none`, secret
   scrubbing and the 4096/16384 caps (ADR 019/020, core 0.17) **cannot be
   honoured on the thrown path while the SDK middleware is active**. This
   is the significant finding. Where it applies:
   - `MCPServer` converts all non-`MCPError` exceptions into isError
     results first (`mcpserver/server.py:443-456`), so for `MCPServer`
     only `MCPError` reaches the SDK's except branches. The exposure there
     is the raw `MCPError` message in the status description.
   - The low-level `Server` lets every exception propagate
     (`runner.py:218-220`), so the full raw recording applies to **every
     exception** a low-level 2.x `on_call_tool` handler raises.
5. **Span duration scope.** The SDK span also covers lookup, params
   validation and wire serialization (`runner.py:185-223`); the JS span
   covers only the handler. Our duration *metric* is still measured around
   the handler by our own middleware, so the metric matches JS and only the
   span duration differs. Minor; recorded for completeness.
6. **Instrumentation scope.** SDK spans carry scope `mcp-python-sdk`
   (`shared/_otel.py:14`), not `opentel-mcp`. The UI does not read scope
   (`otlp-json-receiver.js:88-89` iterates `scopeSpans` without
   inspecting the scope). Backends that filter by scope would need to know
   both names. Minor.

**The success and isError paths, the silent-failure core of v0.1, meet
every condition.** Points 1 to 4 mean the thrown path does not, and point 4
is a privacy conflict, not just a naming difference. **Resolution:** round-2
decision A. `sdk_tracing="replace"`, the default, avoids points 1 to 5.
`sdk_tracing="enrich"` accepts them, and they are documented.

**Goal:** a Python package that instruments MCP servers built on the
official `mcp` SDK, both the low-level `Server` and the high-level server
(`FastMCP` in mcp 1.x, renamed `MCPServer` in mcp 2.x). It must emit exactly
the span attribute names, values and metric names that core 0.17.0 emits, so
that `opentel-mcp-ui` 0.3.0 works with Python servers unchanged.

This ADR covers design only. No implementation code lands with it.

## Step 0 findings

JS line numbers are as of core 0.17.0 (`cd02f87`). Python SDK line numbers
are from the PyPI wheels `mcp-2.3.0` and `mcp-1.30.0`. The sources are in
[modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
under `src/mcp/…` at the matching `v2.3.0` / `v1.30.0` tags.

### 1. PyPI name

`https://pypi.org/pypi/opentel-mcp/json` returns **404**, and so do
`opentel_mcp` and `opentelmcp`. PyPI normalizes `-`, `_` and `.` to the same
project, so a single registration covers all three spellings. **`opentel-mcp`
(import name `opentel_mcp`) is available.** It should be reserved early,
because PyPI may reject a name once a confusingly similar project exists.
Fallbacks, in order of preference, if it gets taken: `opentel-mcp-python`,
`opentelmcp-py`.

### 2. Python MCP SDK: how `tools/call` is dispatched

**Versions and cadence.** `mcp` is at **2.3.0** (2026-10-02). 2.0.0 shipped
on 2026-07-28 after six weeks of alpha, beta and RC releases. Since then
there have been five 2.x releases in about two months: 2.0.1, 2.1.0, 2.1.1,
2.2.0 and 2.3.0. The **1.x line is still maintained in parallel**: 1.30.0
shipped on 2026-09-07. Both lines require Python >= 3.10.

**mcp 2.x: the SDK already traces requests.** `Server.__init__` installs a
context-tier middleware chain that is **on by default**:
`self.middleware = [OpenTelemetryMiddleware()]`
(`server/lowlevel/server.py:451`). `MCPServer` exposes the same list
(`server/mcpserver/server.py:279-287`) and appends its own middleware after
the SDK's (`:245-248`). `OpenTelemetryMiddleware`
(`server/_otel.py:14-72`, tracer name `mcp-python-sdk`, `shared/_otel.py:14`)
emits one SERVER span per inbound message. It names the span
`tools/call <name>` and sets `mcp.method.name`, `mcp.protocol.version`,
`jsonrpc.request.id`, `gen_ai.operation.name=execute_tool` and
`gen_ai.tool.name`. **It already detects isError:** on
`CallToolResult(is_error=True) | {"isError": True}` it sets
`error.type=tool_error` and status ERROR (`_otel.py:67-69`). On exceptions it
sets `error.type` to `type(e).__qualname__`, or to the JSON-RPC code as a
string for `MCPError` (`:44-59`). It records no fingerprint, category,
channel or metrics. The middleware API is marked provisional:
`TODO(L54): provisional - signature and semantics may change in a 2.x minor
release` (`lowlevel/server.py:448-450`).

Middleware signature: `async __call__(ctx: ServerRequestContext, call_next)`
(`server/context.py:136,146`). `ctx` carries `method`, `params` (the raw wire
`Mapping`), `request_id`, `meta` and `protocol_version`
(`context.py:31-47`). The result is the wire dict or a pydantic model; the
SDK matches both shapes.

Handlers are registered as `Server(on_call_tool=…)`, which populates
`_request_handlers["tools/call"]` (`lowlevel/server.py:470-474`), or through
`add_request_handler` (`:484-507`).

How errors surface in 2.x:

- **`MCPServer`** (`mcpserver/server.py:437-456`): every non-`MCPError`
  exception raised by a tool becomes
  `CallToolResult(content=[TextContent(text=str(exc))], is_error=True)`.
  Expected failures are `ToolError(f"Error executing tool {name}: {exc}")`.
  Unexpected ones are `UnexpectedToolError(f"Error executing tool {name}")`,
  with **no detail**, because the SDK deliberately sanitizes them
  (`mcpserver/tools/base.py:141-213`). An unknown tool raises
  `ToolError("Unknown tool: …")` (`tools/tool_manager.py:72,85`). `MCPError`
  propagates as a JSON-RPC error.
- **Low-level `Server`**: exceptions propagate through the middleware chain
  (`runner.py:219`: "Raise inside the chain so middleware observes the
  failure") and become JSON-RPC error responses.
- **Sync tools**: `MCPServer` runs sync tool functions with
  `anyio.to_thread.run_sync` (`mcpserver/resolve.py:556`). The middleware
  tier is always async, so wrapping there never touches the user function and
  sync and async tools need no separate handling.

**mcp 1.x: no built-in OTel.** No module in mcp 1.30.0 imports
`opentelemetry`. Handlers are stored in a dict keyed by request type. The
`@server.call_tool()` decorator stores its wrapper at
`request_handlers[types.CallToolRequest]` (`lowlevel/server.py:498-592`).
That wrapper already converts errors into isError results:

- `"Input validation error: …"` (`:538`)
- `"Output validation error: …"` (`:568-575`)
- `"Unexpected return type…"` (`:563`)
- any other exception becomes `_make_error_result(str(e))` (`:590`)

`UrlElicitationRequiredError` is the only error that propagates. FastMCP 1.x
raises `ToolError(f"Error executing tool {name}: {e}")`
(`fastmcp/tools/base.py:117`), which the low-level wrapper then turns into
an isError result. The request id is available through the `request_ctx`
contextvar (`lowlevel/server.py:109,240-244`). The tool function itself is
dispatched with `inspect.iscoroutinefunction` checks
(`fastmcp/tools/base.py:124`); our wrapper sits one level above that, on the
async request handler.

**Consequence.** In both SDK majors, nearly every tool failure reaches the
wire as `isError: true`. That is the same situation as JS `McpServer`, which
is why JS core wraps at the low-level handler (ADR 001) and treats
`isError` as the main failure path.

### 3. Existing Python MCP OTel instrumentation (the differentiator)

| Package | What it does | Detects isError-in-success? |
|---|---|---|
| **`mcp` 2.x built-in** `OpenTelemetryMiddleware` | One span per request, with spec attributes (see above) | **Yes, at the span level** (`error.type=tool_error`, `_otel.py:67-69`). No fingerprint, category, channel or metrics. |
| [`opentelemetry-instrumentation-mcp`](https://github.com/traceloop/openllmetry/tree/main/packages/opentelemetry-instrumentation-mcp) 0.62.4 (Traceloop) | Wraps the standalone `fastmcp` package's `ToolManager.call_tool` (`fastmcp_instrumentation.py:24-38`) and client transports. Uses Traceloop-specific attributes (`traceloop.entity.*`). By default it **captures tool input and output** (`TRACELOOP_ENTITY_INPUT/OUTPUT`). | **No.** The span is set to OK whenever the call does not raise (`fastmcp_instrumentation.py:149-150`). No `isError` reference exists anywhere in the package. |
| [`openinference-instrumentation-mcp`](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-mcp) 2.0.13 (Arize) | Propagates W3C context through `_meta` only (`__init__.py:167,205`). Creates no tool spans. | **No.** |
| Standalone [`fastmcp`](https://gofastmcp.com/servers/telemetry) (Prefect, a separate package) | Native OTel spans `tools/call {name}`, with `error.type=tool_error` when a `ToolError` is raised | The docs do not say whether a returned isError result is detected. No fingerprint or metrics. |

**What this means for us.** A plain "a red span when isError is set" is
**no longer a differentiator on Python**: mcp 2.x already does it, and a
naive port would duplicate it. What still sets us apart:

1. Failure **fingerprints**, **categories** and **channels**, so you can see
   which silent failure this is and whether it is a protocol error disguised
   as a tool error.
2. **Metrics**, including `mcp.tool.silent_failures`. Nothing on PyPI emits
   these.
3. **Privacy-safe error recording**: credential scrubbing and the three
   modes.
4. The **zero-infrastructure dashboard**.
5. **Cross-language parity**: the same failure text gives the same
   fingerprint whether the server is written in JS or Python.

The integration must also **coexist with the SDK's own middleware without
producing two `tools/call` spans** (Decision 3).

### 4. The JS contract that v0.1 touches

**Span**, set in `wrapToolCallHandler` (`instrument.js:1998-2229`):

- Name: `tools/call <tool>`, or `tools/call` when the tool name is missing
  (`:2022`). Kind SERVER. The parent context comes from `params._meta`
  (`:2023`, ADR 017).
- Always set: `mcp.method.name=tools/call`,
  `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`,
  `mcp.tool.argument_count` (an int: the count of argument keys only,
  `:2026`). Also `jsonrpc.request.id` as a string when one is present
  (`:2038-2045`). The constants are in `attributes.js:16,27,30,44,71,74,113`.
- **isError path** (`:2077-2154`): `error.type=tool_error`
  (`attributes.js:68`). Status ERROR with **no message**. When
  fingerprinting is on, `toSpanAttributes()` adds `mcp.failure.fingerprint`,
  `mcp.failure.signature`, `mcp.failure.category`, `mcp.failure.origin`
  (`tool_error`) and `mcp.failure.error_class` (`MCPToolError`)
  (`fingerprint/attributes.js:19-33,97-109`). It also adds
  `mcp.failure.channel` (`:44`, `classify/channel.js:278`) and
  `mcp.failure.validation_paths` when parseable (`:45-60`).
- **Thrown path** (`:2163-2225`): `recordThrownException()` (`:1816`) sets
  the exception event and status according to the error-recording mode.
  `error.type` is `String(err.name ?? 'Error').slice(0, 128)`, and the same
  `mcp.failure.*` attributes are added with `origin=thrown`. The error is
  re-thrown unchanged.
- **Success path**: status OK.
- `finally`: `span.end()`.

**Metrics** (`metrics.js:83-178`; meter and tracer scope are both named
`opentel-mcp`, `metrics.js:84`, `instrument.js:1070`):

| Instrument | Type, unit | Labels (`metrics.js` line) | Recorded when |
|---|---|---|---|
| `mcp.tool.calls` | Counter | `gen_ai.tool.name`, `mcp.method.name` (`:137-142`) | every call, before the handler runs |
| `mcp.tool.errors` | Counter | `gen_ai.tool.name`, `error.type`, `mcp.failure.category`? (`:143-149`) | thrown path only |
| `mcp.tool.silent_failures` | Counter | `gen_ai.tool.name`, `mcp.failure.category`? (`:150-155`) | isError path only |
| `mcp.tool.duration` | Histogram, `ms` | `gen_ai.tool.name`, `mcp.tool.outcome` (`success`/`error`/`silent_failure`, `attributes.js:129-138`), `mcp.failure.category`? (`:156-162`) | all paths |

A label marked `?` is omitted when the value is falsy, for example when
fingerprinting is off. The descriptions are the strings at `:86-99`. No
explicit histogram boundaries are set, so the SDK default buckets apply. The
OTel spec fixes the same defaults for both language SDKs.

**Allowlists:**

- `METRIC_SAFE_ATTRIBUTES` in `attributes.js:302-308`: `gen_ai.tool.name`,
  `mcp.method.name`, `mcp.tool.outcome`, `error.type`, `mcp.tool.model`.
- Fingerprint `METRIC_SAFE_ATTRIBUTES` in `fingerprint/attributes.js:87`:
  `mcp.failure.category`, `mcp.failure.origin`.
- `COST_METRIC_SAFE_ATTRIBUTES` in `attributes.js:234` (v0.1 does not
  touch it).

The JS cross-check test is
`metric-label allowlist cross-check (ADR 021)` in `test/metrics.test.js:262`.

**Invariants:**

- Never throw into the host. Every helper catches internally; see
  `computeFingerprint`'s fallback (`compose.js:54-81`) and
  `recordThrownException`'s nested catch (`instrument.js:1886-1891`).
- Never capture tool argument values, result content, resource URIs or
  prompt arguments.
- No new metric labels.

**Error recording** (`error-recording/config.js:37-41`). Default `full`;
also configurable through the env var `OTEL_MCP_ERROR_RECORDING_MODE`.

- `full`: `exception.type` (code, else name, capped at 128),
  `exception.message` (scrubbed and capped at 4096) and
  `exception.stacktrace` (scrubbed and capped at 16384). The truncation
  marker is `' …[truncated by opentel-mcp]'`, and scrubbing runs on at most
  2× the cap (`instrument.js:1692-1735`).
- `normalized`: `exception.message` comes from `normalizeMessage()`, and the
  stack becomes `fn@file:line` lines from the parsed frames. An optional
  `redactor({message, stack})` runs first. If it returns `null` or fails,
  the behaviour degrades to `none`, with a single warning
  (`instrument.js:1823-1869`, `redactor.js:81`, output capped at 2048,
  `:30`).
- `none`: status ERROR only.
- A redactor configured with any mode other than `normalized` is accepted
  and ignored, with a single warning (ADR 020 Decision 6).

**Secret scrubbing** is `SECRET_STEPS` (`normalize/secrets.js:28-85`). It
covers eight patterns: URL userinfo, JWT, Bearer/Basic, AWS key ids,
provider-prefixed keys, and three secret-named-key forms. It runs before
normalization in both the fingerprint pipeline and full mode.

### 5. Fingerprint parity

The JS computation (`fingerprint/compose.js:83-134`):

1. **Coerce** (`normalize/exception.js:50-100`). An isError result becomes
   `{name:'MCPToolError', message: content[0]?.text ?? ''}` with no stack,
   code or status. An `Error` becomes
   `{name, message, stack, code, status ?? statusCode}`.
2. **Normalize the message** (`normalize/message.js:31-37`):
   `raw.slice(0, 2048)`, then `scrubSecrets`, then the 13 `NORMALIZE_STEPS`
   in order (`patterns.js:21-107`: UUID, email, URL, IPv6, IPv4, ISO
   timestamp, epoch 10 or 13 digits, path, hex of 8 or more characters,
   port 1024-65535, number of 3 or more digits, quoted mixed id,
   whitespace collapse), then `.trim()`.
3. **Stack signature** (`normalize/stack.js:136-164`): parse V8 `at` lines,
   drop native frames, keep at most 5 user frames (falling back to
   `node_modules` frames), and join `fn@file:line` with `|`.
4. **Classify** with the raw coerced error (`classify/index.js:27-59`): the
   first match wins among validation, timeout, network, auth, dependency,
   serialization and internal. If the result is `internal` and the top
   frame is under `node_modules/`, it becomes `dependency`
   (`compose.js:104`).
5. **Hash**: `v1|errorClass|category|origin|toolName|normalizedMessage|stackSignature`,
   where errorClass is capped at 128. SHA-256 over UTF-8, hex, first 16
   characters (`compose.js:118-120`, `hash.js:38`). The signature is
   `errorClass@fn:line`, capped at 60. Any internal failure produces the
   fallback `0000000000000000` / `unfingerprintable`.

**Answer: mostly identical.**

- **isError fingerprints are byte-identical.** They have no stack, so the
  hash input is purely message-based. Silent failures are the main signal,
  so this is the case that matters.
- **Thrown fingerprints differ.** They depend on a stack signature that
  cannot match, because a Python traceback is not a V8 stack.

**Evidence.** A throwaway scratchpad prototype (not committed) ported
`SECRET_STEPS`, `NORMALIZE_STEPS`, the message classifiers and the hash
using the translation rules below. I ran it against core's real
`computeFingerprint` on 19 adversarial isError inputs. **19 of 19 matched**
on normalized message, category and fingerprint, including a surrogate pair
split at the 2048 cap. The same prototype using Python's defaults instead
of the rules **diverged on 5 of 19**:

- `café1700000000`: Unicode `\w` drops the `\b`.
- Arabic-Indic digits: Unicode `\d` turns them into `<NUM>`.
- `network …error`: Python's `.` crosses U+2028, which flips the
  category to network.
- A leading `\x1c`: `str.strip()` removes it, JS `trim()` does not.
- A trailing BOM: JS `trim()` removes it, `str.strip()` does not.

**Translation rules.** These are required, and each one gets a conformance
case:

| JS semantics | Python equivalent |
|---|---|
| `\d \w \b` are ASCII (no `u` flag) | compile every pattern with `re.ASCII` |
| `\s` is Unicode whitespace plus line terminators (`[\t\n\v\f\r    -     　﻿]`) | replace `\s` and `[^\s…]` with that explicit class, because `re.ASCII` would shrink `\s` to 6 characters |
| `.` excludes `\n \r    ` | write `[^\n\r  ]` (used in network `MESSAGE_RE`) |
| `$` matches only at the end of input (no `m` flag) | `\Z` (Python's `$` also matches before a trailing `\n`) |
| `i` flag without `u`: ASCII-safe case folding (ES `Canonicalize` never maps non-ASCII to ASCII) | `re.IGNORECASE \| re.ASCII` (without `ASCII`, `K` U+212A would match `k`) |
| `$1` in a replacement; an unmatched group gives `''` | `\g<1>` (an unmatched group also gives `''` on Python 3.5+) |
| `.slice(0, n)` counts UTF-16 code units | slice the UTF-16LE encoding at `2n` bytes and decode with `surrogatepass` (this can leave a lone high surrogate, exactly as JS does) |
| `.trim()` uses the same whitespace set as `\s` | `str.strip(JS_WHITESPACE)`, never bare `strip()` |
| `hash.update(s, 'utf8')` turns lone surrogates into U+FFFD | replace lone surrogates with `�`, then `.encode('utf-8')` |
| `content[0]?.text ?? ''`; a non-string `text` makes `raw.slice` throw, which produces the fallback | identical: a non-`str` `text` gives the fallback fingerprint |
| `toolName ?? ''` | `tool_name or ''` only for `None` (an empty string stays empty) |

Both engines are backtracking, leftmost-first and greedy, with ordered
alternation, so match selection agrees once the character classes agree. A
**regex-source parity test** loads `packages/core/src/fingerprint/normalize/*.js`
patterns from the shared spec (Decision 6) so the Python tables cannot
silently drift.

**Python stack signature (thrown path only).** The output format is the
same as JS; the input parsing is Python-specific:

- Frames come from `traceback.extract_tb(exc.__traceback__)`, **reversed to
  innermost-first** to match V8 order.
- `fn` is `FrameSummary.name` (`co_name`; deliberately not `co_qualname`,
  which only exists on 3.11+). That keeps fingerprints stable across the
  3.10-3.14 matrix.
- `file` uses `/` separators. Paths under `site-packages/` or
  `dist-packages/` become `site-packages/<pkg>/<rest>`, the analog of
  `node_modules/<pkg>/…`. Other paths are made relative to cwd.
- "Native" frames are skipped: stdlib frames under
  `sysconfig.get_paths()['stdlib']` but outside site-packages, `<frozen …>`,
  `<string>`, and `opentel_mcp`'s own frames. Skipping stdlib frames keeps
  fingerprints stable across Python patch releases.
- The output is the same as JS: at most 5 user frames, falling back to
  site-packages frames, as `fn@file:line` joined with `|`. The
  `internal` → `dependency` rule uses `site-packages/` in place of
  `node_modules/`.

**Coercing a Python exception** to the JS record shape:

- `name` is `type(e).__name__`, the analog of `err.name`; it is not
  `__qualname__`.
- `message` is `str(e)`.
- `code` is `e.code` if it is a `str`; otherwise
  `errno.errorcode[e.errno]` for an `OSError`. That makes
  `ConnectionRefusedError` produce `ECONNREFUSED`, so it classifies as
  `network` exactly as in Node.
- `status` is `e.status`, then `e.status_code`, then
  `e.response.status_code`, taking ints only.
- For `MCPError`/`McpError`, `code` is the JSON-RPC code, so `classifyFailureChannel` works.

**Documented differences from JS:**

1. Thrown fingerprints and signatures never equal JS ones, because the
   stack format differs. This is expected and harmless, since no JS and
   Python code share a thrown error.
2. `str(e)` is not `err.message`. For example, `KeyError('x')` stringifies
   to `"'x'"`.
3. The **SDK wording differs** across languages. FastMCP and MCPServer
   prefix messages with `Error executing tool <name>: `, and
   `UnexpectedToolError` carries no detail at all. The algorithm is the
   same, but the same logical failure arrives with different text in JS
   and Python, so its fingerprint differs. MCPServer 2.x's
   `UnexpectedToolError` would collapse every crash in one tool into a
   single fingerprint. Cause capture (Decision 3) avoids that by
   fingerprinting the chained original.
4. Python-native exception names that JS never sees, such as
   `json.JSONDecodeError`, `httpx.ConnectTimeout` and
   `asyncio.CancelledError`, fall through to message rules or `internal`.
   The classifier tables stay byte-identical to JS (round-2 decision F).
   There are never rules for Python only, because the category is hashed
   into the fingerprint. A rule ships only as a shared rule that exists in
   both JS and Python, with conformance cases. Candidates are listed in
   Follow-ups.

### 6. Shared conformance suite

There is a precedent: `test/fingerprint/compose.fixtures.test.js` already
pins fingerprints against the v0.6.1 tag, as inline literals. The new suite
moves cases like these into language-neutral JSON at the repo root
(Decision 6).

## Decision

### 1. Package

| | |
|---|---|
| PyPI name | `opentel-mcp` |
| Import name | `opentel_mcp`, shipped with `py.typed` |
| Location | `packages/python/` in this monorepo. Root `package.json` lists workspaces explicitly (`package.json:6-11`), so npm ignores the folder. |
| Python | 3.10, 3.11, 3.12, 3.13, 3.14 (`requires-python = ">=3.10"`; mcp 1.25 and 2.3 both declare `>=3.10` and list 3.14) |
| Required deps | `opentelemetry-api>=1.28` (the same floor mcp 2.x uses) |
| Optional extra `[dev]` | `opentelemetry-sdk>=1.28`, for dev mode (Decision 8) |
| `mcp` | **not** a hard dependency (an instrumentation library should not choose the host's SDK version). It is detected at runtime. Supported: **`mcp>=1.25,<3`** (round-1 decision 1). CI tests the oldest supported 1.x (`1.25.*`), the latest 1.x and the latest 2.x. |
| Version | starts at `0.1.0`, versioned independently of core. Its README states which core contract version it implements (`contract: core 0.17.0`). |

### 2. v0.1 scope

**IN:**

- `tools/call` SERVER spans with the exact JS attribute set (Finding 4)
- silent-failure detection (isError → `error.type=tool_error` and ERROR)
- the thrown path
- fingerprinting, the 7+1 categories and the 6-value channel
- the four core metrics with identical names, units, descriptions and label
  sets
- error-recording modes `full`, `normalized` and `none`, plus the redactor,
  secret scrubbing and caps, with the env var
  `OTEL_MCP_ERROR_RECORDING_MODE`
- never-throw
- dev mode (`setup_sdk=True`): a stderr span exporter, an OTLP/JSON
  exporter and flush on exit
- W3C trace context extraction from `params._meta` (ADR 017). This is one
  `propagate.extract` call and is needed for correct parenting.
- `sdk_tracing` (`"replace"` | `"enrich"`) on mcp 2.x (Decision 3)
- cause capture for MCPServer 2.x `UnexpectedToolError` (Decision 3)

**DEFERRED**, in rough order:

| Version | Feature | Why at this point |
|---|---|---|
| 0.2 | `mcp.failure.validation_paths` (ADR 009) for pydantic messages | the cheapest increase in signal |
| 0.3 | unactionable errors (ADR 025) | span-only, small |
| 0.4 | staleness (ADR 027) | span plus one counter, `_meta` contract |
| 0.5 | thrash detection (ADR 006/012/018) | needs session state and tracker lifecycle |
| 0.6 | schema drift (ADR 010) | needs `tools/list` wrapping and a store |
| 0.7 | resources/prompts coverage (ADR 026) | `mcp.server.operation.duration`; on 2.x this partly overlaps with the SDK's spans |
| 0.8 | cost attribution and pricing (ADR 011/016/019) | largest surface; needs the pricing table shared through the spec |

### 3. API and integration strategy

```python
from opentel_mcp import instrument_mcp_server

instrument_mcp_server(
    server,                      # lowlevel Server | FastMCP (1.x) | MCPServer (2.x)
    *,
    enabled=True,
    enable_metrics=True,
    fingerprinting=True,
    error_recording=None,        # {"mode": "full"|"normalized"|"none", "redactor": callable}
    setup_sdk=False,             # JS: setupNodeSdk ("Node" is meaningless here)
    service_name=None,           # required when setup_sdk=True
    exporter_url=None,           # OTLP/HTTP JSON endpoint (dev mode)
    flush_on_exit=None,          # bool | {"timeout_ms": int}; default on with setup_sdk
    sdk_tracing="replace",       # mcp 2.x only: "replace" | "enrich" (Decision 3)
) -> server                      # returns the same object
```

Options are the JS names in snake_case and resolve the same way as
`resolveOptions()` (`config.js:262-362`). An invalid value falls back to the
default with a single `logging.getLogger("opentel_mcp")` warning. The one
exception matches JS: `setup_sdk=True` without `service_name` raises
`ValueError` at the instrument call (`config.js:266-273`). That happens at
startup, never in the request path. Unknown options are ignored with a
warning. A second call on the same server is a no-op that logs one warning.

**mcp 2.x (`Server` and `MCPServer`).** Round-2 decision A. One mechanism
serves both `sdk_tracing` modes, and the mode only decides what happens to
the SDK's `OpenTelemetryMiddleware`.

*Where we hook.* We wrap the registered `tools/call` handler itself, not the
middleware chain. The code is
`entry = server.get_request_handler("tools/call")`, then
`server.add_request_handler("tools/call", entry.params_type,
wrap(entry.handler))`, using public API (`lowlevel/server.py:484-530`).
`HandlerEntry` is frozen (`:92`), so we re-register it instead of mutating
it. For `MCPServer` the low-level server is reached the same way;
`MCPServer` installs its extension-composed `tools/call` handler in
`__init__` (`mcpserver/server.py:272,354-367`), so it is already in place
when we wrap. This is the 2.x equivalent of ADR 001's "innermost handler".
The middleware chain runs lookup, params validation and the init gate
*before* the handler (`runner.py:185-216`), so bad params and pre-initialize
requests never reach our code. They produce no span and no metrics, as in
JS, and our duration covers only the handler. A middleware-based design
could not give that. A low-level `Server` must register its `tools/call`
handler before `instrument_mcp_server()`; the README says so (as JS's ADR
002 does). If none is registered, we warn once and do nothing.

*`sdk_tracing="replace"` (default).*
- **Find:** look for the SDK middleware in the server's `middleware` list
  (public on both `Server` and `MCPServer`, `mcpserver/server.py:279-287`).
  The match is `isinstance` against `mcp.server._otel.OpenTelemetryMiddleware`,
  a private module whose import is guarded. If the import fails, the match
  falls back to `type(m).__name__ == "OpenTelemetryMiddleware"`.
- **Replace in place:** swap the entry for `_SdkTracingWithoutToolsCall(sdk_mw)`.
  This small delegating middleware calls `call_next(ctx)` directly when
  `ctx.method == "tools/call"` and otherwise forwards to the SDK middleware.
  The SDK keeps its spans for `initialize`, `tools/list`, `resources/*`,
  `prompts/*` and the rest; only its `tools/call` span goes away. Removing
  the entry outright would silently drop all of them, so we don't.
- **Our span:** the handler wrapper creates the single `tools/call` SERVER
  span with the full JS contract, exactly as on 1.x.
- **Log:** one `INFO` on the `opentel_mcp` logger: *"replaced the mcp
  SDK's tools/call span with opentel-mcp's (scrubbed exceptions,
  error-recording modes). Pass sdk_tracing="enrich" to keep the SDK span."*
- **Fallback, which never throws:** fall back to `"enrich"` with one
  `WARNING` when any of these holds: `middleware` is missing or is not a
  `list`; the matched object's `__call__` does not take
  `(ctx, call_next)` (checked with `inspect.signature` at install time,
  since the API is provisional: `lowlevel/server.py:448-450`); or the swap
  raises. If no SDK middleware is in the list (the user already removed
  it), there is nothing to replace. We then use own-span mode and log
  nothing.

*`sdk_tracing="enrich"`.* The SDK middleware is left alone. Inside the
handler wrapper, `trace.get_current_span()` is the SDK span (verification
table). We enrich it:
- `mcp.tool.argument_count`, `mcp.failure.*` and the channel;
- status OK on success;
- `error.type=tool_error` plus fingerprint on isError;
- fingerprint and classification on thrown exceptions, with the exception
  re-raised so the SDK records it.

We record the four metrics, with duration measured around the handler.
**We do not add our own exception event** on the thrown path, because the
SDK already records one and a second would duplicate it. We never start a
span. Documented consequences, in the README and the `sdk_tracing`
docstring:
- **Raw exceptions.** On the thrown path the SDK records exceptions raw:
  full message and stack, unscrubbed and uncapped. `error_recording`
  modes, the redactor and the caps do not apply there. For `MCPServer`,
  that path is only `MCPError`, whose raw message becomes the status
  description. For a low-level `Server`, it is every exception.
- **`error.type` differences on the span:**
  - `type(e).__qualname__` instead of `__name__`;
  - the JSON-RPC code string (e.g. `"-32602"`) for `MCPError`;
  - `"-32602"` with status ERROR on spans for bad params and pre-initialize
    requests, which JS does not create.

  Our **metrics** keep our values. The SDK writes after the handler
  returns, so it overwrites any value we set on the span.
- **Span duration** also covers validation and serialization.
- **Scope** is `mcp-python-sdk`.
- **Startup warning:** when `"enrich"` is combined with
  `error_recording.mode` of `normalized` or `none`, or with a redactor, we
  warn once at startup that the SDK will still record thrown exceptions
  raw.

*Exactly one `tools/call` span, guaranteed at runtime in both modes.*
Before creating its own span, the handler wrapper checks the current span.
If that span is recording, is named `tools/call…`, and has kind SERVER
where the SDK exposes `kind`, it belongs to another instrumentation; we
never create our own span inside our own handler. For example, the SDK
could have renamed its middleware so our "find" missed it. In that case we
enrich it instead of nesting a second span, and warn once. A span
extracted from `_meta` is remote and non-recording, so it never matches.

*Cause capture for MCPServer 2.x (round-2 decision B).* **Verified in
mcp 2.3.0: the original exception is chained.**
- `Tool.run` raises `UnexpectedToolError(f"Error executing tool {name}")
  from exc` (`mcpserver/tools/base.py:161,213`).
- A nested tool or resource crash chains the inner `Unexpected…Error`
  (`:204-207`).
- The class docstring promises that `__cause__` is the original
  (`mcpserver/exceptions.py:61-69`), and so does `MCPServer.call_tool`'s
  (`mcpserver/server.py:538-545`).
- `_handle_call_tool` then converts it into an isError result
  (`mcpserver/server.py:437-456`), so neither the handler result nor any
  middleware sees the exception.

So, per instance and not per class, we set `server.call_tool` to a wrapper.
`_handle_call_tool` calls `self.call_tool(...)` (`:442`), so an
instance attribute takes effect, including through
`compose_tool_call_handler`, which binds `_handle_call_tool` and not
`call_tool`. The capture works like this:
1. Before calling the inner handler, the handler wrapper puts a fresh
   holder object in a contextvar.
2. The `call_tool` wrapper catches `UnexpectedToolError`, stores it in the
   holder, and re-raises it with a bare `raise`.
3. A holder, not a set contextvar, is used so that the capture also
   survives a copied context.

When the result is isError and the holder has an `UnexpectedToolError`, we
walk `__cause__` past `UnexpectedToolError`/`UnexpectedResourceError`
wrappers to the first other exception (at most 8 hops; `__context__` only
if `__cause__` is `None`), and then:
- **Fingerprint and classify the original:** `errorClass =
  type(orig).__name__`, message `str(orig)`, stack signature from
  `orig.__traceback__`. `origin` stays `tool_error`, because that is how it
  reached the wire, and it matches how JS fingerprints a crash that
  `McpServer` converted to isError.
- **Outcome stays silent failure:** `error.type=tool_error`, and the
  `mcp.tool.silent_failures` counter increments. The span records the
  original through `error_recording`: in `full` mode it is scrubbed and
  capped, in `normalized` mode only the normalized message is recorded,
  and in `none` mode nothing is.
- **`ToolError` is not unwrapped.** Its message already carries the
  detail, and unwrapping it would diverge further from JS's text-based
  isError fingerprint.

If the chain is empty (nothing to unwrap), we fall back to the wire text.
These crashes then group into one fingerprint per tool, which the README
documents. A contract test pins `call_tool`'s name and the
`UnexpectedToolError` chaining on the latest 2.x. If the wrapper can't be
installed, cause capture is off and we warn once. This applies to both
`sdk_tracing` modes.

**mcp 1.x lowlevel `Server`:** wrap `request_handlers[types.CallToolRequest]`.
Registration order does not matter. We replace `server.request_handlers`
with a `dict` subclass whose `__setitem__` wraps a `CallToolRequest`
handler on insert, and we wrap any handler that is already present. That
removes the instrument-first constraint JS needs (ADR 002) without patching
classes. The request id comes from `server.request_context.request_id`, the
`_meta` from `req.params.meta`, and the argument count from
`len(req.params.arguments or {})`.

**mcp 1.x `FastMCP`:** apply the same treatment to `server._mcp_server`.
That is a private attribute, so a contract test pins it.

**Shared core:** both adapters call a single `ToolCallRecorder` that owns the
span, attributes, fingerprint and metrics. Only extracting `tool_name`,
`arguments`, `request_id`, `_meta` and the result differs per adapter. A
result is normalized to the wire dict (`model_dump(by_alias=True,
mode="json", exclude_none=True)` for pydantic models) before
`is_error`/fingerprinting, so Python sees exactly the shape JS sees.

**Exceptions and cancellation:**

- The original exception is re-raised with a bare `raise` (same object,
  same traceback).
- `asyncio.CancelledError` / anyio cancellation goes down the thrown path
  (`error.type=CancelledError`, which matches JS `AbortError` behaviour in
  spirit) and is then re-raised.
- `KeyboardInterrupt`/`SystemExit` end the span, record nothing, and
  re-raise.

**Never-throw:** all instrumentation runs inside `try/except Exception`
blocks that fall through to calling the original handler or returning the
original result unchanged. Nothing is ever written to **stdout**, because
stdout is the JSON-RPC channel for stdio servers.

### 4. Attribute and metric contract

Names, values, types, units and descriptions are identical to Finding 4.
The tracer and meter scope name is `opentel-mcp`, the same as JS, and the
scope version is the Python package version.

- `mcp.tool.argument_count` is an `int`.
- `jsonrpc.request.id` is a `str`.
- `error.type` on the thrown path is `type(e).__name__[:128]`, not the SDK's
  `__qualname__`. That holds on the span on 1.x and with
  `sdk_tracing="replace"`. With `"enrich"`, the SDK overwrites the span's
  value (verification point 1, documented). Our metric labels keep
  `__name__` in every mode.

The Python allowlists (`METRIC_SAFE_ATTRIBUTES`,
`FINGERPRINT_METRIC_SAFE_ATTRIBUTES`) are frozen `tuple`s. **Contract test:**
`conformance/contract.json` holds every span attribute key, every metric
(name, kind, unit, description, label keys) and both allowlists.

- JS gains `test/conformance.contract.test.js`, which asserts that
  `contract.json` equals what `attributes.js`, `fingerprint/attributes.js`
  and `metrics.js` export and register. `metrics.js` is exercised with an
  in-memory MeterProvider. This makes JS the source of truth.
- Python gains a mirror test plus an equivalent of the ADR 021 cross-check:
  every label key passed at a Python metric call site must be in an
  allowlist.

### 5. Fingerprint approach

Port `normalize/{secrets,patterns,message,exception}`, `classify/*` and
`compose`/`hash` with the translation rules of Finding 5. Port `stack.js`'s
*output* format with Python traceback input. The documented differences are
the four listed in Finding 5. The hash version stays `v1`. Bumping it is a
core decision that both packages must take together.

### 6. Conformance suite

```
conformance/
  README.md            # format, how to add a case, regeneration rule
  contract.json        # names, metrics, allowlists (Decision 4)
  patterns.json        # SECRET_STEPS / NORMALIZE_STEPS / classifier regex sources + flags
  cases/
    normalize.json     # raw → normalizedMessage
    tool-error.json    # isError result → attributes, category, channel, fingerprint, signature
    channel.json       # result / {code,message} → channel
    error-recording.json  # (mode, error) → exception event attrs (message parts only)
    thrown.py.json     # Python-only: synthetic frames → stackSignature, fingerprint
```

Each case looks like this:
`{"id", "input", "ctx": {"toolName", "origin", "cwd"}, "expect": {...},
"languages": ["js","py"]}`. Strings that hold lone surrogates use
`\uXXXX` escapes, which both `JSON.parse` and `json.loads` preserve.

**JS adopts the suite without any behaviour change:**

- A one-off script (`packages/core/scripts/gen-conformance.mjs`) generates
  `expect` by running the **current, unmodified** core functions.
- `test/conformance.test.js` asserts every `js` case.
- `patterns.json` is generated from the live `SECRET_STEPS` and
  `NORMALIZE_STEPS` objects (`source` and `flags`), so a JS regex edit fails
  the test until the file is regenerated, which in turn flags the change to
  Python.
- The seed cases are the existing `compose.fixtures.test.js` cases plus the
  19 probe inputs from Finding 5. The existing inline tests stay as they
  are.

### 7. Tooling

- `pyproject.toml` with the **hatchling** build backend and a `src/` layout.
- **uv** for the dev environment and lockfile (`uv.lock` committed).
- **pytest** with **anyio**'s pytest plugin. anyio is already an mcp
  dependency, so no pytest-asyncio is needed.
- **mypy --strict** and **ruff** (lint and format).
- Coverage gate: 90% (to confirm).

New workflow job `python` in `.github/workflows/ci.yml`:

- Matrix (round-2 decision C), 13 jobs, listed explicitly with `include:`
  rather than as a cross product:

  | OS | Python | mcp | Jobs |
  |---|---|---|---|
  | ubuntu | 3.10, 3.11, 3.12, 3.13, 3.14 | latest 1.x, latest 2.x | 10 |
  | macos | 3.14 | latest 2.x | 1 |
  | windows | 3.14 | latest 2.x | 1 |
  | ubuntu | 3.10 | `1.25.*` (oldest supported) | 1 |

  The target was "about 10". The specified axes give 13, and nothing was
  cut to hit the number. The `conformance` job below is separate.
- In every 2.x job, both `sdk_tracing` modes, plus "SDK middleware already
  removed", run as pytest parametrizations inside the job, not as extra
  jobs. Every 2.x job also runs the contract tests that pin the private
  surface: `mcp.server._otel.OpenTelemetryMiddleware`, its
  `(ctx, call_next)` signature, `MCPServer.call_tool` and the
  `UnexpectedToolError.__cause__` chain.
- Steps: `uv sync`, `ruff check`, `ruff format --check`, `mypy`, `pytest`.
- A `conformance` job on ubuntu runs both the JS and Python conformance
  tests.

### 8. Dev mode (mirrors ADR 003, 005, 023, 024)

`setup_sdk=True` creates a `TracerProvider` with
`Resource(service.name=service_name)` and a `MeterProvider`, and registers
both globally unless providers are already set, in which case it warns and
reuses them.

- Spans go to a stderr exporter that writes the same object shape as
  `exporters/stderr.js` as JSON lines.
- When `exporter_url` is set, spans also go to **a small OTLP/HTTP JSON
  trace exporter shipped in this package** (stdlib `urllib` and `json`,
  behind a `BatchSpanProcessor`). Round-1 decision 3 sets its limits:
  - **It is used only on the `setup_sdk=True` path, to talk to
    opentel-mcp-ui.** It lives in a private module
    (`opentel_mcp._dev.otlp_json`), is not exported from `opentel_mcp`, and
    is not documented as a general-purpose exporter. It handles traces
    only, not metrics or logs.
  - **Production users keep the standard
    `opentelemetry-exporter-otlp-proto-http` exporter** with their own
    provider (`setup_sdk=False`). The README says this explicitly.
  - **The ids are hex.** `traceId` is 32 lowercase hex characters and
    `spanId` and `parentSpanId` are 16, never base64. Protobuf JSON's
    default `bytes` mapping would give base64; the OTLP spec overrides it,
    and the UI uses the ids as given
    (`otlp-json-receiver.js:97-98`). Timestamps are decimal-string
    `…UnixNano`, and int attributes are `{"intValue": "<decimal>"}`.
  - **Test:** `tests/dev/test_otlp_json_exporter.py` encodes a span with
    known ids and asserts the exact `traceId`/`spanId`/`parentSpanId` hex
    strings. It also asserts that decoding them as base64 is *not* what we
    produce, and that `Content-Type: application/json` is set. The UI e2e
    test (Decision 10) checks the same ids round-trip through
    `/api/spans/history`.

**Why the custom exporter:** the official
`opentelemetry-exporter-otlp-proto-http` 1.45.1 sends only
`Content-Type: application/x-protobuf`
(`opentelemetry/exporter/otlp/proto/http/__init__.py:67`). The UI accepts
only `application/json` and returns 415 for anything else
(`packages/ui/src/request-guard.js:124-133`). The custom exporter follows
the OTLP JSON mapping.

`flush_on_exit` uses `atexit` plus a SIGTERM/SIGINT handler that flushes and
then chains to the previous handler, with a 2 s default timeout as in ADR
024. That is needed because Python does not run `atexit` on SIGTERM by
default.

### 9. Release (manual, like npm)

1. `uv build` (sdist + wheel)
2. `twine check dist/*`
3. `twine upload -r testpypi dist/*`
4. Install from TestPyPI into a clean venv and run the e2e smoke test
5. `twine upload dist/*`
6. Tag `python-v0.1.0`

Publishing is manual (round-2 decision E). The credential is a PyPI API
token **scoped to the `opentel-mcp` project** (plus a separate TestPyPI
token), stored in the maintainer's `~/.pypirc` or passed through
`TWINE_PASSWORD`. It never goes in the repo or CI. The first upload can
only use an account-wide token, because a project-scoped token can only be
created once the project exists. Replace it with a project-scoped token
straight afterwards and revoke the account-wide one. The steps above,
including the clean-venv smoke test and the token setup, go in a new
"Releasing the Python package" section of `CONTRIBUTING.md`, next to the
npm steps. That section lands with the implementation, not with this ADR.
There is no CI publishing.

### 10. UI verification (end-to-end test)

`packages/python/tests/e2e/test_ui_roundtrip.py` runs on the ubuntu CI leg
with Node 22 and is skipped when `node` is missing.

1. Start the real `node packages/ui/bin/opentel-mcp-ui.js --port=<free>`.
2. Build an `MCPServer` with one tool that returns an isError result.
   Instrument it with `setup_sdk=True` and
   `exporter_url=http://127.0.0.1:<port>/v1/traces`.
3. Call the tool through the SDK's in-memory client transport and
   `force_flush()`.
4. Assert that `GET /api/summary` returns `silentFailure == 1`.
5. Assert that the span in `GET /api/spans/history` has `errorType ==
   "tool_error"`, the expected category and channel, and an
   `mcp.failure.fingerprint` **equal to the conformance-suite value for the
   same text**. That proves cross-language fingerprint identity through the
   real dashboard.

Variants run the same flow on:
- mcp 1.x `FastMCP`;
- mcp 2.x `MCPServer` with `sdk_tracing="replace"`;
- mcp 2.x `MCPServer` with `sdk_tracing="enrich"`;
- mcp 2.x with the SDK middleware already removed by the user.

Each variant asserts **exactly one** `tools/call` span in
`/api/spans/history` (round-2 decision A), and that its `id`/`traceId` are
the hex ids our exporter sent (round-1 decision 3). The `"enrich"` variant
also needs the SDK span to reach the UI. The SDK middleware uses the
global tracer provider that dev mode installs, so it does. In addition:
- The `"replace"` variant asserts that a `tools/list` call still produces
  the SDK's own span (in-memory exporter), which proves only `tools/call`
  was taken over.
- One more 2.x case has a tool that raises `RuntimeError("boom 42")`. It
  asserts that the UI span's `mcp.failure.error_class == "RuntimeError"`,
  which proves cause capture.

## Alternatives considered

- **A separate repository.** Rejected: the conformance suite, the
  contract test and the UI e2e test all need to change atomically with core.
  A second repo would turn every contract change into a coordinated
  two-repo release, and ADRs already live here.
- **A Rust/WASM shared core** (one fingerprint implementation compiled for
  both). Rejected for v0.1: it adds a native/WASM build matrix across 3 OSes
  × 5 Pythons, wheels per platform and a WASM runtime in Node, all to share
  about 400 lines of regex and string code that the translation rules
  already reproduce byte-for-byte (Finding 5). Worth revisiting if the
  shared logic grows a lot.
- **Wrapping the JS package** (running a Node sidecar, or calling the JS
  core through a subprocess). Rejected: it puts a Node runtime dependency on
  Python users, adds per-call IPC latency inside the request path, and
  creates a new failure mode that could throw into the host.
- **Enrichment only, no replace mode** (round-1 decision 2). The
  verification showed that it can't keep the privacy contract on the thrown
  path. Kept as the opt-in `"enrich"` mode instead (round-2 decision A).
- **Removing the SDK middleware outright** in `"replace"`. Rejected, because
  it would also drop the SDK's spans for every non-tool method. We
  delegate everything except `tools/call` to it instead.
- **Doing replace mode with a middleware.** Rejected, because middleware
  wraps lookup, validation and the init gate (`runner.py:185-216`). Bad
  params and pre-initialize requests would then get spans and the duration
  semantics would differ from JS. We wrap the handler entry instead.
- **PyPI Trusted Publishing from a tag workflow.** Rejected for now (round-2
  decision E), to match the manual npm process.
- **Python-only classifier rules.** Rejected (round-2 decision F): the
  category is hashed into the fingerprint, so a rule that exists only in
  Python would split the same failure into different fingerprints across
  languages.
- **Adding protobuf ingestion to opentel-mcp-ui** instead of shipping a JSON
  exporter. Rejected for v0.1, because the UI stays unchanged (round-1
  decision 3). It is planned as a separate, later UI release (see
  Follow-ups).
- **Making the dev-mode JSON exporter a public, general-purpose exporter.**
  Rejected (round-1 decision 3): production users keep the standard
  protobuf exporter, and we would rather not maintain a public OTLP
  exporter.
- **Monkey-patching SDK classes globally** (the Traceloop approach).
  Rejected: it affects every server in the process, ignores per-instance
  options, and breaks when private module paths move. We patch per instance
  only.
- **A pure-isError port with no fingerprinting** (the smallest v0.1).
  Rejected: on mcp 2.x it would duplicate what the SDK already does and add
  nothing (Finding 3).

## Consequences

- Python servers appear in opentel-mcp-ui with silent failures counted,
  categorized and fingerprinted, with no UI change.
- Any change in core to a regex, an attribute or a metric now fails the JS
  conformance and contract tests until the spec is regenerated, which makes
  the Python follow-up visible. Core takes on a small new obligation.
- The integration with mcp 2.x is tied to a provisional SDK API and to a
  private module path (`mcp.server._otel`). Expect maintenance on SDK minor
  releases. Contract tests catch breakage on the latest 2.x, and the
  `"replace"` → `"enrich"` fallback plus the one-span runtime guard keep a
  break from becoming a crash or a double span.
- By default, Python 2.x servers emit our `tools/call` span with scope
  `opentel-mcp` instead of the SDK's span with scope `mcp-python-sdk`.
  Users who rely on the SDK's `tools/call` span pass
  `sdk_tracing="enrich"`.
- For MCPServer 2.x crashes, the span carries more detail than the client
  sees: the original exception, filtered through `error_recording`. That
  is deliberate, because it is server-side telemetry. The README says so.
- Dev mode ships its own OTLP/JSON exporter: about 150 lines we now own.

## Follow-ups (outside Python v0.1)

- **opentel-mcp-ui: accept OTLP/HTTP protobuf** (`application/x-protobuf`)
  on `/v1/traces`, in a separate, later UI release with its own ADR. Then
  stock exporters in any language can feed the dashboard, and the Python
  dev-mode JSON exporter could become optional.
- **Upstream python-sdk issue** (round-2 decision A): ask for an option on
  `OpenTelemetryMiddleware` to turn off its exception recording (for
  example `record_exceptions=False`), or an error-description hook.
  Optionally also ask for a public import path for the class. If it lands,
  revisit the `sdk_tracing` default: `"enrich"` could become the default,
  with our scrubbed recording.
- **Standalone `fastmcp` (Prefect)** support (round-2 decision D). It has its
  own native OTel and a different handler surface. It needs its own
  investigation and ADR.
- **Proposed shared classifier additions** (round-2 decision F). These are
  not added in v0.1. Each one would land in JS core and Python together,
  with conformance cases:
  - `JSONDecodeError` → serialization
  - `ConnectTimeout`/`ReadTimeout`/`TimeoutException` (httpx) → timeout
  - `CancelledError` → the category JS uses for `AbortError`
  - `ValidationError` (pydantic) → validation, if JS's Zod rule doesn't
    already cover the message

## Open questions for the maintainer

None. All were resolved on 2026-10-25 (Maintainer decisions, rounds 1 and
2).
