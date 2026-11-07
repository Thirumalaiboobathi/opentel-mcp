"""The Python contract mirrors ``conformance/contract.json`` (generated from core) -- ADR 028 Decision 4."""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from opentel_mcp import _contract as c
from opentel_mcp import _recording
from opentel_mcp._metrics import MetricsRecorder
from tests.conftest import load_conformance


@pytest.fixture(scope="module")
def contract() -> Any:
    return load_conformance("contract.json")


def test_scope_and_version(contract: Any) -> None:
    assert contract["instrumentationScope"] == c.INSTRUMENTATION_SCOPE
    assert contract["contractVersion"] == c.CONTRACT_VERSION
    assert isinstance(contract["coreVersion"], str)  # informational only: never asserted against anything
    assert "contract" not in contract


def test_span_attribute_keys(contract: Any) -> None:
    a = contract["span"]["attributes"]
    assert a["methodName"] == c.ATTR_MCP_METHOD_NAME
    assert a["genAiOperationName"] == c.ATTR_GEN_AI_OPERATION_NAME
    assert a["genAiToolName"] == c.ATTR_GEN_AI_TOOL_NAME
    assert a["toolArgumentCount"] == c.ATTR_MCP_TOOL_ARGUMENT_COUNT
    assert a["jsonrpcRequestId"] == c.ATTR_JSONRPC_REQUEST_ID
    assert a["errorType"] == c.ATTR_ERROR_TYPE
    assert contract["span"]["fingerprintAttributes"] == c.FINGERPRINT_ATTRIBUTE_KEYS
    assert contract["span"]["deferredInPython"] == list(c.DEFERRED_SPAN_ATTRIBUTES)


def test_span_values(contract: Any) -> None:
    v = contract["span"]["values"]
    assert v["methodName"] == c.MCP_METHOD_TOOLS_CALL
    assert v["operationName"] == c.GEN_AI_OPERATION_EXECUTE_TOOL
    assert v["toolErrorType"] == c.ERROR_TYPE_TOOL_ERROR
    assert v["outcomes"] == {
        "success": c.OUTCOME_SUCCESS,
        "error": c.OUTCOME_ERROR,
        "silentFailure": c.OUTCOME_SILENT_FAILURE,
    }
    assert v["isErrorOrigin"] == c.ORIGIN_TOOL_ERROR
    assert v["thrownOrigin"] == c.ORIGIN_THROWN


def test_metric_specs(contract: Any) -> None:
    assert list(c.METRIC_SPECS) == contract["metrics"]


def test_allowlists_are_frozen_tuples_equal_to_core(contract: Any) -> None:
    assert isinstance(c.METRIC_SAFE_ATTRIBUTES, tuple)
    assert isinstance(c.FINGERPRINT_METRIC_SAFE_ATTRIBUTES, tuple)
    assert list(c.METRIC_SAFE_ATTRIBUTES) == contract["allowlists"]["metricSafeAttributes"]
    assert (
        list(c.FINGERPRINT_METRIC_SAFE_ATTRIBUTES)
        == contract["allowlists"]["fingerprintMetricSafeAttributes"]
    )


def test_failure_enums_and_error_recording(contract: Any) -> None:
    assert list(c.FAILURE_CATEGORIES) == contract["failure"]["categories"]
    assert list(c.FAILURE_CHANNELS) == contract["failure"]["channels"]
    er = contract["errorRecording"]
    assert list(_recording.VALID_MODES) == er["modes"]
    assert _recording.ENV_MODE == er["envVar"]
    assert _recording.MAX_FULL_EXCEPTION_MESSAGE_LENGTH == er["maxFullMessageLength"]
    assert _recording.MAX_FULL_EXCEPTION_STACK_LENGTH == er["maxFullStackLength"]
    assert _recording.TRUNCATION_MARKER == er["truncationMarker"]
    assert _recording.MAX_INPUT_LENGTH == er["maxNormalizeInputLength"]


def test_registered_metrics_match_the_contract_and_the_allowlist(contract: Any) -> None:
    """ADR 021 cross-check: every label key at every metric call site is on an allowlist."""
    from opentelemetry import metrics

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    # Fresh, non-global meter provider: patch the module's lookup so the test never touches global state.
    meter_provider_get = metrics.get_meter
    try:
        metrics.get_meter = lambda name, version=None, **kw: provider.get_meter(name, version)  # type: ignore[assignment]
        rec = MetricsRecorder()
    finally:
        metrics.get_meter = meter_provider_get  # type: ignore[assignment]
    rec.record_call("t")
    rec.record_error("t", "Error", "internal")
    rec.record_error("t", "Error")
    rec.record_silent_failure("t", "internal")
    rec.record_silent_failure("t")
    rec.record_duration("t", 1.0, "silent_failure", "internal")
    rec.record_duration("t", 1.0, "success")
    rec.record_auth_failure("t")
    rec.record_secret_leak("t")
    rec.record_integrity_violation("t")

    data = reader.get_metrics_data()
    assert data is not None
    scopes = data.resource_metrics[0].scope_metrics
    assert {s.scope.name for s in scopes} == {c.INSTRUMENTATION_SCOPE}
    allowed = set(c.METRIC_SAFE_ATTRIBUTES) | set(c.FINGERPRINT_METRIC_SAFE_ATTRIBUTES)
    seen = {}
    for scope in scopes:
        for m in scope.metrics:
            keys = [set(dp.attributes or {}) for dp in m.data.data_points]
            required = set.intersection(*keys)
            union = set.union(*keys)
            seen[m.name] = {
                "name": m.name,
                "kind": "histogram" if type(m.data).__name__ == "Histogram" else "counter",
                "unit": m.unit or "",
                "description": m.description,
                "labelKeys": sorted(required),
                "optionalLabelKeys": sorted(union - required),
            }
            assert union <= allowed, (m.name, union - allowed)
    assert [seen[m["name"]] for m in contract["metrics"]] == contract["metrics"]


def test_security_section_is_mirrored(contract: Any) -> None:
    """ADR 034 amendment: the v0.18 signals are part of the shared contract (names, caps, option spellings)."""
    sec = contract["security"]
    assert list(c.SECURITY_SPAN_ATTRIBUTES) == sec["spanAttributes"]
    assert list(c.SECURITY_SPAN_EVENTS) == sec["spanEvents"]
    assert list(c.SECURITY_OPTIONS) == sec["options"]  # JS spelling -> Python snake_case, same order
    assert c.AUTH_FAILURE_CATEGORY == sec["authFailureCategory"]
    assert list(c.SECRET_TYPES) == sec["secretTypes"]
    leak = sec["secretLeak"]
    assert leak["budgetUnit"] == "utf16-code-units"
    assert c.DEFAULT_MAX_SCAN_BYTES == leak["defaultMaxScanBytes"]
    assert c.SCAN_CHUNK_SIZE == leak["chunkSize"]
    assert c.SCAN_CHUNK_OVERLAP == leak["chunkOverlap"]
    assert c.MAX_CONTENT_ITEMS == leak["maxContentItems"]
    assert c.MAX_DETECTED_MATCHES == leak["maxDetectedMatches"]
    st = sec["sensitiveTools"]
    assert c.MAX_SENSITIVE_PATTERNS == st["maxPatterns"]
    assert c.MAX_SENSITIVE_PATTERN_LENGTH == st["maxPatternLength"]
    assert c.MAX_MATCHED_NAME_LENGTH == st["maxMatchedNameLength"]
    ig = sec["integrity"]
    assert c.TOOL_HASH_PREFIX == ig["hashPrefix"]
    assert c.TOOL_HASH_PATTERN == ig["hashPattern"]
    assert list(c.HASHED_DEFINITION_FIELDS) == ig["hashedFields"]
    assert c.INTEGRITY_SEVERITY_HIGH == ig["severityHigh"]
    assert c.MAX_PINS == ig["maxPins"]
    assert c.MAX_TRACKED_TOOLS == ig["maxTrackedTools"]


def test_security_metrics_use_only_the_tool_label(contract: Any) -> None:
    for m in contract["metrics"][4:]:
        assert m["labelKeys"] == ["gen_ai.tool.name"] and m["optionalLabelKeys"] == []
