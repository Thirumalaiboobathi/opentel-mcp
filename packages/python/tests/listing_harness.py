"""Servers whose ``tools/list`` answer the test can change, on every mcp flavour (tool integrity tests)."""

from __future__ import annotations

from typing import Any

from tests import harness

PAGE_SIZE_ALL = 0


class Served:
    """A running server + the knobs to change what ``tools/list`` returns."""

    def __init__(self, flavour: str, server: Any, lowlevel: Any, state: dict[str, Any]) -> None:
        self.flavour = flavour
        self.server = server
        self.lowlevel = lowlevel
        self._state = state

    @property
    def high_level(self) -> bool:
        return self.flavour in ("fastmcp", "mcpserver")

    # -- mutations ---------------------------------------------------------------------------------------------

    def set_description(self, name: str, text: str) -> None:
        if self.high_level:
            self.server._tool_manager.get_tool(name).description = text
        else:
            for t in self._state["tools"]:
                if t["name"] == name:
                    t["description"] = text

    def add_tool(self, name: str, description: str = "added") -> None:
        if self.high_level:

            def fn() -> str:
                return "x"

            self.server.add_tool(fn, name=name, description=description)
        else:
            self._state["tools"].append(_definition(name, description))

    def remove_tool(self, name: str) -> None:
        if self.high_level:
            self.server.remove_tool(name)
        else:
            self._state["tools"][:] = [t for t in self._state["tools"] if t["name"] != name]

    def set_page_size(self, n: int) -> None:
        self._state["page"] = n

    def names(self) -> list[str]:
        if self.high_level:
            return [t.name for t in self.server._tool_manager.list_tools()]
        return [t["name"] for t in self._state["tools"]]


def _definition(name: str, description: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": {"x": {"type": "integer"}}},
    }


def flavours() -> list[str]:
    return ["lowlevel", "fastmcp"] if not harness.IS_V2 else ["lowlevel", "mcpserver"]


def build(flavour: str, instrument: Any, tool_names: tuple[str, ...] = ("alpha", "beta")) -> Served:
    state: dict[str, Any] = {
        "tools": [_definition(n, f"tool {n}") for n in tool_names],
        "page": PAGE_SIZE_ALL,
    }
    if flavour == "fastmcp":
        from mcp.server.fastmcp import FastMCP

        server = FastMCP("under-test")
        for n in tool_names:
            _register_high_level(server, n)
        instrument(server)
        return Served(flavour, server, server._mcp_server, state)
    if flavour == "mcpserver":
        from mcp.server.mcpserver import MCPServer

        server = MCPServer("under-test")
        for n in tool_names:
            _register_high_level(server, n)
        instrument(server)
        return Served(flavour, server, server._lowlevel_server, state)

    def page(cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
        tools = state["tools"]
        size = state["page"]
        if not size:
            return list(tools), None
        start = int(cursor) if cursor else 0
        end = start + size
        return tools[start:end], (str(end) if end < len(tools) else None)

    if harness.IS_V2:
        import mcp_types as types
        from mcp.server import Server

        async def on_list_tools(ctx: Any, params: Any) -> Any:
            chunk, nxt = page(getattr(params, "cursor", None))
            return types.ListToolsResult(
                tools=[
                    types.Tool(name=t["name"], description=t["description"], input_schema=t["inputSchema"])
                    for t in chunk
                ],
                next_cursor=nxt,
            )

        async def on_call_tool(ctx: Any, params: Any) -> Any:
            return types.CallToolResult(content=[types.TextContent(type="text", text="ok")])

        lowlevel = Server("under-test", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
        instrument(lowlevel)
        return Served(flavour, lowlevel, lowlevel, state)

    from mcp import types
    from mcp.server.lowlevel import Server

    server = Server("under-test")
    instrument(server)  # registration order must not matter on 1.x

    async def list_handler(req: Any) -> Any:
        chunk, nxt = page(getattr(getattr(req, "params", None), "cursor", None))
        return types.ServerResult(
            types.ListToolsResult(
                tools=[
                    types.Tool(name=t["name"], description=t["description"], inputSchema=t["inputSchema"])
                    for t in chunk
                ],
                nextCursor=nxt,
            )
        )

    async def call_handler(req: Any) -> Any:
        return types.ServerResult(types.CallToolResult(content=[types.TextContent(type="text", text="ok")]))

    server.request_handlers[types.ListToolsRequest] = list_handler
    server.request_handlers[types.CallToolRequest] = call_handler
    return Served(flavour, server, server, state)


def _register_high_level(server: Any, name: str) -> None:
    def fn(x: int = 0) -> str:
        return "x"

    server.add_tool(fn, name=name, description=f"tool {name}")


async def list_all(client: Any) -> list[Any]:
    """Every page of ``tools/list``, following ``nextCursor``."""
    tools: list[Any] = []
    cursor = None
    while True:
        result = await (client.inner.list_tools(cursor=cursor) if cursor else client.inner.list_tools())
        tools.extend(result.tools)
        cursor = getattr(result, "nextCursor", None) or getattr(result, "next_cursor", None)
        if not cursor:
            return tools
