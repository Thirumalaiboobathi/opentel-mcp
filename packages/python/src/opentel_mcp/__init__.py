"""opentel-mcp: OpenTelemetry instrumentation for MCP servers built on the official Python SDK.

>>> from opentel_mcp import instrument_mcp_server
>>> instrument_mcp_server(server)  # doctest: +SKIP
"""

from ._dev import force_flush, shutdown
from ._integrity import compute_tool_definition_hash
from ._version import __version__
from .instrument import instrument_mcp_server

__all__ = [
    "__version__",
    "compute_tool_definition_hash",
    "force_flush",
    "instrument_mcp_server",
    "shutdown",
]
