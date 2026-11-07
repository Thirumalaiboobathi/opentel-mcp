"""Sensitive tool auditing (ADR 032): ``mcp.tool.sensitive`` and the ``mcp.audit.sensitive_call`` event."""

from __future__ import annotations

import logging
import time
from typing import Any

import pytest

from opentel_mcp import instrument_mcp_server
from opentel_mcp._config import _warn_once, resolve_options
from opentel_mcp._sensitive import compile_sensitive_tools
from tests import harness
from tests.conftest import Telemetry, py_cases
from tests.variants import SDK_TRACING_MODES, VARIANT_IDS, VARIANTS, attrs

pytestmark = pytest.mark.anyio

EVENT = "mcp.audit.sensitive_call"


def make(flavour: str, mode: str, **options: Any) -> tuple[Any, Any]:
    return harness.build(flavour, lambda s: instrument_mcp_server(s, sdk_tracing=mode, **options))


def events(span: Any, name: str = EVENT) -> list[dict[str, Any]]:
    return [dict(e.attributes or {}) for e in span.events if e.name == name]


@pytest.fixture(params=VARIANTS, ids=VARIANT_IDS)
def variant(request: pytest.FixtureRequest) -> tuple[str, str, bool]:
    return request.param  # type: ignore[no-any-return]


# --- shared conformance fixtures --------------------------------------------------------------------------------

SENSITIVE_CASES = py_cases("cases/sensitive-tools.json")


@pytest.mark.parametrize("case", SENSITIVE_CASES, ids=lambda c: str(c["id"]))
def test_conformance_sensitive_matching(case: dict[str, Any]) -> None:
    matcher = compile_sensitive_tools(case["input"]["patterns"], lambda *a, **k: None)
    actual = {
        "size": 0 if matcher is None else matcher.size,
        "matches": [False if matcher is None else matcher.matches(n) for n in case["input"]["names"]],
    }
    assert actual == case["expect"]


# --- the matcher: adversarial input -------------------------------------------------------------------------------


def test_matcher_is_linear_not_a_regex() -> None:
    patterns = ["*a" * 100 + "b"] * 1000
    matcher = compile_sensitive_tools(patterns, lambda *a, **k: None)
    assert matcher is not None
    started = time.perf_counter()
    for name in ("a" * 1024, "a" * 1025, ("a" * 500) + "b", "(a+)+$" + "a" * 1000):
        matcher.matches(name)
    assert time.perf_counter() - started < 2.0


def test_regex_metacharacters_are_literal() -> None:
    matcher = compile_sensitive_tools(["(a+)+$", "a.c", "[x]"], lambda *a, **k: None)
    assert matcher is not None
    assert matcher.matches("(a+)+$") and matcher.matches("a.c") and matcher.matches("[x]")
    assert not matcher.matches("aaaa") and not matcher.matches("abc") and not matcher.matches("x")


def test_matching_counts_utf16_code_units_like_js() -> None:
    # 128 astral characters are 256 UTF-16 units (allowed) but 128 code points; 129 are 258 units (skipped).
    ok = "\U0001f680" * 128
    too_long = "\U0001f680" * 129
    matcher = compile_sensitive_tools([ok, too_long], lambda *a, **k: None)
    assert matcher is not None and matcher.size == 1
    assert matcher.matches(ok) and not matcher.matches(too_long)


def test_non_string_names_never_match() -> None:
    matcher = compile_sensitive_tools(["*"], lambda *a, **k: None)
    assert matcher is not None
    assert not any(matcher.matches(n) for n in (None, 1, b"x", ["a"], {"a": 1}))


# --- option handling ----------------------------------------------------------------------------------------------


def test_invalid_entries_warn_once_without_echoing_values(opentel_logs: pytest.LogCaptureFixture) -> None:
    secret_like = "sk-" + "a" * 30
    for _ in range(3):
        resolve_options(sensitive_tools=["ok", "", 5, None, {"k": secret_like}, "x" * 300])
    warnings = [r for r in opentel_logs.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    text = warnings[0].getMessage()
    assert secret_like not in text and "xxxx" not in text
    assert "sensitive_tools" in text


def test_non_list_option_warns_once_and_is_ignored(opentel_logs: pytest.LogCaptureFixture) -> None:
    options = resolve_options(sensitive_tools="delete_record")
    resolve_options(sensitive_tools={"a": 1})
    assert options.sensitive is None
    assert len([r for r in opentel_logs.records if "sensitive_tools must be a list" in r.getMessage()]) == 1


def test_a_hostile_sequence_does_not_raise(opentel_logs: pytest.LogCaptureFixture) -> None:
    class Hostile(list):  # type: ignore[type-arg]
        def __iter__(self) -> Any:
            raise RuntimeError("boom")

        def __getitem__(self, key: Any) -> Any:
            raise RuntimeError("boom")

    assert compile_sensitive_tools(Hostile(["a"]), _warn_once) is None


def test_over_1000_entries_are_ignored_with_one_warning(opentel_logs: pytest.LogCaptureFixture) -> None:
    options = resolve_options(sensitive_tools=[f"tool_{i}" for i in range(1005)])
    assert options.sensitive is not None and options.sensitive.size == 1000
    assert options.sensitive.matches("tool_999") and not options.sensitive.matches("tool_1000")
    assert len([r for r in opentel_logs.records if r.levelno == logging.WARNING]) == 1


def test_default_is_off() -> None:
    assert resolve_options().sensitive is None
    assert resolve_options(sensitive_tools=[]).sensitive is None


# --- outcomes on every path, on both SDK lines ----------------------------------------------------------------------


async def test_success_is_audited(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["ok"])
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok", {"a": 1})
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.tool.sensitive"] is True
    (event,) = events(span)
    assert set(event) == {"gen_ai.tool.name", "mcp.tool.outcome", "mcp.tool.duration_ms"}
    assert event["gen_ai.tool.name"] == "ok" and event["mcp.tool.outcome"] == "success"
    assert isinstance(event["mcp.tool.duration_ms"], float) and event["mcp.tool.duration_ms"] >= 0


async def test_silent_failure_is_audited_with_the_category(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["sil*"])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("silent")
    assert out.is_error
    (span,) = telemetry.tool_call_spans()
    (event,) = events(span)
    assert event["mcp.tool.outcome"] == "silent_failure"
    assert event["mcp.failure.category"] == attrs(span)["mcp.failure.category"]


async def test_raised_failure_is_audited(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["raises", "auth_*"])
    async with harness.connect(server, lowlevel) as client:
        await client.call("raises")
        await client.call("auth_raises")
    by_tool = {}
    for span in telemetry.tool_call_spans():
        (event,) = events(span)
        by_tool[event["gen_ai.tool.name"]] = event
    # FastMCP / MCPServer turn the exception into an isError result (silent); a low-level handler's escapes (error).
    assert by_tool["raises"]["mcp.tool.outcome"] in ("silent_failure", "error")
    assert by_tool["auth_raises"]["mcp.failure.category"] == "auth"


@pytest.mark.parametrize("mode", SDK_TRACING_MODES)
async def test_genuinely_thrown_call_is_audited_and_reraised(mode: str, telemetry: Telemetry) -> None:
    server, lowlevel = harness.build_raising(
        lambda s: instrument_mcp_server(s, sdk_tracing=mode, sensitive_tools=["t"]),
        lambda name: RuntimeError("kaput"),
    )
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("t")
    assert out.error is not None
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.tool.sensitive"] is True
    (event,) = events(span)
    assert event["mcp.tool.outcome"] == "error" and event["mcp.failure.category"] == "internal"


async def test_no_category_when_fingerprinting_is_off(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["silent"], fingerprinting=False)
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent")
    (span,) = telemetry.tool_call_spans()
    (event,) = events(span)
    assert event["mcp.tool.outcome"] == "silent_failure" and "mcp.failure.category" not in event


async def test_non_matching_and_default_have_no_marker_and_no_event(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["delete_*"])
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok")
    server2, lowlevel2 = make(variant[0], variant[1])
    async with harness.connect(server2, lowlevel2) as client:
        await client.call("ok")
    spans = telemetry.tool_call_spans()
    assert len(spans) == 2
    for span in spans:
        assert "mcp.tool.sensitive" not in attrs(span) and events(span) == []


async def test_only_matching_tools_in_a_mixed_session_are_marked(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["silent", "echo"])
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok")
        await client.call("echo")
        await client.call("silent")
    marked = {
        attrs(s)["gen_ai.tool.name"]: attrs(s).get("mcp.tool.sensitive") for s in telemetry.tool_call_spans()
    }
    assert marked == {"ok": None, "echo": True, "silent": True}


async def test_exactly_one_event_per_call(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["*"])
    async with harness.connect(server, lowlevel) as client:
        for _ in range(3):
            await client.call("silent")
    assert [len(events(s)) for s in telemetry.tool_call_spans()] == [1, 1, 1]


# --- canary: derived signals only ---------------------------------------------------------------------------------


async def test_canary_in_arguments_and_errors_never_reaches_the_audit(
    variant: tuple[str, str, bool], telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["leak_err", "echo", "leak"])
    async with harness.connect(server, lowlevel) as client:
        await client.call("echo", {"secret": harness.CANARY})
        await client.call("leak")
        await client.call("leak_err", {"secret": harness.CANARY})
    for span in telemetry.tool_call_spans():
        for event in events(span):
            assert harness.CANARY not in repr(event)
            assert set(event) <= {
                "gen_ai.tool.name",
                "mcp.tool.outcome",
                "mcp.tool.duration_ms",
                "mcp.failure.category",
            }
    assert harness.CANARY not in repr(telemetry.metric_points())
    assert harness.CANARY not in opentel_logs.text
    assert harness.CANARY not in repr(
        [dict(e.attributes or {}) for s in telemetry.tool_call_spans() for e in s.events if e.name == EVENT]
    )
