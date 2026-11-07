"""Shared auth-classification fixtures (``auth.json``): does a failed call increment ``mcp.tool.auth_failures``? (ADR 031)

Drives the recorder directly with a result or a raised exception, so no mcp SDK is needed.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry import trace

from opentel_mcp._config import resolve_options
from opentel_mcp._metrics import MetricsRecorder
from opentel_mcp._recorder import CallInfo, ToolCallRecorder
from tests.conftest import Telemetry, py_cases

pytestmark = pytest.mark.anyio

NAME = "mcp.tool.auth_failures"
AUTH_CASES = py_cases("cases/auth.json")


def _total(tel: Telemetry) -> int:
    return int(sum(v for _, v in tel.metric_points().get(NAME, [])))


def test_suite_is_nontrivial() -> None:
    assert len(AUTH_CASES) > 40


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
    assert _total(telemetry) == (1 if case["expect"]["increments"] else 0)
    if _total(telemetry):
        assert telemetry.metric_points()[NAME] == [({"gen_ai.tool.name": "tool"}, 1)]
    if case["expect"]["category"] is not None and case["input"]["options"].get("fingerprinting", True):
        (span,) = telemetry.tool_call_spans()
        assert dict(span.attributes or {})["mcp.failure.category"] == case["expect"]["category"]
