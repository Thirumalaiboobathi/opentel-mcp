"""mcp 2.x specifics: sdk_tracing, cause capture, bad params, the init gate, one-span guarantee."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry.trace import SpanKind, StatusCode

from opentel_mcp import _adapters, instrument_mcp_server
from tests import harness
from tests.conftest import Telemetry

pytestmark = [pytest.mark.anyio, pytest.mark.skipif(not harness.IS_V2, reason="mcp 2.x only")]

OURS = "opentel-mcp"
SDK = "mcp-python-sdk"


def scopes(tel: Telemetry) -> list[str]:
    return [s.instrumentation_scope.name for s in tel.tool_call_spans()]


def attrs(span: Any) -> dict[str, Any]:
    return dict(span.attributes or {})


def pts(tel: Telemetry, name: str) -> list[tuple[dict[str, Any], Any]]:
    return tel.metric_points().get(name, [])


async def call(flavour: str, name: str, *, remove: bool = False, **options: Any) -> None:
    server, lowlevel = harness.build(
        flavour, lambda s: instrument_mcp_server(s, **options), remove_sdk_middleware=remove
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call(name, {})


# -- sdk_tracing ------------------------------------------------------------------------------------------------


async def test_replace_emits_only_our_tools_call_span_and_keeps_the_other_sdk_spans(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    opentel_logs.set_level(logging.INFO, logger="opentel_mcp")
    server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s))
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok", {})
        await client.list_tools()
    assert scopes(telemetry) == [OURS]
    sdk_spans = [s for s in telemetry.spans() if s.instrumentation_scope.name == SDK]
    assert "tools/list" in {s.name for s in sdk_spans}, (
        "only tools/call was taken over from the SDK middleware"
    )
    assert any(isinstance(m, _adapters._SdkTracingWithoutToolsCall) for m in lowlevel.middleware)
    assert sum("replaced the mcp SDK's tools/call span" in r.getMessage() for r in opentel_logs.records) == 1


async def test_enrich_keeps_the_sdk_span_and_adds_our_attributes(telemetry: Telemetry) -> None:
    await call("mcpserver", "silent", sdk_tracing="enrich")
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert span.instrumentation_scope.name == SDK and span.kind == SpanKind.SERVER
    assert a["mcp.tool.argument_count"] == 0
    assert a["error.type"] == "tool_error" and span.status.status_code == StatusCode.ERROR
    assert a["mcp.failure.category"] == "validation" and a["mcp.failure.channel"] == "execution"
    assert "mcp.protocol.version" in a  # the SDK's own attribute is still there
    (sf,) = pts(telemetry, "mcp.tool.silent_failures")
    assert sf[0]["gen_ai.tool.name"] == "silent"


async def test_enrich_sets_ok_on_success(telemetry: Telemetry) -> None:
    await call("mcpserver", "ok", sdk_tracing="enrich")
    (span,) = telemetry.tool_call_spans()
    assert span.status.status_code == StatusCode.OK and scopes(telemetry) == [SDK]


async def test_sdk_middleware_already_removed_means_our_own_span(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    await call("mcpserver", "silent", remove=True)
    assert scopes(telemetry) == [OURS]
    assert not [r for r in opentel_logs.records if r.levelno >= logging.WARNING]


async def test_invalid_sdk_tracing_value_falls_back_to_replace_with_one_warning(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    await call("mcpserver", "ok", sdk_tracing="both")
    assert scopes(telemetry) == [OURS]
    assert sum("sdk_tracing must be" in r.getMessage() for r in opentel_logs.records) == 1


async def test_replace_falls_back_to_enrich_with_one_warning_when_the_sdk_middleware_signature_changes(
    telemetry: Telemetry, monkeypatch: pytest.MonkeyPatch, opentel_logs: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(_adapters, "_takes_ctx_and_call_next", lambda m: False)
    server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s))
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent", {})
        await client.call("silent", {})
    spans = telemetry.tool_call_spans()
    assert len(spans) == 2 and {s.instrumentation_scope.name for s in spans} == {
        SDK
    }  # one per call, the SDK's, enriched
    assert all(attrs(s)["mcp.failure.category"] == "validation" for s in spans)
    assert sum("falling back to" in r.getMessage() for r in opentel_logs.records) == 1


class _Boom(list):  # type: ignore[type-arg]
    def __setitem__(self, i: Any, v: Any) -> None:
        raise RuntimeError("cannot swap")


class _FakeLowlevel:
    def __init__(self, middleware: Any) -> None:
        self.middleware = middleware


def _fake_sdk_middleware() -> Any:
    class OpenTelemetryMiddleware:
        async def __call__(self, ctx: Any, call_next: Any) -> Any:
            return await call_next(ctx)

    return OpenTelemetryMiddleware()


@pytest.mark.parametrize(
    "lowlevel",
    [object(), _FakeLowlevel("not a list"), _FakeLowlevel(_Boom([_fake_sdk_middleware()]))],
    ids=["no-middleware-attr", "not-a-list", "swap-raises"],
)
def test_replace_fallback_never_raises(lowlevel: Any) -> None:
    from opentel_mcp._config import resolve_options
    from opentel_mcp._recorder import ToolCallRecorder

    options = resolve_options()
    rec = ToolCallRecorder(options, trace.get_tracer("t"), None)
    assert _adapters.decide_sdk_tracing(lowlevel, options, rec) == "enrich-or-own"


def test_replace_with_no_sdk_middleware_in_the_list_means_own_span() -> None:
    from opentel_mcp._config import resolve_options
    from opentel_mcp._recorder import ToolCallRecorder

    options = resolve_options()
    rec = ToolCallRecorder(options, trace.get_tracer("t"), None)
    assert _adapters.decide_sdk_tracing(_FakeLowlevel([]), options, rec) == "own"


# -- exactly one tools/call span ------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["replace", "enrich"])
@pytest.mark.parametrize("flavour", ["lowlevel", "mcpserver"])
@pytest.mark.parametrize("tool", ["ok", "silent", "raises", "echo"])
async def test_exactly_one_tools_call_span_in_every_mode(
    mode: str, flavour: str, tool: str, telemetry: Telemetry
) -> None:
    await call(flavour, tool, sdk_tracing=mode)
    assert len(telemetry.tool_call_spans()) == 1


async def _run_in_span(span_name: str, kind: SpanKind, telemetry: Telemetry) -> tuple[list[Any], Any]:
    from opentel_mcp._config import resolve_options
    from opentel_mcp._recorder import CallInfo, ToolCallRecorder

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("opentel-mcp"), None, "own")
    tracer = trace.get_tracer("other-instrumentation")

    async def inner() -> Any:
        return {"content": [], "isError": True}

    with tracer.start_as_current_span(span_name, kind=kind):
        await rec.run(inner, CallInfo(tool_name="x"))
    return telemetry.tool_call_spans(), rec


async def test_foreign_recording_tools_call_server_span_is_enriched_not_nested(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    spans, _ = await _run_in_span("tools/call x", SpanKind.SERVER, telemetry)
    assert len(spans) == 1 and spans[0].instrumentation_scope.name == "other-instrumentation"
    assert attrs(spans[0])["mcp.failure.category"] == "unknown" or "mcp.failure.fingerprint" in attrs(
        spans[0]
    )
    assert attrs(spans[0])["error.type"] == "tool_error"
    assert sum("already started a tools/call span" in r.getMessage() for r in opentel_logs.records) == 1


async def test_a_tools_call_named_span_of_another_kind_is_not_foreign(telemetry: Telemetry) -> None:
    spans, _ = await _run_in_span("tools/call x", SpanKind.INTERNAL, telemetry)
    assert len(spans) == 2  # an unrelated INTERNAL span: ours nests under it


async def test_remote_parent_from_meta_never_counts_as_foreign(telemetry: Telemetry) -> None:
    from opentel_mcp._config import resolve_options
    from opentel_mcp._recorder import CallInfo, ToolCallRecorder

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("opentel-mcp"), None, "own")

    async def inner() -> Any:
        return {"content": []}

    meta = {"traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}
    await rec.run(inner, CallInfo(tool_name="x", meta=meta))
    (span,) = telemetry.tool_call_spans()
    assert (
        span.instrumentation_scope.name == "opentel-mcp" and span.parent is not None and span.parent.is_remote
    )


# -- cause capture -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["replace", "enrich"])
async def test_crash_in_an_mcpserver_tool_is_fingerprinted_by_its_original_exception(
    mode: str, telemetry: Telemetry
) -> None:
    await call("mcpserver", "raises", sdk_tracing=mode)
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert a["mcp.failure.error_class"] == "RuntimeError"
    assert a["mcp.failure.signature"].startswith("RuntimeError@raises:")
    assert a["mcp.failure.origin"] == "tool_error" and a["mcp.failure.category"] == "internal"
    assert a["error.type"] == "tool_error" and span.status.status_code == StatusCode.ERROR
    (sf,) = pts(telemetry, "mcp.tool.silent_failures")
    assert sf[0]["mcp.failure.category"] == "internal"
    (dur,) = pts(telemetry, "mcp.tool.duration")
    assert dur[0]["mcp.tool.outcome"] == "silent_failure"
    assert "mcp.tool.errors" not in telemetry.metric_points()


async def test_cause_is_recorded_through_error_recording_in_replace_mode(telemetry: Telemetry) -> None:
    await call("mcpserver", "raises")
    (span,) = telemetry.tool_call_spans()
    (ev,) = [e for e in span.events if e.name == "exception"]
    assert ev.attributes["exception.type"] == "RuntimeError"  # type: ignore[index]
    assert ev.attributes["exception.message"] == "boom 42 token=<SECRET>"  # type: ignore[index]
    assert attrs(span)["error.type"] == "tool_error"  # outcome stays a silent failure


@pytest.mark.parametrize("mode", ["normalized", "none"])
async def test_cause_recording_honours_the_mode(mode: str, telemetry: Telemetry) -> None:
    await call("mcpserver", "raises", error_recording={"mode": mode})
    (span,) = telemetry.tool_call_spans()
    evs = [e for e in span.events if e.name == "exception"]
    if mode == "none":
        assert evs == [] and span.status.description is None
    else:
        (ev,) = evs
        assert ev.attributes["exception.message"] == "boom 42 token=<SECRET>"  # type: ignore[index]
        assert "Traceback" not in ev.attributes.get("exception.stacktrace", "")  # type: ignore[union-attr]


async def test_enrich_records_the_cause_through_error_recording_too(telemetry: Telemetry) -> None:
    # The SDK never sees the crash (MCPServer turned it into an isError result), so there is no duplicate event;
    # the one on the SDK's span comes from error_recording and is scrubbed.
    await call("mcpserver", "raises", sdk_tracing="enrich")
    (span,) = telemetry.tool_call_spans()
    (ev,) = [e for e in span.events if e.name == "exception"]
    assert ev.attributes["exception.message"] == "boom 42 token=<SECRET>"  # type: ignore[index]


async def test_distinct_crashes_get_distinct_fingerprints_and_the_same_crash_the_same_one(
    telemetry: Telemetry,
) -> None:
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("crashes")

    @server.tool()
    def a(n: int) -> str:
        raise RuntimeError(f"failed for item {n}00000")

    @server.tool()
    def b() -> str:
        raise ValueError("different")

    instrument_mcp_server(server)
    async with harness.connect(server, server._lowlevel_server) as client:
        await client.call("a", {"n": 1})
        await client.call("a", {"n": 2})
        await client.call("b", {})
    fps = [attrs(s)["mcp.failure.fingerprint"] for s in telemetry.tool_call_spans()]
    assert fps[0] == fps[1] != fps[2]


async def test_tool_error_is_not_unwrapped(telemetry: Telemetry) -> None:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError

    server = MCPServer("toolerr")

    @server.tool()
    def fails() -> str:
        raise ToolError("quota exceeded for 12345")

    instrument_mcp_server(server)
    async with harness.connect(server, server._lowlevel_server) as client:
        out = await client.call("fails", {})
    assert out.is_error and "quota exceeded" in out.texts[0]
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.error_class"] == "MCPToolError"  # the wire text is what is fingerprinted
    assert [e for e in span.events if e.name == "exception"] == []


def test_original_cause_walk() -> None:
    from mcp.server.mcpserver.exceptions import UnexpectedToolError

    from opentel_mcp._recorder import original_cause

    inner = ValueError("real")
    mid = UnexpectedToolError("Error executing tool inner")
    mid.__cause__ = inner
    outer = UnexpectedToolError("Error executing tool outer")
    outer.__cause__ = mid
    assert original_cause(outer) is inner  # nested wrappers are walked through
    assert (
        original_cause(UnexpectedToolError("no cause")) is None
    )  # chain empty -> fall back to the wire text
    ctx_only = UnexpectedToolError("ctx")
    ctx_only.__context__ = inner
    assert original_cause(ctx_only) is inner  # __context__ only when __cause__ is None
    assert original_cause(None) is None
    loop = UnexpectedToolError("loop")
    loop.__cause__ = loop
    assert original_cause(loop) is None  # bounded


async def test_cause_capture_failure_warns_once_and_keeps_instrumenting(
    telemetry: Telemetry, monkeypatch: pytest.MonkeyPatch, opentel_logs: pytest.LogCaptureFixture
) -> None:
    import mcp.server.mcpserver.exceptions as exc_mod

    monkeypatch.delattr(exc_mod, "UnexpectedToolError")
    await call("mcpserver", "raises")
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.error_class"] == "MCPToolError"  # grouped by wire text, as documented
    assert sum("cause capture" in r.getMessage() for r in opentel_logs.records) == 1


# -- bad params and the initialize gate ---------------------------------------------------------------------------


async def test_bad_params_produce_no_span_and_no_metrics_in_replace_mode(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s))
    async with harness.connect(server, lowlevel) as client:
        with pytest.raises(Exception, match="Invalid request parameters"):
            await client.inner.session._dispatcher.send_raw_request("tools/call", {"arguments": {}}, None)
    assert telemetry.tool_call_spans() == []
    assert telemetry.metric_points().get("mcp.tool.calls") is None


async def test_bad_params_in_enrich_mode_are_the_sdks_documented_extra_span(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s, sdk_tracing="enrich"))
    async with harness.connect(server, lowlevel) as client:
        with pytest.raises(Exception, match="Invalid request parameters"):
            await client.inner.session._dispatcher.send_raw_request("tools/call", {"arguments": {}}, None)
    (span,) = telemetry.tool_call_spans()  # documented difference: JS produces no span here
    assert attrs(span)["error.type"] == "-32602"
    assert telemetry.metric_points().get("mcp.tool.calls") is None


@pytest.mark.parametrize("mode", ["replace", "enrich"])
async def test_a_tools_call_before_initialize_never_reaches_our_hook(mode: str, telemetry: Telemetry) -> None:
    import anyio
    from mcp.shared.memory import create_client_server_memory_streams
    from mcp.shared.message import SessionMessage
    from mcp_types import JSONRPCError, JSONRPCRequest

    _server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s, sdk_tracing=mode))
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        (client_read, client_write), (server_read, server_write) = client_streams, server_streams
        async with anyio.create_task_group() as tg:
            tg.start_soon(
                lambda: lowlevel.run(server_read, server_write, lowlevel.create_initialization_options())
            )
            await client_write.send(
                SessionMessage(
                    JSONRPCRequest(
                        jsonrpc="2.0", id=1, method="tools/call", params={"name": "ok", "arguments": {}}
                    )
                )
            )
            with anyio.fail_after(10):
                reply = await client_read.receive()
            tg.cancel_scope.cancel()
    assert isinstance(reply, SessionMessage) and isinstance(reply.message, JSONRPCError)
    assert OURS not in scopes(telemetry)
    assert telemetry.metric_points().get("mcp.tool.calls") is None


# -- registration -------------------------------------------------------------------------------------------------


def test_lowlevel_without_a_tools_call_handler_warns_once_and_does_nothing(
    opentel_logs: pytest.LogCaptureFixture,
) -> None:
    from mcp.server import Server

    server = Server("bare")
    assert instrument_mcp_server(server) is server
    assert sum("no tools/call handler" in r.getMessage() for r in opentel_logs.records) == 1
    assert not any(
        isinstance(m, _adapters._SdkTracingWithoutToolsCall) for m in server.middleware
    )  # nothing was swapped


async def test_second_instrument_call_is_a_no_op_with_one_warning(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    server, lowlevel = harness.build("mcpserver", lambda s: instrument_mcp_server(s))
    assert instrument_mcp_server(server) is server
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok", {})
    assert len(telemetry.tool_call_spans()) == 1
    assert sum("already instrumented" in r.getMessage() for r in opentel_logs.records) == 1
    assert sum(v for _, v in pts(telemetry, "mcp.tool.calls")) == 1
