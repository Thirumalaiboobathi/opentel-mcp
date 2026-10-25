"""The thrown path and error-recording modes (full / normalized / none, redactor, caps)."""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.trace import StatusCode

from opentel_mcp import instrument_mcp_server
from tests import harness
from tests.conftest import Telemetry

pytestmark = pytest.mark.anyio

SDK_TRACING = ["replace", "enrich"] if harness.IS_V2 else ["replace"]


class Outer:
    class Err(Exception):
        """Nested class: ``__qualname__`` is ``Outer.Err`` but ``__name__`` is ``Err``."""


def raising(message: str = harness.RAISE_MESSAGE, cls: type[Exception] = RuntimeError) -> Any:
    return lambda name: cls(message)


async def run_thrown(tel: Telemetry, make_exc: Any, **options: Any) -> tuple[Any, Any]:
    server, lowlevel = harness.build_raising(lambda s: instrument_mcp_server(s, **options), make_exc)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("t", {"a": 1})
    assert out.error is not None, "the exception must reach the client as a JSON-RPC error"
    (span,) = tel.tool_call_spans()
    return span, out


def event(span: Any) -> dict[str, Any] | None:
    evs = [e for e in span.events if e.name == "exception"]
    assert len(evs) <= 1, "exactly one exception event"
    return dict(evs[0].attributes or {}) if evs else None


def pts(tel: Telemetry, name: str) -> list[tuple[dict[str, Any], Any]]:
    return tel.metric_points().get(name, [])


async def test_error_type_is_the_class_name_not_the_qualname(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(telemetry, raising(cls=Outer.Err), sdk_tracing="replace")
    a = dict(span.attributes)
    assert a["error.type"] == "Err"
    assert a["mcp.failure.error_class"] == "Err"
    assert a["mcp.failure.origin"] == "thrown"
    assert a["mcp.failure.channel"] == "unknown"
    assert span.status.status_code == StatusCode.ERROR
    (err,) = pts(telemetry, "mcp.tool.errors")
    assert err[0] == {"gen_ai.tool.name": "t", "error.type": "Err", "mcp.failure.category": "internal"}
    (dur,) = pts(telemetry, "mcp.tool.duration")
    assert dur[0]["mcp.tool.outcome"] == "error"
    assert dur[0]["mcp.failure.category"] == "internal"
    assert "mcp.tool.silent_failures" not in telemetry.metric_points()


@pytest.mark.skipif(not harness.IS_V2, reason="sdk_tracing is an mcp 2.x option")
async def test_enrich_keeps_sdk_error_type_on_the_span_but_our_value_on_the_metric(
    telemetry: Telemetry,
) -> None:
    span, _ = await run_thrown(telemetry, raising(cls=Outer.Err), sdk_tracing="enrich")
    assert span.instrumentation_scope.name == "mcp-python-sdk"
    assert (
        dict(span.attributes)["error.type"] == "Outer.Err"
    )  # documented difference: the SDK writes __qualname__
    assert dict(span.attributes)["mcp.failure.error_class"] == "Err"  # ours
    (err,) = pts(telemetry, "mcp.tool.errors")
    assert err[0]["error.type"] == "Err"


async def test_full_mode_scrubs_and_keeps_the_stack(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(telemetry, raising(), sdk_tracing="replace")
    ev = event(span)
    assert ev is not None
    assert ev["exception.type"] == "RuntimeError"
    assert ev["exception.message"] == "boom 42 token=<SECRET>"
    assert "abc123" not in str(ev)
    assert "Traceback" in ev["exception.stacktrace"]
    assert span.status.description == "boom 42 token=<SECRET>"


async def test_full_mode_caps_message_and_stack(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(telemetry, raising("x" * 10000), sdk_tracing="replace")
    ev = event(span)
    assert ev is not None
    marker = " …[truncated by opentel-mcp]"
    assert ev["exception.message"] == "x" * 4096 + marker
    assert len(ev["exception.stacktrace"]) <= 16384 + len(marker)


async def test_normalized_mode_records_only_normalized_content(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(
        telemetry,
        raising("user 123e4567-e89b-12d3-a456-426614174000 failed at /var/lib/x"),
        error_recording={"mode": "normalized"},
    )
    ev = event(span)
    assert ev is not None
    assert ev["exception.type"] == "RuntimeError"
    assert ev["exception.message"] == "user <UUID> failed at <PATH>"
    assert "Traceback" not in ev.get("exception.stacktrace", "")  # only fn@file:line frames, if any
    assert span.status.description == "user <UUID> failed at <PATH>"


async def test_none_mode_records_status_only(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(telemetry, raising(), error_recording={"mode": "none"})
    assert event(span) is None
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description is None
    assert dict(span.attributes)["mcp.failure.fingerprint"]  # fingerprinting still works


async def test_mode_from_the_environment(telemetry: Telemetry, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_MCP_ERROR_RECORDING_MODE", "none")
    span, _ = await run_thrown(telemetry, raising())
    assert event(span) is None


async def test_invalid_mode_falls_back_to_full_with_one_warning(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    span, _ = await run_thrown(telemetry, raising(), error_recording={"mode": "verbose"})
    assert event(span) is not None
    assert sum("invalid error_recording mode" in r.getMessage() for r in opentel_logs.records) == 1


async def test_redactor_runs_first_in_normalized_mode(telemetry: Telemetry) -> None:
    seen: list[dict[str, Any]] = []

    def redactor(inp: dict[str, Any]) -> dict[str, Any]:
        seen.append(inp)
        return {"message": inp["message"].replace("boom", "REDACTED"), "stack": None}

    span, _ = await run_thrown(
        telemetry, raising(), error_recording={"mode": "normalized", "redactor": redactor}
    )
    assert len(seen) == 1 and set(seen[0]) == {"message", "stack"}
    ev = event(span)
    assert ev is not None and ev["exception.message"] == "REDACTED 42 token=<SECRET>"
    # the fingerprint hashes the real content, not the redacted stand-in (ADR 020 Decision 3)
    from opentel_mcp._compose import compute_fingerprint

    real = compute_fingerprint(RuntimeError(harness.RAISE_MESSAGE), tool_name="t", origin="thrown")
    assert real.normalized_message == "boom 42 token=<SECRET>"
    assert dict(span.attributes)["mcp.failure.signature"].startswith("RuntimeError@")


@pytest.mark.parametrize("bad", ["raises", "wrong-shape", "non-string-message"])
async def test_failing_redactor_degrades_to_none_with_one_content_free_warning(
    bad: str, telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    def redactor(inp: dict[str, Any]) -> Any:
        if bad == "raises":
            raise ValueError(inp["message"])
        if bad == "wrong-shape":
            return "nope"
        return {"message": 5}

    span, _ = await run_thrown(
        telemetry, raising(), error_recording={"mode": "normalized", "redactor": redactor}
    )
    assert event(span) is None
    assert span.status.status_code == StatusCode.ERROR and span.status.description is None
    warnings = [r.getMessage() for r in opentel_logs.records if "redactor" in r.getMessage()]
    assert len(warnings) == 1
    assert "boom" not in warnings[0] and "abc123" not in warnings[0]


async def test_redactor_with_another_mode_is_ignored_with_one_warning(
    telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    called: list[int] = []
    span, _ = await run_thrown(
        telemetry, raising(), error_recording={"mode": "full", "redactor": lambda i: called.append(1)}
    )
    assert called == [] and event(span) is not None
    assert sum("never invoked" in r.getMessage() for r in opentel_logs.records) == 1


@pytest.mark.skipif(not harness.IS_V2, reason="sdk_tracing is an mcp 2.x option")
async def test_enrich_leaves_the_sdk_exception_event_raw_and_adds_none_of_ours(telemetry: Telemetry) -> None:
    span, _ = await run_thrown(telemetry, raising(), sdk_tracing="enrich")
    ev = event(span)  # exactly one: the SDK's
    assert ev is not None
    assert "abc123" in ev["exception.message"], "documented: the SDK records raw exceptions"


@pytest.mark.skipif(not harness.IS_V2, reason="sdk_tracing is an mcp 2.x option")
async def test_enrich_with_normalized_mode_warns_once_at_startup(
    opentel_logs: pytest.LogCaptureFixture,
) -> None:
    server, lowlevel = harness.build_raising(
        lambda s: instrument_mcp_server(s, sdk_tracing="enrich", error_recording={"mode": "normalized"}),
        raising(),
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("t", {})
        await client.call("t", {})
    assert sum("records thrown exceptions on it raw" in r.getMessage() for r in opentel_logs.records) == 1
    # replace mode (the default) honours the modes, so it has nothing to warn about
    opentel_logs.clear()
    harness.build_raising(
        lambda s: instrument_mcp_server(s, error_recording={"mode": "normalized"}), raising()
    )
    assert not any("raw" in r.getMessage() for r in opentel_logs.records)


async def test_original_exception_object_is_reraised_unchanged() -> None:
    from opentelemetry import trace

    from opentel_mcp._config import resolve_options
    from opentel_mcp._recorder import CallInfo, ToolCallRecorder

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("t"), None, "own")
    original = RuntimeError("same object")

    async def call() -> Any:
        raise original

    with pytest.raises(RuntimeError) as info:
        await rec.run(call, CallInfo(tool_name="x"))
    assert info.value is original
    assert info.traceback[-1].name == "call"  # traceback not rewritten


async def test_cancellation_goes_down_the_thrown_path_and_is_reraised(telemetry: Telemetry) -> None:
    import asyncio

    from opentelemetry import trace

    from opentel_mcp._config import resolve_options
    from opentel_mcp._metrics import MetricsRecorder
    from opentel_mcp._recorder import CallInfo, ToolCallRecorder

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("opentel-mcp"), MetricsRecorder(), "own")

    async def call() -> Any:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await rec.run(call, CallInfo(tool_name="cancelled"))
    (span,) = telemetry.tool_call_spans()
    assert dict(span.attributes)["error.type"] == "CancelledError"


async def test_keyboard_interrupt_ends_the_span_and_records_nothing(telemetry: Telemetry) -> None:
    from opentelemetry import trace

    from opentel_mcp._config import resolve_options
    from opentel_mcp._metrics import MetricsRecorder
    from opentel_mcp._recorder import CallInfo, ToolCallRecorder

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("opentel-mcp"), MetricsRecorder(), "own")

    async def call() -> Any:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        await rec.run(call, CallInfo(tool_name="ki"))
    (span,) = telemetry.tool_call_spans()
    assert event(span) is None and "error.type" not in dict(span.attributes)
    assert "mcp.tool.errors" not in telemetry.metric_points()
