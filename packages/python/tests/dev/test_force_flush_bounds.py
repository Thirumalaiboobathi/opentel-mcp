"""``force_flush`` must come back within its bound whatever the collector does (it runs inside the host process)."""

from __future__ import annotations

import logging
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from opentel_mcp._dev import DevSdk
from opentel_mcp._dev.otlp_json import OtlpJsonSpanExporter

SLACK_S = (
    3.0  # scheduling slack on a loaded CI runner; the bounds below are far smaller than the hang they guard
)


def make_sdk(url: str, exporter_timeout_s: float) -> DevSdk:
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(OtlpJsonSpanExporter(url, timeout_s=exporter_timeout_s)))
    with provider.get_tracer("t").start_as_current_span("tools/call x"):
        pass
    return DevSdk(provider, None)


@contextmanager
def silent_server() -> Iterator[str]:
    """Accepts connections and never replies, so a client waits for a response that does not come."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    held: list[socket.socket] = []
    stop = threading.Event()

    def accept() -> None:
        listener.settimeout(0.1)
        while not stop.is_set():
            try:
                held.append(listener.accept()[0])
            except OSError:
                continue

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}/v1/traces"
    finally:
        stop.set()
        thread.join(5)
        for conn in held:
            conn.close()
        listener.close()


def closed_port_url() -> str:
    with closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}/v1/traces"  # nothing listens here any more


def test_force_flush_returns_promptly_when_the_endpoint_is_unreachable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sdk = make_sdk(closed_port_url(), exporter_timeout_s=2.0)
    started = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="opentel_mcp"):
        sdk.force_flush(timeout_ms=5000)  # True or False: the export failing is not what is under test
    assert time.monotonic() - started < 5 + SLACK_S
    assert len([r for r in caplog.records if "could not send spans" in r.getMessage()]) == 1
    sdk.shutdown()


def test_force_flush_returns_within_the_exporter_timeout_when_the_server_never_replies() -> None:
    with silent_server() as url:
        sdk = make_sdk(url, exporter_timeout_s=1.0)
        started = time.monotonic()
        sdk.force_flush(timeout_ms=10000)
        assert (
            time.monotonic() - started < 1.0 + SLACK_S
        )  # the HTTP read timeout, not the flush bound, ends it
        sdk.shutdown()


def test_force_flush_gives_up_at_its_own_bound_even_if_the_export_is_still_blocked(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with silent_server() as url:
        sdk = make_sdk(url, exporter_timeout_s=30.0)  # far longer than the flush bound
        started = time.monotonic()
        with caplog.at_level(logging.WARNING, logger="opentel_mcp"):
            ok = sdk.force_flush(timeout_ms=500)
        assert ok is False
        assert time.monotonic() - started < 0.5 + SLACK_S
        assert any("force_flush" in r.getMessage() for r in caplog.records)
        sdk.shutdown()
