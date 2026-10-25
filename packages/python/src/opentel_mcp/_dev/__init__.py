"""Dev mode (``setup_sdk=True``): providers for local use, mirroring ADR 003/005/023/024."""

from __future__ import annotations

import contextlib
import logging
import sys
from typing import Any

from .._config import Options

logger = logging.getLogger("opentel_mcp")

DEV_METRICS_EXPORT_INTERVAL_MS = 5000


class DevSdk:
    """Handle on the providers dev mode created."""

    def __init__(self, tracer_provider: Any | None, meter_provider: Any | None) -> None:
        self.tracer_provider = tracer_provider
        self.meter_provider = meter_provider
        self._done = False
        self._unregister: Any = None

    def force_flush(self, timeout_ms: int = 5000) -> bool:
        ok = True
        for provider in (self.tracer_provider, self.meter_provider):
            if provider is None:
                continue
            try:
                ok = bool(provider.force_flush(timeout_ms)) and ok
            except Exception:
                ok = False
        return ok

    def shutdown(self) -> None:
        if self._done:
            return
        self._done = True
        if self._unregister is not None:
            self._unregister()
        for provider in (self.tracer_provider, self.meter_provider):
            if provider is None:
                continue
            with contextlib.suppress(Exception):
                provider.shutdown()


_current: DevSdk | None = None


def force_flush(timeout_ms: int = 5000) -> bool:
    """Flush the providers dev mode created (``False`` if dev mode is not active or the flush timed out)."""
    return _current.force_flush(timeout_ms) if _current is not None else False


def shutdown() -> None:
    if _current is not None:
        _current.shutdown()


def setup_dev_sdk(options: Options) -> DevSdk | None:
    """Create and globally register a ``TracerProvider`` and ``MeterProvider`` unless some are already set.

    Needs ``opentelemetry-sdk`` (the ``opentel-mcp[dev]`` extra). Never raises.
    """
    global _current
    try:
        from opentelemetry import metrics, trace
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import ConsoleMetricExporter, PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
    except ImportError:
        logger.warning(
            "opentel-mcp: setup_sdk=True needs the OpenTelemetry SDK. Install it with: pip install 'opentel-mcp[dev]'. "
            "Continuing without dev mode."
        )
        return None

    try:
        from .flush import register_flush_on_exit
        from .otlp_json import OtlpJsonSpanExporter
        from .stderr import StderrSpanExporter

        resource = Resource.create({"service.name": options.service_name or "unknown_service"})

        tracer_provider = None
        if isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
            tracer_provider = TracerProvider(resource=resource)
            tracer_provider.add_span_processor(SimpleSpanProcessor(StderrSpanExporter()))
            if options.exporter_url:
                tracer_provider.add_span_processor(
                    BatchSpanProcessor(OtlpJsonSpanExporter(options.exporter_url))
                )
            trace.set_tracer_provider(tracer_provider)
        else:
            logger.warning(
                "opentel-mcp: setup_sdk=True, but a TracerProvider is already registered globally; reusing it. The "
                "dev-mode stderr and exporter_url exporters were not attached."
            )

        meter_provider = None
        if options.enable_metrics:
            if _meter_provider_unset(metrics):
                reader = PeriodicExportingMetricReader(
                    ConsoleMetricExporter(out=sys.stderr),
                    export_interval_millis=DEV_METRICS_EXPORT_INTERVAL_MS,
                )
                meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
                metrics.set_meter_provider(meter_provider)
            else:
                logger.warning(
                    "opentel-mcp: setup_sdk=True, but a MeterProvider is already registered globally; reusing it. The "
                    "dev-mode stderr metrics printout was not set up."
                )

        dev = DevSdk(tracer_provider, meter_provider)
        _current = dev
        if options.flush_timeout_ms:
            dev._unregister = register_flush_on_exit(dev.shutdown, options.flush_timeout_ms)
        return dev
    except Exception as exc:
        logger.warning("opentel-mcp: dev mode setup failed (%s); continuing without it.", type(exc).__name__)
        return None


def _meter_provider_unset(metrics_module: Any) -> bool:
    return type(metrics_module.get_meter_provider()).__name__ == "_ProxyMeterProvider"
