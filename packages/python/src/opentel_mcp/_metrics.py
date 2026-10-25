"""The four core metrics (port of ``metrics.js``), recorded with the contract's labels only."""

from __future__ import annotations

from opentelemetry import metrics

from . import _contract as c
from ._version import __version__


class MetricsRecorder:
    def __init__(self) -> None:
        meter = metrics.get_meter(c.INSTRUMENTATION_SCOPE, __version__)
        spec = {m["name"]: m for m in c.METRIC_SPECS}
        self._calls = meter.create_counter(
            c.METRIC_CALLS, description=str(spec[c.METRIC_CALLS]["description"])
        )
        self._errors = meter.create_counter(
            c.METRIC_ERRORS, description=str(spec[c.METRIC_ERRORS]["description"])
        )
        self._silent = meter.create_counter(
            c.METRIC_SILENT_FAILURES, description=str(spec[c.METRIC_SILENT_FAILURES]["description"])
        )
        self._duration = meter.create_histogram(
            c.METRIC_DURATION, unit="ms", description=str(spec[c.METRIC_DURATION]["description"])
        )

    @staticmethod
    def _tool(tool_name: str | None) -> dict[str, str]:
        return {} if tool_name is None else {c.ATTR_GEN_AI_TOOL_NAME: tool_name}

    def record_call(self, tool_name: str | None) -> None:
        self._calls.add(1, {**self._tool(tool_name), c.ATTR_MCP_METHOD_NAME: c.MCP_METHOD_TOOLS_CALL})

    def record_error(self, tool_name: str | None, error_type: str, category: str = "") -> None:
        attrs = {**self._tool(tool_name), c.ATTR_ERROR_TYPE: error_type}
        if category:
            attrs[c.FINGERPRINT_ATTRIBUTE_KEYS["CATEGORY"]] = category
        self._errors.add(1, attrs)

    def record_silent_failure(self, tool_name: str | None, category: str = "") -> None:
        attrs = self._tool(tool_name)
        if category:
            attrs[c.FINGERPRINT_ATTRIBUTE_KEYS["CATEGORY"]] = category
        self._silent.add(1, attrs)

    def record_duration(
        self, tool_name: str | None, duration_ms: float, outcome: str, category: str = ""
    ) -> None:
        attrs = {**self._tool(tool_name), c.ATTR_MCP_TOOL_OUTCOME: outcome}
        if category:
            attrs[c.FINGERPRINT_ATTRIBUTE_KEYS["CATEGORY"]] = category
        self._duration.record(duration_ms, attrs)
