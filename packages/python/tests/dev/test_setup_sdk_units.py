"""Unit tests around dev-mode configuration and flush-on-exit registration (no global provider changes)."""

from __future__ import annotations

import sys
import threading
import time
from typing import Any

import pytest

from opentel_mcp import instrument_mcp_server
from opentel_mcp._config import DEFAULT_FLUSH_TIMEOUT_MS, resolve_options
from opentel_mcp._dev import flush as flush_mod
from opentel_mcp._dev import setup_dev_sdk


def test_flush_on_exit_defaults() -> None:
    assert (
        resolve_options(setup_sdk=True, service_name="s").flush_timeout_ms == DEFAULT_FLUSH_TIMEOUT_MS == 2000
    )
    assert resolve_options(setup_sdk=True, service_name="s", flush_on_exit=True).flush_timeout_ms == 2000
    assert resolve_options(setup_sdk=True, service_name="s", flush_on_exit=False).flush_timeout_ms is None
    assert (
        resolve_options(setup_sdk=True, service_name="s", flush_on_exit={"timeout_ms": 500}).flush_timeout_ms
        == 500
    )
    assert (
        resolve_options(setup_sdk=True, service_name="s", flush_on_exit={"timeout_ms": -5}).flush_timeout_ms
        == 2000
    )


def test_flush_on_exit_without_setup_sdk_is_ignored_with_one_warning(
    opentel_logs: pytest.LogCaptureFixture,
) -> None:
    assert resolve_options(flush_on_exit=True).flush_timeout_ms is None
    resolve_options(flush_on_exit=True)
    assert sum("flush_on_exit was provided" in r.getMessage() for r in opentel_logs.records) == 1


def test_exporter_url_and_service_name_without_setup_sdk_are_ignored_with_warnings(
    opentel_logs: pytest.LogCaptureFixture,
) -> None:
    o = resolve_options(exporter_url="http://127.0.0.1:1/v1/traces", service_name="x")
    assert o.exporter_url is None and o.service_name == "x"
    messages = [r.getMessage() for r in opentel_logs.records]
    assert any("exporter_url has no effect" in m for m in messages) and any(
        "service_name was provided" in m for m in messages
    )


def test_missing_sdk_degrades_with_one_warning(
    monkeypatch: pytest.MonkeyPatch, opentel_logs: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.resources", None)  # makes `import` raise ImportError
    assert setup_dev_sdk(resolve_options(setup_sdk=True, service_name="s")) is None
    assert sum("opentel-mcp[dev]" in r.getMessage() for r in opentel_logs.records) == 1


def test_existing_global_providers_are_reused_with_a_warning(
    opentel_logs: pytest.LogCaptureFixture, telemetry: Any
) -> None:
    # `telemetry` installs process-wide providers first, so dev mode must not try to replace them.
    dev = setup_dev_sdk(resolve_options(setup_sdk=True, service_name="s", flush_on_exit=False))
    assert dev is not None and dev.tracer_provider is None and dev.meter_provider is None
    messages = [r.getMessage() for r in opentel_logs.records]
    assert any("TracerProvider is already registered" in m for m in messages)
    assert any("MeterProvider is already registered" in m for m in messages)
    dev.shutdown()


def test_instrument_attaches_a_shutdown_method(telemetry: Any) -> None:
    from tests import harness

    server, _ = harness.build(
        harness.flavours()[-1],
        lambda s: instrument_mcp_server(s, setup_sdk=True, service_name="s", flush_on_exit=False),
    )
    assert callable(server.shutdown)
    server.shutdown()
    server.shutdown()  # idempotent


def test_flush_all_runs_registered_shutdowns_once_within_the_timeout() -> None:
    calls: list[str] = []
    slow_started = threading.Event()

    def quick() -> None:
        calls.append("quick")

    def slow() -> None:
        slow_started.set()
        time.sleep(30)

    unregister_quick = flush_mod.register_flush_on_exit(quick, 1000)
    flush_mod.register_flush_on_exit(slow, 200)
    start = time.monotonic()
    flush_mod._flush_all()
    assert time.monotonic() - start < 5, "a hung shutdown must not wedge exit"
    assert calls == ["quick"]
    flush_mod._flush_all()  # already drained
    assert calls == ["quick"]
    unregister_quick()
