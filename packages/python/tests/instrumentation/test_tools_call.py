"""Span and metric behaviour of an instrumented server, on every supported mcp flavour."""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.trace import SpanKind, StatusCode

from opentel_mcp import instrument_mcp_server
from tests import harness
from tests.conftest import Telemetry

pytestmark = pytest.mark.anyio

SDK_TRACING_MODES = ["replace", "enrich"] if harness.IS_V2 else ["replace"]


def _variants() -> list[tuple[str, str, bool]]:
    out = []
    for flavour in harness.flavours():
        for mode in SDK_TRACING_MODES:
            out.append((flavour, mode, False))
        if harness.IS_V2:
            out.append((flavour, "replace", True))  # SDK middleware already removed by the user
    return out


VARIANTS = _variants()
VARIANT_IDS = [f"{f}-{m}{'-sdk_removed' if r else ''}" for f, m, r in VARIANTS]


def make(flavour: str, mode: str, removed: bool, **options: Any) -> tuple[Any, Any]:
    kwargs = {"sdk_tracing": mode, **options}
    return harness.build(flavour, lambda s: instrument_mcp_server(s, **kwargs), remove_sdk_middleware=removed)


def attrs(span: Any) -> dict[str, Any]:
    return dict(span.attributes or {})


def points(tel: Telemetry, name: str) -> list[tuple[dict[str, Any], Any]]:
    return tel.metric_points().get(name, [])


@pytest.fixture(params=VARIANTS, ids=VARIANT_IDS)
def variant(request: pytest.FixtureRequest) -> tuple[str, str, bool]:
    return request.param  # type: ignore[no-any-return]


async def test_success_path(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("ok", {"a": 1})
    assert not out.is_error
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert span.name == "tools/call ok"
    assert span.kind == SpanKind.SERVER
    if span.instrumentation_scope.name == "opentel-mcp":  # ours (not the SDK's span, which "enrich" keeps)
        from opentel_mcp import __version__

        assert span.instrumentation_scope.version == __version__ == "0.1.0"
    assert a["mcp.method.name"] == "tools/call"
    assert a["gen_ai.operation.name"] == "execute_tool"
    assert a["gen_ai.tool.name"] == "ok"
    assert a["mcp.tool.argument_count"] == 1 and isinstance(a["mcp.tool.argument_count"], int)
    assert isinstance(a["jsonrpc.request.id"], str)
    assert span.status.status_code == StatusCode.OK
    assert "error.type" not in a
    assert not any(k.startswith("mcp.failure.") for k in a)
    assert sum(v for _, v in points(telemetry, "mcp.tool.calls")) == 1
    (dur,) = points(telemetry, "mcp.tool.duration")
    assert dur[0]["mcp.tool.outcome"] == "success" and dur[0]["gen_ai.tool.name"] == "ok"
    assert "mcp.tool.silent_failures" not in telemetry.metric_points()


async def test_silent_failure_is_an_error_span_with_tool_error(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("silent", {})
    assert out.is_error and out.error is None
    (span,) = telemetry.tool_call_spans()  # exactly one tools/call span in every mode
    a = attrs(span)
    assert span.status.status_code == StatusCode.ERROR
    assert a["error.type"] == "tool_error"
    assert a["mcp.failure.category"] == "validation"
    assert a["mcp.failure.origin"] == "tool_error"
    assert a["mcp.failure.error_class"] == "MCPToolError"
    assert a["mcp.failure.channel"] == "execution"
    assert a["mcp.failure.signature"] == "MCPToolError@anon:?"
    assert len(a["mcp.failure.fingerprint"]) == 16
    (sf,) = points(telemetry, "mcp.tool.silent_failures")
    assert sf[0] == {"gen_ai.tool.name": "silent", "mcp.failure.category": "validation"} and sf[1] == 1
    (dur,) = points(telemetry, "mcp.tool.duration")
    assert dur[0]["mcp.tool.outcome"] == "silent_failure"
    assert "mcp.tool.errors" not in telemetry.metric_points()


async def test_silent_failure_fingerprint_equals_the_shared_suite_value(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    from opentel_mcp._compose import compute_fingerprint

    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("silent", {})
    expected = compute_fingerprint(
        {"isError": True, "content": [{"type": "text", "text": out.texts[0]}]},
        tool_name="silent",
        origin="tool_error",
    )
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.failure.fingerprint"] == expected.fingerprint


async def test_tool_that_raises_becomes_a_silent_failure_on_high_level_servers(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    flavour = variant[0]
    if harness.IS_V2 and flavour == "lowlevel":
        pytest.skip("a 2.x low-level handler's exception propagates; covered by the thrown-path tests")
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("raises", {})
    assert out.is_error
    (span,) = telemetry.tool_call_spans()
    assert span.status.status_code == StatusCode.ERROR
    assert attrs(span)["error.type"] == "tool_error"
    assert len(points(telemetry, "mcp.tool.silent_failures")) == 1


async def test_current_span_inside_a_tool_is_the_single_tools_call_span(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("span_name", {})
    assert out.texts == ["tools/call span_name"]
    assert len(telemetry.tool_call_spans()) == 1


async def test_instrumentation_does_not_change_the_result(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    plain_server, plain_low = harness.build(variant[0], lambda s: None)
    server, lowlevel = make(*variant)
    for name in ("ok", "silent", "raises", "echo"):
        async with harness.connect(plain_server, plain_low) as c1:
            expected = await c1.call(name, {"secret": "x"})
        async with harness.connect(server, lowlevel) as c2:
            actual = await c2.call(name, {"secret": "x"})
        assert (actual.is_error, actual.texts, type(actual.error)) == (
            expected.is_error,
            expected.texts,
            type(expected.error),
        )


async def test_trace_context_from_meta_parents_the_span(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    parent = "b7ad6b7169203331"
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        await client.call("ok", {}, meta={"traceparent": f"00-{trace_id}-{parent}-01"})
    (span,) = telemetry.tool_call_spans()
    assert format(span.context.trace_id, "032x") == trace_id
    assert span.parent is not None and format(span.parent.span_id, "016x") == parent


async def test_list_tools_is_untouched(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(*variant)
    async with harness.connect(server, lowlevel) as client:
        tools = await client.list_tools()
    assert {t.name for t in tools.tools} >= {"ok", "silent", "raises"}
    assert telemetry.tool_call_spans() == []
    assert telemetry.metric_points().get("mcp.tool.calls") is None


async def test_enable_metrics_false_records_no_metrics(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build(
        harness.flavours()[-1], lambda s: instrument_mcp_server(s, enable_metrics=False)
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent", {})
    assert telemetry.metric_points() == {}
    assert len(telemetry.tool_call_spans()) == 1


async def test_fingerprinting_false_omits_failure_attributes_and_the_category_label(
    telemetry: Telemetry,
) -> None:
    server, lowlevel = harness.build(
        harness.flavours()[-1], lambda s: instrument_mcp_server(s, fingerprinting=False)
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent", {})
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert a["error.type"] == "tool_error"
    assert not any(k.startswith("mcp.failure.") for k in a)
    (sf,) = points(telemetry, "mcp.tool.silent_failures")
    assert sf[0] == {"gen_ai.tool.name": "silent"}


async def test_enabled_false_is_a_no_op(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build(
        harness.flavours()[-1], lambda s: instrument_mcp_server(s, enabled=False)
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("silent", {})
    assert [s for s in telemetry.tool_call_spans() if s.instrumentation_scope.name == "opentel-mcp"] == []
    assert telemetry.metric_points() == {}
