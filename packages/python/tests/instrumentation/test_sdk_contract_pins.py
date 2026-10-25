"""Pins the private mcp 2.x surface we depend on (ADR 028 Decision 7). A failure here means the SDK moved."""

from __future__ import annotations

import dataclasses
import inspect
from typing import Any

import pytest

from tests import harness

pytestmark = [pytest.mark.anyio, pytest.mark.skipif(not harness.IS_V2, reason="mcp 2.x only")]


def test_sdk_otel_middleware_class_and_signature() -> None:
    from mcp.server._otel import OpenTelemetryMiddleware

    params = list(inspect.signature(OpenTelemetryMiddleware().__call__).parameters)
    assert params == ["ctx", "call_next"]


def test_default_middleware_list_contains_the_sdk_middleware() -> None:
    from mcp.server import Server
    from mcp.server._otel import OpenTelemetryMiddleware

    async def on_call(ctx: Any, params: Any) -> Any:
        return None

    server = Server("x", on_call_tool=on_call)
    assert isinstance(server.middleware, list)
    assert any(isinstance(m, OpenTelemetryMiddleware) for m in server.middleware)


def test_mcpserver_shares_the_lowlevel_middleware_list_and_exposes_the_lowlevel_server() -> None:
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("x")
    assert server.middleware is server._lowlevel_server.middleware


def test_handler_registry_api() -> None:
    from mcp.server import Server
    from mcp.server.lowlevel.server import HandlerEntry

    assert dataclasses.is_dataclass(HandlerEntry) and HandlerEntry.__dataclass_params__.frozen  # type: ignore[attr-defined]
    assert {f.name for f in dataclasses.fields(HandlerEntry)} == {"params_type", "handler"}
    for name in ("get_request_handler", "add_request_handler"):
        assert callable(getattr(Server, name))


def test_mcpserver_call_tool_is_an_overridable_coroutine_method() -> None:
    from mcp.server.mcpserver import MCPServer

    assert inspect.iscoroutinefunction(MCPServer.call_tool)
    assert list(inspect.signature(MCPServer.call_tool).parameters)[:3] == ["self", "name", "arguments"]


async def test_unexpected_tool_error_chains_the_original_exception() -> None:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import UnexpectedToolError

    server = MCPServer("x")

    @server.tool()
    def crash() -> str:
        raise KeyError("original")

    with pytest.raises(UnexpectedToolError) as info:
        await server.call_tool("crash", {})
    assert isinstance(info.value.__cause__, KeyError)


async def test_handle_call_tool_goes_through_the_instance_attribute() -> None:
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("x")
    seen: list[str] = []
    original = server.call_tool

    async def spy(*a: Any, **k: Any) -> Any:
        seen.append(a[0])
        return await original(*a, **k)

    server.call_tool = spy  # type: ignore[method-assign]

    @server.tool()
    def t() -> str:
        return "x"

    async with harness.connect(server, server._lowlevel_server) as client:
        await client.call("t", {})
    assert seen == ["t"]
