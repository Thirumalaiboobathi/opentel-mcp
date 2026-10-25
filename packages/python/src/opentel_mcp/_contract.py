"""The telemetry contract with core 0.17.0 (ADR 028, Decision 4).

Every name, value, unit, description and label set here is mirrored by
``conformance/contract.json`` (generated from the JS implementation) and asserted
by ``tests/test_contract.py``. Change nothing here without changing core first.
"""

from __future__ import annotations

from typing import Final

CONTRACT_VERSION: Final = "core 0.17.0"
INSTRUMENTATION_SCOPE: Final = "opentel-mcp"

# --- span names and attribute keys ---------------------------------------------
MCP_METHOD_TOOLS_CALL: Final = "tools/call"
GEN_AI_OPERATION_EXECUTE_TOOL: Final = "execute_tool"
ERROR_TYPE_TOOL_ERROR: Final = "tool_error"
ORIGIN_TOOL_ERROR: Final = "tool_error"
ORIGIN_THROWN: Final = "thrown"

ATTR_MCP_METHOD_NAME: Final = "mcp.method.name"
ATTR_GEN_AI_OPERATION_NAME: Final = "gen_ai.operation.name"
ATTR_GEN_AI_TOOL_NAME: Final = "gen_ai.tool.name"
ATTR_MCP_TOOL_ARGUMENT_COUNT: Final = "mcp.tool.argument_count"
ATTR_JSONRPC_REQUEST_ID: Final = "jsonrpc.request.id"
ATTR_ERROR_TYPE: Final = "error.type"
ATTR_MCP_TOOL_OUTCOME: Final = "mcp.tool.outcome"
ATTR_MCP_TOOL_MODEL: Final = "mcp.tool.model"

OUTCOME_SUCCESS: Final = "success"
OUTCOME_ERROR: Final = "error"
OUTCOME_SILENT_FAILURE: Final = "silent_failure"

FINGERPRINT_ATTRIBUTE_KEYS: Final = {
    "FINGERPRINT": "mcp.failure.fingerprint",
    "SIGNATURE": "mcp.failure.signature",
    "CATEGORY": "mcp.failure.category",
    "ORIGIN": "mcp.failure.origin",
    "ERROR_CLASS": "mcp.failure.error_class",
    "CHANNEL": "mcp.failure.channel",
    # Deferred to python 0.2 (ADR 028 Decision 2): declared so the contract mirror is complete.
    "VALIDATION_PATHS": "mcp.failure.validation_paths",
}
DEFERRED_SPAN_ATTRIBUTES: Final = ("mcp.failure.validation_paths",)

# --- allowlists (frozen tuples; see the ADR 021 cross-check test) -----------------
METRIC_SAFE_ATTRIBUTES: Final = (
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_MCP_METHOD_NAME,
    ATTR_MCP_TOOL_OUTCOME,
    ATTR_ERROR_TYPE,
    ATTR_MCP_TOOL_MODEL,
)
FINGERPRINT_METRIC_SAFE_ATTRIBUTES: Final = ("mcp.failure.category", "mcp.failure.origin")

# --- metrics ---------------------------------------------------------------------
METRIC_CALLS: Final = "mcp.tool.calls"
METRIC_ERRORS: Final = "mcp.tool.errors"
METRIC_SILENT_FAILURES: Final = "mcp.tool.silent_failures"
METRIC_DURATION: Final = "mcp.tool.duration"

METRIC_SPECS: Final = (
    {
        "name": METRIC_CALLS,
        "kind": "counter",
        "unit": "",
        "description": "Number of MCP tool calls received, regardless of outcome.",
        "labelKeys": ["gen_ai.tool.name", "mcp.method.name"],
        "optionalLabelKeys": [],
    },
    {
        "name": METRIC_ERRORS,
        "kind": "counter",
        "unit": "",
        "description": "Number of MCP tool calls whose handler threw or rejected (protocol-level failure).",
        "labelKeys": ["error.type", "gen_ai.tool.name"],
        "optionalLabelKeys": ["mcp.failure.category"],
    },
    {
        "name": METRIC_SILENT_FAILURES,
        "kind": "counter",
        "unit": "",
        "description": "Number of MCP tool calls whose JSON-RPC response succeeded but whose CallToolResult had isError: true.",
        "labelKeys": ["gen_ai.tool.name"],
        "optionalLabelKeys": ["mcp.failure.category"],
    },
    {
        "name": METRIC_DURATION,
        "kind": "histogram",
        "unit": "ms",
        "description": "Duration of MCP tool call execution.",
        "labelKeys": ["gen_ai.tool.name", "mcp.tool.outcome"],
        "optionalLabelKeys": ["mcp.failure.category"],
    },
)

FAILURE_CATEGORIES: Final = (
    "validation",
    "timeout",
    "network",
    "auth",
    "dependency",
    "serialization",
    "internal",
    "unknown",
)
FAILURE_CHANNELS: Final = (
    "execution",
    "protocol.not_found",
    "protocol.input",
    "protocol.output",
    "protocol.other",
    "unknown",
)
