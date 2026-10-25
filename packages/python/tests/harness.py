"""Builds comparable MCP servers across mcp 1.x and 2.x, and calls them through the SDK's in-memory transport."""

from __future__ import annotations

import contextlib
import importlib.metadata
import importlib.util
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

IS_V2 = importlib.util.find_spec("mcp_types") is not None
MCP_VERSION = importlib.metadata.version("mcp")

SILENT_TEXT = "invalid input: missing field 'email' 12345"
RAISE_MESSAGE = "boom 42 token=abc123"
CANARY = "CANARY-7f3a91c2-must-never-be-captured"
TOOL_NAMES = ("ok", "silent", "raises", "echo", "span_name", "leak", "leak_err")
INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"secret": {"type": "string"}, "a": {"type": "integer"}},
}


@dataclass
class Outcome:
    is_error: bool = False
    texts: list[str] = field(default_factory=list)
    error: Exception | None = None


def flavours() -> list[str]:
    if IS_V2:
        return ["lowlevel", "mcpserver"]
    return ["lowlevel", "lowlevel-late", "fastmcp"]


# --------------------------------------------------------------------------------------------------------------
# mcp 1.x servers
# --------------------------------------------------------------------------------------------------------------


def _build_v1(flavour: str, instrument: Any) -> tuple[Any, Any]:
    from mcp import types

    if flavour == "fastmcp":
        from mcp.server.fastmcp import FastMCP

        server = FastMCP("under-test")

        @server.tool()
        def ok(a: int = 0) -> str:
            return "fine"

        @server.tool()
        def silent() -> Any:
            # FastMCP 1.x only reliably turns an exception into isError (a returned CallToolResult is
            # re-wrapped before mcp 1.30), so the silent failure here is a ToolError.
            from mcp.server.fastmcp.exceptions import ToolError

            raise ToolError(SILENT_TEXT)

        @server.tool()
        def raises() -> str:
            raise RuntimeError(RAISE_MESSAGE)

        @server.tool()
        def echo(secret: str = "") -> str:
            return "ok"

        @server.tool()
        def span_name() -> str:
            from opentelemetry import trace

            return str(getattr(trace.get_current_span(), "name", ""))

        @server.tool()
        def leak() -> str:
            return f"result {CANARY}"

        @server.tool()
        def leak_err() -> Any:
            from mcp.server.fastmcp.exceptions import ToolError

            raise ToolError(f"invalid {CANARY}")

        instrument(server)
        return server, server._mcp_server

    from mcp.server.lowlevel import Server

    server = Server("under-test")
    if flavour == "lowlevel":
        instrument(server)  # before any handler is registered: registration order must not matter on 1.x

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [types.Tool(name=n, description=n, inputSchema=INPUT_SCHEMA) for n in TOOL_NAMES]

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> Any:
        if name == "silent":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=SILENT_TEXT)], isError=True
            )
        if name == "raises":
            raise RuntimeError(RAISE_MESSAGE)
        if name == "leak_err":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"invalid {CANARY}")], isError=True
            )
        if name == "leak":
            return [types.TextContent(type="text", text=f"result {CANARY}")]
        if name == "span_name":
            from opentelemetry import trace

            return [types.TextContent(type="text", text=str(getattr(trace.get_current_span(), "name", "")))]
        return [types.TextContent(type="text", text="fine")]

    if flavour == "lowlevel-late":
        instrument(server)
    return server, server


# --------------------------------------------------------------------------------------------------------------
# mcp 2.x servers
# --------------------------------------------------------------------------------------------------------------


def _build_v2(flavour: str, instrument: Any, *, remove_sdk_middleware: bool = False) -> tuple[Any, Any]:
    import mcp_types as types

    if flavour == "mcpserver":
        from mcp.server.mcpserver import MCPServer

        server = MCPServer("under-test")

        @server.tool()
        def ok(a: int = 0) -> str:
            return "fine"

        @server.tool()
        def silent() -> Any:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=SILENT_TEXT)], is_error=True
            )

        @server.tool()
        def raises() -> str:
            raise RuntimeError(RAISE_MESSAGE)

        @server.tool()
        async def echo(secret: str = "") -> str:
            return "ok"

        @server.tool()
        def span_name() -> str:
            from opentelemetry import trace

            return str(getattr(trace.get_current_span(), "name", ""))

        @server.tool()
        def leak() -> str:
            return f"result {CANARY}"

        @server.tool()
        def leak_err() -> Any:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"invalid {CANARY}")], is_error=True
            )

        lowlevel = server._lowlevel_server
        if remove_sdk_middleware:
            lowlevel.middleware[:] = [
                m for m in lowlevel.middleware if type(m).__name__ != "OpenTelemetryMiddleware"
            ]
        instrument(server)
        return server, lowlevel

    from mcp.server import Server

    async def on_list_tools(ctx: Any, params: Any) -> Any:
        return types.ListToolsResult(
            tools=[types.Tool(name=n, description=n, input_schema=INPUT_SCHEMA) for n in TOOL_NAMES]
        )

    async def on_call_tool(ctx: Any, params: Any) -> Any:
        name = params.name
        if name == "silent":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=SILENT_TEXT)], is_error=True
            )
        if name == "raises":
            raise RuntimeError(RAISE_MESSAGE)
        if name == "leak_err":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"invalid {CANARY}")], is_error=True
            )
        if name == "leak":
            return types.CallToolResult(content=[types.TextContent(type="text", text=f"result {CANARY}")])
        if name == "span_name":
            from opentelemetry import trace

            return types.CallToolResult(
                content=[
                    types.TextContent(type="text", text=str(getattr(trace.get_current_span(), "name", "")))
                ]
            )
        return types.CallToolResult(content=[types.TextContent(type="text", text="fine")])

    lowlevel = Server("under-test", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
    if remove_sdk_middleware:
        lowlevel.middleware[:] = [
            m for m in lowlevel.middleware if type(m).__name__ != "OpenTelemetryMiddleware"
        ]
    instrument(lowlevel)
    return lowlevel, lowlevel


def build(flavour: str, instrument: Any, *, remove_sdk_middleware: bool = False) -> tuple[Any, Any]:
    """``(server, lowlevel_server)``; ``instrument(server)`` is called at the flavour's natural point."""
    if IS_V2:
        return _build_v2(flavour, instrument, remove_sdk_middleware=remove_sdk_middleware)
    return _build_v1(flavour, instrument)


# --------------------------------------------------------------------------------------------------------------
# calling
# --------------------------------------------------------------------------------------------------------------


class Client:
    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def call(
        self, name: str, arguments: dict[str, Any] | None = None, *, meta: dict[str, Any] | None = None
    ) -> Outcome:
        try:
            result = await self._inner.call_tool(name, arguments or {}, meta=meta)
        except Exception as exc:
            return Outcome(error=exc)
        is_error = bool(getattr(result, "is_error", None) if IS_V2 else getattr(result, "isError", False))
        texts = [getattr(c, "text", "") for c in getattr(result, "content", []) or []]
        return Outcome(is_error=is_error, texts=texts)

    async def list_tools(self) -> Any:
        return await self._inner.list_tools()

    @property
    def inner(self) -> Any:
        return self._inner


@contextlib.asynccontextmanager
async def connect(server: Any, lowlevel: Any) -> AsyncIterator[Client]:
    if IS_V2:
        from mcp import Client as McpClient

        async with McpClient(server) as client:
            yield Client(client)
    else:
        from mcp.shared.memory import create_connected_server_and_client_session

        async with create_connected_server_and_client_session(
            server._mcp_server if hasattr(server, "_mcp_server") else server
        ) as session:
            yield Client(session)


def build_raising(instrument: Any, make_exc: Any, *, remove_sdk_middleware: bool = False) -> tuple[Any, Any]:
    """A low-level server whose ``tools/call`` handler raises ``make_exc(name)`` (the genuinely *thrown* path)."""
    if IS_V2:
        import mcp_types as types
        from mcp.server import Server

        async def on_call_tool(ctx: Any, params: Any) -> Any:
            raise make_exc(params.name)

        async def on_list_tools(ctx: Any, params: Any) -> Any:
            return types.ListToolsResult(
                tools=[types.Tool(name="t", description="t", input_schema=INPUT_SCHEMA)]
            )

        lowlevel = Server("raising", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
        if remove_sdk_middleware:
            lowlevel.middleware[:] = [
                m for m in lowlevel.middleware if type(m).__name__ != "OpenTelemetryMiddleware"
            ]
        instrument(lowlevel)
        return lowlevel, lowlevel

    from mcp import types
    from mcp.server.lowlevel import Server

    server = Server("raising")
    instrument(server)

    async def raw(req: Any) -> Any:  # a raw handler, so nothing converts the exception into isError
        raise make_exc(req.params.name)

    server.request_handlers[types.CallToolRequest] = raw  # goes through the wrapping dict

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [types.Tool(name="t", description="t", inputSchema=INPUT_SCHEMA)]

    return server, server
