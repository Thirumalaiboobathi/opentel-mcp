"""mcp 1.x specifics: the wrapping ``request_handlers`` dict, registration order, the FastMCP private attribute."""

from __future__ import annotations

from typing import Any

import pytest

from opentel_mcp import _adapters, instrument_mcp_server
from tests import harness
from tests.conftest import Telemetry

pytestmark = [pytest.mark.anyio, pytest.mark.skipif(harness.IS_V2, reason="mcp 1.x only")]


def _server() -> Any:
    from mcp.server.lowlevel import Server

    return Server("x")


def test_request_handlers_becomes_a_wrapping_dict_subclass() -> None:
    server = _server()
    original = server.request_handlers
    instrument_mcp_server(server)
    assert isinstance(server.request_handlers, _adapters._HandlerDict)
    assert dict(server.request_handlers).keys() == dict(original).keys()  # every pre-existing handler is kept


def test_a_handler_registered_later_is_wrapped_by_the_decorator_and_by_direct_assignment() -> None:
    from mcp import types

    server = _server()
    instrument_mcp_server(server)

    @server.call_tool(validate_input=False)
    async def decorated(name: str, arguments: dict[str, Any]) -> Any:
        return []

    assert _adapters._is_wrapped(server.request_handlers[types.CallToolRequest])

    async def raw(req: Any) -> Any:
        return None

    server.request_handlers[types.CallToolRequest] = raw
    wrapped = server.request_handlers[types.CallToolRequest]
    assert wrapped is not raw and _adapters._is_wrapped(wrapped)
    server.request_handlers[types.CallToolRequest] = wrapped  # already wrapped: not wrapped twice
    assert server.request_handlers[types.CallToolRequest] is wrapped


def test_update_and_setdefault_also_wrap_and_other_keys_are_untouched() -> None:
    from mcp import types

    server = _server()
    instrument_mcp_server(server)

    async def raw(req: Any) -> Any:
        return None

    server.request_handlers.update({types.CallToolRequest: raw})
    assert _adapters._is_wrapped(server.request_handlers[types.CallToolRequest])

    async def other(req: Any) -> Any:
        return None

    server.request_handlers[types.ListToolsRequest] = other
    assert server.request_handlers[types.ListToolsRequest] is other


async def test_no_double_spans_when_the_handler_is_registered_before_and_after_instrumenting(
    telemetry: Telemetry,
) -> None:
    for flavour in ("lowlevel", "lowlevel-late"):
        server, lowlevel = harness.build(flavour, lambda s: instrument_mcp_server(s))
        async with harness.connect(server, lowlevel) as client:
            await client.call("ok", {})
    assert len(telemetry.tool_call_spans()) == 2  # one per call, one call per server


def test_fastmcp_exposes_the_private_lowlevel_server_we_hook() -> None:
    """Contract pin (ADR 028): ``FastMCP._mcp_server`` is a private attribute we rely on."""
    from mcp.server.fastmcp import FastMCP
    from mcp.server.lowlevel import Server

    mcp = FastMCP("pin")
    assert isinstance(mcp._mcp_server, Server)
    assert isinstance(mcp._mcp_server.request_handlers, dict)


def test_lowlevel_request_context_property_exists() -> None:
    from mcp.server.lowlevel import Server

    assert isinstance(Server.request_context, property)  # source of jsonrpc.request.id on 1.x


async def test_request_id_is_a_string_and_the_sync_tool_sees_our_span(telemetry: Telemetry) -> None:
    server, lowlevel = harness.build("fastmcp", lambda s: instrument_mcp_server(s))
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("span_name", {})
    assert out.texts == [
        "tools/call span_name"
    ]  # a sync tool (worker thread, copied context) has our span current
    (span,) = telemetry.tool_call_spans()
    assert isinstance(dict(span.attributes)["jsonrpc.request.id"], str)


def test_sdk_tracing_is_ignored_on_1x() -> None:
    server = _server()
    assert instrument_mcp_server(server, sdk_tracing="enrich") is server
