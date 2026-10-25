from __future__ import annotations

import json
import logging
import pathlib
from collections.abc import Iterator
from typing import Any

import pytest
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import Counter, Histogram, MeterProvider
from opentelemetry.sdk.metrics.export import AggregationTemporality, InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
CONFORMANCE_DIR = REPO_ROOT / "conformance"


def load_conformance(rel: str) -> Any:
    path = CONFORMANCE_DIR / rel
    if not path.exists():
        pytest.skip(
            f"shared conformance suite not found at {path} (building from an sdist outside the monorepo)"
        )
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def py_cases(rel: str) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = load_conformance(rel)["cases"]
    return [c for c in cases if "py" in c["languages"]]


# One process-wide pair of SDK providers: the OpenTelemetry API allows setting the global providers only once, and
# the mcp 2.x SDK caches its tracer, so per-test providers would never see the SDK's own spans.
_SPANS = InMemorySpanExporter()
_READER = InMemoryMetricReader(
    preferred_temporality={Counter: AggregationTemporality.DELTA, Histogram: AggregationTemporality.DELTA}
)
_INSTALLED = False


def _install_providers() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(SimpleSpanProcessor(_SPANS))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(MeterProvider(metric_readers=[_READER]))
    _INSTALLED = True


class Telemetry:
    """Spans and metric deltas since the test started. Metrics are collected once, lazily; ``refresh()`` re-collects."""

    def __init__(self) -> None:
        self._points: dict[str, list[tuple[dict[str, Any], Any]]] | None = None

    def refresh(self) -> None:
        self._points = None

    def spans(self, prefix: str | None = None) -> list[ReadableSpan]:
        spans = list(_SPANS.get_finished_spans())
        return [s for s in spans if prefix is None or s.name.startswith(prefix)]

    def tool_call_spans(self) -> list[ReadableSpan]:
        return self.spans("tools/call")

    def metric_points(self) -> dict[str, list[tuple[dict[str, Any], Any]]]:
        """``{metric name: [(attributes, value-or-count)]}`` for the delta since the test started."""
        if self._points is not None:
            return self._points
        data = _READER.get_metrics_data()
        out: dict[str, list[tuple[dict[str, Any], Any]]] = {}
        self._points = out
        if data is None:
            return out
        for rm in data.resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    for dp in m.data.data_points:
                        value = getattr(dp, "value", None)
                        if value is None:
                            value = dp.count
                        out.setdefault(m.name, []).append((dict(dp.attributes or {}), value))
        return out


@pytest.fixture
def telemetry() -> Iterator[Telemetry]:
    _install_providers()
    _SPANS.clear()
    _READER.get_metrics_data()  # drain whatever a previous test left behind
    yield Telemetry()
    _SPANS.clear()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_warnings_state() -> Iterator[None]:
    from opentel_mcp import _config, _recording

    _config._reset_warned_for_tests()
    _recording._reset_redactor_noop_warned_for_tests()
    yield


@pytest.fixture
def opentel_logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger="opentel_mcp")
    return caplog
