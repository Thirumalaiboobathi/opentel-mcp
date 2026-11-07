"""The telemetry contract (ADR 028, Decision 4; versioned by ``contractVersion``, ADR 034 amendment).

Every name, value, unit, description and label set here is mirrored by
``conformance/contract.json`` (generated from the JS implementation) and asserted
by ``tests/test_contract.py``. Change nothing here without changing core first.
"""

from __future__ import annotations

from typing import Final

# Bumped only when conformance/contract.json's contractVersion is (ADR 034 amendment); never by a core patch release.
CONTRACT_VERSION: Final = 2
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
METRIC_AUTH_FAILURES: Final = "mcp.tool.auth_failures"
METRIC_SECRET_LEAKS: Final = "mcp.tool.secret_leaks"
METRIC_INTEGRITY_VIOLATIONS: Final = "mcp.tool.integrity_violations"

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
    {
        "name": METRIC_AUTH_FAILURES,
        "kind": "counter",
        "unit": "",
        "description": "Number of failed MCP tool calls (isError result or thrown) classified as authentication/authorization failures (ADR 031).",
        "labelKeys": ["gen_ai.tool.name"],
        "optionalLabelKeys": [],
    },
    {
        "name": METRIC_SECRET_LEAKS,
        "kind": "counter",
        "unit": "",
        "description": "Number of MCP tool results whose text looked like it contained a credential (ADR 030). A signal, not an error; opt-in.",
        "labelKeys": ["gen_ai.tool.name"],
        "optionalLabelKeys": [],
    },
    {
        "name": METRIC_INTEGRITY_VIOLATIONS,
        "kind": "counter",
        "unit": "",
        "description": "Number of tools whose definition changed since first seen or no longer matches a configured pin (ADR 029). Detection only.",
        "labelKeys": ["gen_ai.tool.name"],
        "optionalLabelKeys": [],
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

# --- the v0.18 security signals (ADRs 029-032; contract version 2) ---------------------------------------------
ATTR_MCP_TOOL_SENSITIVE: Final = "mcp.tool.sensitive"
ATTR_MCP_TOOL_DURATION_MS: Final = "mcp.tool.duration_ms"
ATTR_SECRET_LEAK_DETECTED: Final = "mcp.tool.secret_leak.detected"
ATTR_SECRET_LEAK_TYPES: Final = "mcp.tool.secret_leak.types"
ATTR_SECRET_LEAK_COUNT: Final = "mcp.tool.secret_leak.count"
ATTR_SECRET_LEAK_SCAN_TRUNCATED: Final = "mcp.tool.secret_leak.scan_truncated"

EVENT_AUDIT_SENSITIVE_CALL: Final = "mcp.audit.sensitive_call"
EVENT_INTEGRITY_CHANGED: Final = "mcp.tool.integrity.changed"
EVENT_INTEGRITY_PIN_MISMATCH: Final = "mcp.tool.integrity.pin_mismatch"
EVENT_INTEGRITY_ADDED: Final = "mcp.tool.integrity.added"
EVENT_INTEGRITY_REMOVED: Final = "mcp.tool.integrity.removed"

ATTR_INTEGRITY_OLD_HASH: Final = "mcp.tool.integrity.old_hash"
ATTR_INTEGRITY_NEW_HASH: Final = "mcp.tool.integrity.new_hash"
ATTR_INTEGRITY_EXPECTED_HASH: Final = "mcp.tool.integrity.expected_hash"
ATTR_INTEGRITY_ACTUAL_HASH: Final = "mcp.tool.integrity.actual_hash"
ATTR_INTEGRITY_SEVERITY: Final = "mcp.tool.integrity.severity"
INTEGRITY_SEVERITY_HIGH: Final = "high"

SECURITY_SPAN_ATTRIBUTES: Final = (
    ATTR_MCP_TOOL_SENSITIVE,
    ATTR_SECRET_LEAK_DETECTED,
    ATTR_SECRET_LEAK_TYPES,
    ATTR_SECRET_LEAK_COUNT,
    ATTR_SECRET_LEAK_SCAN_TRUNCATED,
)
SECURITY_SPAN_EVENTS: Final = (
    {
        "name": EVENT_AUDIT_SENSITIVE_CALL,
        "attributes": [ATTR_GEN_AI_TOOL_NAME, ATTR_MCP_TOOL_OUTCOME, ATTR_MCP_TOOL_DURATION_MS, "mcp.failure.category"],
    },
    {
        "name": EVENT_INTEGRITY_CHANGED,
        "attributes": [ATTR_GEN_AI_TOOL_NAME, ATTR_INTEGRITY_OLD_HASH, ATTR_INTEGRITY_NEW_HASH],
    },
    {
        "name": EVENT_INTEGRITY_PIN_MISMATCH,
        "attributes": [
            ATTR_GEN_AI_TOOL_NAME,
            ATTR_INTEGRITY_EXPECTED_HASH,
            ATTR_INTEGRITY_ACTUAL_HASH,
            ATTR_INTEGRITY_SEVERITY,
        ],
    },
    {"name": EVENT_INTEGRITY_ADDED, "attributes": [ATTR_GEN_AI_TOOL_NAME, ATTR_INTEGRITY_NEW_HASH]},
    {"name": EVENT_INTEGRITY_REMOVED, "attributes": [ATTR_GEN_AI_TOOL_NAME, ATTR_INTEGRITY_OLD_HASH]},
)
#: JS option name -> Python keyword (ADR 028: snake_case).
SECURITY_OPTIONS: Final = {
    "sensitiveTools": "sensitive_tools",
    "secretLeakDetection": "secret_leak_detection",
    "toolIntegrity": "tool_integrity",
}
AUTH_FAILURE_CATEGORY: Final = "auth"
SECRET_TYPES: Final = (
    "url_credentials",
    "jwt",
    "http_auth_credential",
    "aws_access_key_id",
    "provider_api_key",
    "secret_assignment",
)

# caps (mirrored by contract.json -> security.*)
DEFAULT_MAX_SCAN_BYTES: Final = 65_536
SCAN_CHUNK_SIZE: Final = 4096
SCAN_CHUNK_OVERLAP: Final = 256
MAX_CONTENT_ITEMS: Final = 10_000
MAX_DETECTED_MATCHES: Final = 1000
MAX_SENSITIVE_PATTERNS: Final = 1000
MAX_SENSITIVE_PATTERN_LENGTH: Final = 256
MAX_MATCHED_NAME_LENGTH: Final = 1024
TOOL_HASH_PREFIX: Final = "sha256:"
TOOL_HASH_PATTERN: Final = "^sha256:[0-9a-f]{64}$"
HASHED_DEFINITION_FIELDS: Final = ("name", "title", "description", "inputSchema", "outputSchema", "annotations")
MAX_PINS: Final = 1000
MAX_TRACKED_TOOLS: Final = 1000
