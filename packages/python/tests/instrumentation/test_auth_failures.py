"""``mcp.tool.auth_failures`` (ADR 031): +1 per failed call classified ``auth``, label ``gen_ai.tool.name`` only."""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry import trace

from opentel_mcp import instrument_mcp_server
from opentel_mcp._config import resolve_options
from opentel_mcp._metrics import MetricsRecorder
from opentel_mcp._recorder import CallInfo, ToolCallRecorder
from tests import harness
from tests.conftest import Telemetry, py_cases
from tests.variants import SDK_TRACING_MODES, VARIANT_IDS, VARIANTS, attrs, points, total

pytestmark = pytest.mark.anyio

NAME = "mcp.tool.auth_failures"


def make(flavour: str, mode: str, **options: Any) -> tuple[Any, Any]:
    return harness.build(flavour, lambda s: instrument_mcp_server(s, sdk_tracing=mode, **options))


@pytest.fixture(params=VARIANTS, ids=VARIANT_IDS)
def variant(request: pytest.FixtureRequest) -> tuple[str, str, bool]:
    return request.param  # type: ignore[no-any-return]


async def test_silent_auth_failure_is_counted_with_only_the_tool_label(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("auth_silent", {"a": 1})
    assert out.is_error
    assert points(telemetry, NAME) == [({"gen_ai.tool.name": "auth_silent"}, 1)]
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.category"] == "auth"


async def test_raised_auth_failure_is_counted(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("auth_raises")
    assert out.is_error or out.error is not None
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.category"] == "auth"
    assert points(telemetry, NAME) == [({"gen_ai.tool.name": "auth_raises"}, 1)]


async def test_other_failures_and_successes_are_not_counted(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok")
        await client.call("silent")
        await client.call("raises")
    assert NAME not in telemetry.metric_points()


async def test_accumulates_per_call(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        for _ in range(3):
            await client.call("auth_silent")
        await client.call("auth_raises")
    assert sorted(points(telemetry, NAME), key=lambda p: p[0]["gen_ai.tool.name"]) == [
        ({"gen_ai.tool.name": "auth_raises"}, 1),
        ({"gen_ai.tool.name": "auth_silent"}, 3),
    ]


async def test_silent_when_fingerprinting_is_off_documented_limit(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], fingerprinting=False)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("auth_silent")
    assert out.is_error
    assert NAME not in telemetry.metric_points()


async def test_silent_when_metrics_are_off_and_the_call_still_works(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], enable_metrics=False)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("auth_silent")
    assert out.is_error
    assert NAME not in telemetry.metric_points()


class _Unauthorized(Exception):
    status = 401


@pytest.mark.parametrize("mode", SDK_TRACING_MODES)
async def test_genuinely_thrown_auth_failure_is_counted_and_reraised(mode: str, telemetry: Telemetry) -> None:
    server, lowlevel = harness.build_raising(
        lambda s: instrument_mcp_server(s, sdk_tracing=mode), lambda name: _Unauthorized("nope")
    )
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("t")
    assert out.error is not None  # the protocol error still reaches the client untouched
    assert points(telemetry, NAME) == [({"gen_ai.tool.name": "t"}, 1)]
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.category"] == "auth"
    assert attrs(span)["mcp.failure.origin"] == "thrown"


async def test_thrown_non_auth_is_not_counted(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build_raising(
        lambda s: instrument_mcp_server(s), lambda name: RuntimeError("something else")
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("t")
    assert NAME not in telemetry.metric_points()


async def test_nothing_from_the_call_reaches_the_metric_labels(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        await client.call("auth_silent", {"secret": harness.CANARY})
    assert harness.CANARY not in repr(telemetry.metric_points())
    assert total(telemetry, NAME) == 1


# --- shared conformance fixtures (conformance/cases/auth.json) --------------------------------------------------

AUTH_CASES = py_cases("cases/auth.json")


def _exception_from_record(record: dict[str, Any]) -> BaseException:
    exc = type(record["name"], (Exception,), {})(record["message"])
    if "code" in record:
        exc.code = record["code"]  # type: ignore[attr-defined]
    for key in ("status", "statusCode"):
        if key in record:
            exc.status = record[key]  # type: ignore[attr-defined]
    return exc


@pytest.mark.parametrize("case", AUTH_CASES, ids=lambda c: str(c["id"]))
async def test_conformance_auth_fixture(case: dict[str, Any], telemetry: Telemetry) -> None:
    options = resolve_options(fingerprinting=case["input"]["options"].get("fingerprinting", True))
    recorder = ToolCallRecorder(options, trace.get_tracer("opentel-mcp"), MetricsRecorder())

    async def call() -> Any:
        if case["input"]["kind"] == "result":
            return case["input"]["result"]
        raise _exception_from_record(case["input"]["error"])

    try:
        await recorder.run(call, CallInfo(tool_name="tool"))
    except Exception:
        assert case["input"]["kind"] == "thrown"
    assert total(telemetry, NAME) == (1 if case["expect"]["increments"] else 0)
    if total(telemetry, NAME):
        assert points(telemetry, NAME) == [({"gen_ai.tool.name": "tool"}, 1)]
    if case["expect"]["category"] is not None and case["input"]["options"].get("fingerprinting", True):
        (span,) = telemetry.tool_call_spans()
        assert attrs(span)["mcp.failure.category"] == case["expect"]["category"]
