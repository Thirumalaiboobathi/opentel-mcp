"""Runs the shared conformance suite (``/conformance``) against the Python port (ADR 028 Decision 6).

Every ``py`` case in every file must pass; a failure means the port drifted from core 0.17.0.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from opentel_mcp import _classify, _compose, _normalize, _secrets
from opentel_mcp._recording import (
    ErrorRecordingConfig,
    RecordingState,
    record_thrown_exception,
    thrown_error_type,
)
from tests.conftest import py_cases

NORMALIZE = py_cases("cases/normalize.json")
TOOL_ERROR = py_cases("cases/tool-error.json")
CHANNEL = py_cases("cases/channel.json")
CLASSIFY = py_cases("cases/classify.json")
ERROR_RECORDING = py_cases("cases/error-recording.json")


def _id(case: dict[str, Any]) -> str:
    return str(case["id"])


def test_suite_is_nontrivial() -> None:
    assert len(NORMALIZE) > 100
    assert len(TOOL_ERROR) > 100
    assert len(CHANNEL) > 20
    assert len(CLASSIFY) > 50
    assert len(ERROR_RECORDING) > 40


@pytest.mark.parametrize("case", NORMALIZE, ids=_id)
def test_normalize(case: dict[str, Any]) -> None:
    raw = case["input"]["raw"]
    assert _secrets.scrub_secrets(raw) == case["expect"]["scrubbed"]
    assert _normalize.normalize_message(raw) == case["expect"]["normalizedMessage"]


@pytest.mark.parametrize("case", TOOL_ERROR, ids=_id)
def test_tool_error(case: dict[str, Any]) -> None:
    ctx, expect = case["ctx"], case["expect"]
    fp = _compose.compute_fingerprint(
        case["input"]["result"], tool_name=ctx["toolName"], origin=ctx["origin"], cwd=ctx["cwd"]
    )
    channel = _classify.classify_failure_channel(case["input"]["result"])
    assert fp.fingerprint == expect["fingerprint"]
    assert fp.signature == expect["signature"]
    assert fp.category == expect["category"]
    assert fp.origin == expect["origin"]
    assert fp.error_class == expect["errorClass"]
    assert fp.normalized_message == expect["normalizedMessage"]
    assert fp.stack_signature == expect["stackSignature"]
    assert channel == expect["channel"]
    assert {**fp.span_attributes(), _compose.ATTR_CHANNEL: channel} == expect["attributes"]


@pytest.mark.parametrize("case", CHANNEL, ids=_id)
def test_channel(case: dict[str, Any]) -> None:
    assert _classify.classify_failure_channel(case["input"]["failure"]) == case["expect"]["channel"]


@pytest.mark.parametrize("case", CLASSIFY, ids=_id)
def test_classify(case: dict[str, Any]) -> None:
    ctx, expect = case["ctx"], case["expect"]
    fp = _compose.compute_fingerprint(
        case["input"]["error"], tool_name=ctx["toolName"], origin=ctx["origin"], cwd=ctx["cwd"]
    )
    assert fp.fingerprint == expect["fingerprint"]
    assert fp.signature == expect["signature"]
    assert fp.category == expect["category"]
    assert fp.error_class == expect["errorClass"]
    assert fp.normalized_message == expect["normalizedMessage"]
    assert fp.stack_signature == expect["stackSignature"]
    assert _classify.classify_failure_channel(case["input"]["error"]) == expect["channel"]


@pytest.mark.parametrize("case", ERROR_RECORDING, ids=_id)
def test_error_recording(case: dict[str, Any]) -> None:
    mode, error = case["input"]["mode"], case["input"]["error"]
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    span = provider.get_tracer("t").start_span("s")
    record = {
        "name": error["name"],
        "message": error["message"],
        "stack": error["stack"],
        "code": error["code"],
    }
    record_thrown_exception(span, record, ErrorRecordingConfig(mode=mode), RecordingState())
    span.end()
    (finished,) = exporter.get_finished_spans()
    events = [e for e in finished.events if e.name == "exception"]
    attrs = dict(events[0].attributes or {}) if events else None
    event = None
    if attrs is not None:
        event = {"type": attrs.get("exception.type"), "message": attrs.get("exception.message")}
        if mode == "full":
            event["stacktrace"] = attrs.get("exception.stacktrace")
    status = finished.status
    assert thrown_error_type(record) == case["expect"]["errorType"]
    assert status.status_code is StatusCode.ERROR
    assert status.description == case["expect"]["statusMessage"]
    assert event == case["expect"]["event"]


THROWN_PY = py_cases("cases/thrown.py.json")


@pytest.mark.parametrize("case", THROWN_PY, ids=_id)
def test_thrown_python_stack_signatures(case: dict[str, Any]) -> None:
    ctx, expect = case["ctx"], case["expect"]
    err = case["input"]["error"]
    fp = _compose.compute_fingerprint(
        err, tool_name=ctx["toolName"], origin=ctx["origin"], cwd=ctx["cwd"], stdlib=tuple(ctx["stdlib"])
    )
    assert fp.stack_signature == expect["stackSignature"]
    assert fp.signature == expect["signature"]
    assert fp.category == expect["category"]
    assert fp.error_class == expect["errorClass"]
    assert fp.normalized_message == expect["normalizedMessage"]
    assert fp.fingerprint == expect["fingerprint"]


def test_cwd_default_is_the_process_cwd() -> None:
    cwd = os.getcwd()
    err = {"name": "E", "message": "m", "frames": [{"filename": cwd + "/x.py", "lineno": 3, "name": "f"}]}
    assert _compose.compute_fingerprint(err, tool_name="t", origin="thrown").stack_signature == "f@x.py:3"
