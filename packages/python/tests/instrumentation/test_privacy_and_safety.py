"""Privacy canary and never-throw guarantees (ADR 028, Decision 3 and the task's non-negotiable rules)."""

from __future__ import annotations

import io
import logging
import time
from typing import Any

import pytest
from opentelemetry import trace

from opentel_mcp import instrument_mcp_server
from opentel_mcp._config import resolve_options
from opentel_mcp._recorder import CallInfo, ToolCallRecorder
from tests import harness
from tests.conftest import Telemetry

pytestmark = pytest.mark.anyio

CANARY = harness.CANARY
SDK_TRACING = ["replace", "enrich"] if harness.IS_V2 else ["replace"]


def everything_telemetry(tel: Telemetry) -> str:
    """Every span field and metric field we could have leaked into, as one string."""
    parts: list[str] = []
    for s in tel.spans():
        parts.append(repr((s.name, dict(s.attributes or {}), s.status, s.links, dict(s.resource.attributes))))
        for e in s.events:
            parts.append(repr((e.name, dict(e.attributes or {}))))
    for name, series in tel.metric_points().items():
        parts.append(repr((name, series)))
    return "\n".join(parts)


@pytest.mark.parametrize("sdk_tracing", SDK_TRACING)
@pytest.mark.parametrize("mode", ["full", "normalized", "none"])
async def test_no_arguments_or_result_content_reach_spans_metrics_logs_or_stdout(
    sdk_tracing: str,
    mode: str,
    telemetry: Telemetry,
    opentel_logs: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    for flavour in harness.flavours():
        server, lowlevel = harness.build(
            flavour,
            lambda s: instrument_mcp_server(s, sdk_tracing=sdk_tracing, error_recording={"mode": mode}),
        )
        async with harness.connect(server, lowlevel) as client:
            for tool in ("ok", "echo", "leak", "leak_err", "silent", "raises"):
                out = await client.call(tool, {"secret": CANARY, "a": 1})
                if tool == "leak":
                    assert CANARY in out.texts[0], (
                        "the client must still get its result: we only stay out of the telemetry"
                    )
    assert CANARY not in everything_telemetry(telemetry)
    log_text = "\n".join(
        f"{r.getMessage()} {r.args} {r.exc_text}"
        for r in opentel_logs.records
        if r.name.startswith("opentel_mcp")
    )
    assert CANARY not in log_text
    out_err = capsys.readouterr()
    assert out_err.out == "", "stdout is the JSON-RPC channel for stdio servers: we never write to it"
    # The SDK may log its own errors to stderr; nothing we write there may carry the canary.
    assert not [line for line in out_err.err.splitlines() if "opentel" in line and CANARY in line]


async def test_argument_values_are_never_read(telemetry: Telemetry) -> None:
    """Only the *count* of arguments is taken: a mapping whose values explode proves nothing else is touched."""

    class Explosive(dict):  # type: ignore[type-arg]
        def values(self) -> Any:
            raise AssertionError("argument values must not be read")

        def items(self) -> Any:
            raise AssertionError("argument values must not be read")

        def __getitem__(self, k: Any) -> Any:
            raise AssertionError("argument values must not be read")

    rec = ToolCallRecorder(resolve_options(), trace.get_tracer("opentel-mcp"), None, "own")

    async def inner() -> Any:
        return {"content": []}

    await rec.run(inner, CallInfo(tool_name="t", argument_count=len(Explosive(a=1, b=2))))
    (span,) = telemetry.tool_call_spans()
    assert dict(span.attributes)["mcp.tool.argument_count"] == 2


def test_fingerprint_inputs_never_include_unbounded_raw_text_on_the_span() -> None:
    from opentel_mcp._compose import compute_fingerprint

    fp = compute_fingerprint(
        {"isError": True, "content": [{"type": "text", "text": f"invalid {CANARY} user@example.com 12345"}]},
        tool_name="t",
        origin="tool_error",
    )
    assert CANARY not in "".join(fp.span_attributes().values())


# -- never throw ------------------------------------------------------------------------------------------------------


class Hostile:
    """Raises on every attribute access."""

    def __getattr__(self, name: str) -> Any:
        raise RuntimeError("hostile attribute " + name)


def make_recorder(tracer: Any = None, metrics_recorder: Any = None) -> ToolCallRecorder:
    return ToolCallRecorder(
        resolve_options(), tracer or trace.get_tracer("opentel-mcp"), metrics_recorder, "own"
    )


@pytest.mark.parametrize(
    "info",
    [
        CallInfo(),
        CallInfo(tool_name=object(), argument_count="x", request_id=Hostile(), meta=Hostile()),  # type: ignore[arg-type]
        CallInfo(tool_name="t", argument_count=-1, request_id=lambda: 1, meta={"traceparent": 5}),
        CallInfo(tool_name="t" * 100000, meta={"traceparent": "garbage"}),
        CallInfo(tool_name="t", meta=["not", "a", "mapping"]),
    ],
    ids=["empty", "hostile", "odd-values", "huge-name", "list-meta"],
)
@pytest.mark.parametrize(
    "result",
    [
        {"content": []},
        {"isError": True},
        {"isError": True, "content": [None, 1]},
        {"isError": True, "content": [{"type": "text", "text": 5}]},
        {"isError": True, "content": [{"type": "text", "text": "x" * 1_000_000}]},
        Hostile(),
        None,
        42,
        "string",
    ],
    ids=["ok", "bare-error", "weird-content", "numeric-text", "huge-text", "hostile", "none", "int", "str"],
)
async def test_broken_inputs_never_change_the_result_or_raise(info: CallInfo, result: Any) -> None:
    async def inner() -> Any:
        return result

    assert await make_recorder().run(inner, info) is result


class HostileException(Exception):
    def __str__(self) -> str:
        raise RuntimeError("no str for you")

    @property
    def code(self) -> Any:  # type: ignore[override]
        raise RuntimeError("no code for you")


async def test_hostile_exception_is_reraised_untouched() -> None:
    exc = HostileException("x")

    async def inner() -> Any:
        raise exc

    with pytest.raises(HostileException) as info:
        await make_recorder().run(inner, CallInfo(tool_name="t"))
    assert info.value is exc


class BrokenSpan:
    def is_recording(self) -> bool:
        return True

    def __getattr__(self, name: str) -> Any:
        def boom(*a: Any, **k: Any) -> None:
            raise RuntimeError("span is broken: " + name)

        return boom


class BrokenTracer:
    def start_span(self, *a: Any, **k: Any) -> Any:
        raise RuntimeError("tracer is broken")


class SpanBrokenTracer:
    def start_span(self, *a: Any, **k: Any) -> Any:
        return BrokenSpan()


class BrokenMetrics:
    def __getattr__(self, name: str) -> Any:
        def boom(*a: Any, **k: Any) -> None:
            raise RuntimeError("metrics are broken")

        return boom


@pytest.mark.parametrize(
    "tracer", [BrokenTracer(), SpanBrokenTracer()], ids=["start_span-raises", "span-methods-raise"]
)
@pytest.mark.parametrize("metrics_recorder", [None, BrokenMetrics()], ids=["no-metrics", "broken-metrics"])
@pytest.mark.parametrize("outcome", ["ok", "silent", "raises"])
async def test_a_broken_tracer_span_or_metrics_degrade_to_one_warning(
    tracer: Any, metrics_recorder: Any, outcome: str, opentel_logs: pytest.LogCaptureFixture
) -> None:
    rec = make_recorder(tracer, metrics_recorder)
    boom = RuntimeError("tool failure")

    async def inner() -> Any:
        if outcome == "raises":
            raise boom
        return (
            {"isError": True, "content": [{"type": "text", "text": "x"}]}
            if outcome == "silent"
            else {"content": []}
        )

    for _ in range(3):
        if outcome == "raises":
            with pytest.raises(RuntimeError) as info:
                await rec.run(inner, CallInfo(tool_name="t"))
            assert info.value is boom
        else:
            assert await rec.run(inner, CallInfo(tool_name="t")) is not None
    ours = [r for r in opentel_logs.records if r.name == "opentel_mcp" and r.levelno >= logging.WARNING]
    assert 1 <= len(ours) <= 4
    assert len({r.getMessage() for r in ours}) == len(ours), (
        "each failing step is reported once, not per call"
    )
    assert all("tool failure" not in r.getMessage() for r in ours), (
        "warnings carry the exception type, never its text"
    )


@pytest.mark.parametrize(
    "server", [None, object(), 5, "server", Hostile()], ids=["none", "object", "int", "str", "hostile"]
)
def test_unsupported_servers_are_returned_untouched(
    server: Any, opentel_logs: pytest.LogCaptureFixture
) -> None:
    assert instrument_mcp_server(server) is server
    assert any(
        "nothing was instrumented" in r.getMessage() or "failed" in r.getMessage()
        for r in opentel_logs.records
    )


def test_setup_sdk_without_service_name_is_the_one_startup_error() -> None:
    with pytest.raises(ValueError, match="service_name is required"):
        instrument_mcp_server(object(), setup_sdk=True)
    with pytest.raises(ValueError):
        instrument_mcp_server(object(), setup_sdk=True, service_name="   ")


@pytest.mark.parametrize(
    "options",
    [
        {"enabled": "yes"},
        {"enable_metrics": 1},
        {"fingerprinting": []},
        {"error_recording": "full"},
        {"error_recording": {"mode": 7}},
        {"error_recording": {"mode": "normalized", "redactor": "not callable"}},
        {"sdk_tracing": None},
        {"flush_on_exit": "soon"},
        {"unknown_option": 1},
        {"exporter_url": 5},
    ],
)
async def test_invalid_options_fall_back_to_defaults_with_a_warning(
    options: dict[str, Any], telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    server, lowlevel = harness.build(harness.flavours()[-1], lambda s: instrument_mcp_server(s, **options))
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent", {})
    assert len(telemetry.tool_call_spans()) == 1
    assert [r for r in opentel_logs.records if r.name == "opentel_mcp" and r.levelno == logging.WARNING]


async def test_enormous_messages_are_bounded(telemetry: Telemetry) -> None:
    from opentel_mcp._compose import compute_fingerprint
    from opentel_mcp._recording import scrub_and_cap

    big = ("a1b2c3 " * 400_000) + "token=abc123 " * 1000
    start = time.perf_counter()
    compute_fingerprint(RuntimeError(big), tool_name="t", origin="thrown")
    capped = scrub_and_cap(big, 4096)
    assert len(capped) <= 4096 + 40
    assert time.perf_counter() - start < 5, "fingerprinting/recording must stay bounded on huge input"


def test_nothing_is_printed_by_the_library(capsys: pytest.CaptureFixture[str]) -> None:
    import contextlib

    from opentel_mcp._compose import compute_fingerprint

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        compute_fingerprint(RuntimeError("x"), tool_name="t", origin="thrown")
    assert buf.getvalue() == "" and capsys.readouterr().out == ""
