"""``instrument_mcp_server``: the public entry point."""

from __future__ import annotations

import contextlib
import logging
from typing import Any, Literal, TypeVar

from opentelemetry import trace

from . import _adapters as adapters
from ._config import resolve_options
from ._metrics import MetricsRecorder
from ._recorder import ToolCallRecorder
from ._recording import ErrorRecordingConfig
from ._version import __version__

logger = logging.getLogger("opentel_mcp")

ServerT = TypeVar("ServerT")


def _resolve_target(server: Any) -> tuple[str, Any, Any] | None:
    """``(kind, lowlevel_server, high_level_server_or_None)`` or ``None`` when the server is not recognised."""
    # mcp 2.x MCPServer
    low = getattr(server, "_lowlevel_server", None)
    if low is not None and hasattr(low, "get_request_handler"):
        return "v2", low, server
    # mcp 1.x FastMCP
    low = getattr(server, "_mcp_server", None)
    if low is not None and hasattr(low, "request_handlers"):
        return "v1", low, server
    # mcp 2.x low-level Server
    if hasattr(server, "get_request_handler") and hasattr(server, "add_request_handler"):
        return "v2", server, None
    # mcp 1.x low-level Server
    if isinstance(getattr(server, "request_handlers", None), dict):
        return "v1", server, None
    return None


def instrument_mcp_server(
    server: ServerT,
    *,
    enabled: bool = True,
    enable_metrics: bool = True,
    fingerprinting: bool = True,
    error_recording: dict[str, Any] | ErrorRecordingConfig | None = None,
    setup_sdk: bool = False,
    service_name: str | None = None,
    exporter_url: str | None = None,
    flush_on_exit: bool | dict[str, int] | None = None,
    sdk_tracing: Literal["replace", "enrich"] = "replace",
    sensitive_tools: list[str] | None = None,
    secret_leak_detection: dict[str, Any] | None = None,
    **unknown: Any,
) -> ServerT:
    """Instrument an MCP server's ``tools/call`` handler with OpenTelemetry spans and metrics.

    ``server`` is a low-level ``Server``, ``FastMCP`` (mcp 1.x) or ``MCPServer`` (mcp 2.x); the same object is
    returned. A low-level ``Server`` must have its ``tools/call`` handler registered first on mcp 2.x.

    Args:
        enabled: ``False`` makes this call a no-op.
        enable_metrics: record ``mcp.tool.calls`` / ``errors`` / ``silent_failures`` / ``duration``.
        fingerprinting: add ``mcp.failure.*`` attributes and the ``mcp.failure.category`` metric label.
        error_recording: ``{"mode": "full" | "normalized" | "none", "redactor": callable}``; also
            ``OTEL_MCP_ERROR_RECORDING_MODE``. ``full`` (default) records scrubbed, capped exceptions.
        setup_sdk: dev mode -- build a tracer and meter provider (needs the ``opentel-mcp[dev]`` extra).
        service_name: required when ``setup_sdk`` is true.
        exporter_url: with ``setup_sdk``, also POST spans as OTLP/HTTP JSON to this URL (opentel-mcp-ui).
        flush_on_exit: with ``setup_sdk``, flush on exit and on SIGTERM/SIGINT; ``{"timeout_ms": n}`` to tune.
        sdk_tracing: mcp 2.x only. ``"replace"`` (default) takes the SDK's ``tools/call`` span away and emits
            ours with the full contract. ``"enrich"`` keeps the SDK span and adds our attributes and metrics;
            the SDK then records thrown exceptions **raw** (no scrubbing, modes or caps), its ``error.type``
            is ``type(e).__qualname__`` or the JSON-RPC code, and it also spans bad-params and
            pre-initialize requests.
        sensitive_tools: tool names to audit (ADR 032): exact names and ``*`` wildcards (any run of characters; no
            other pattern syntax; case-sensitive). A matching call gets ``mcp.tool.sensitive = True`` and one
            ``mcp.audit.sensitive_call`` span event (outcome, ``mcp.tool.duration_ms``, failure category). Never
            arguments or results. Invalid entries warn once and are skipped. Default: nothing is audited.
        secret_leak_detection: ``{"enabled": bool, "max_scan_bytes": int}`` (ADR 030; opt-in, default off). Scans the
            ``text`` content items of successful and ``isError`` results for credential-shaped strings and records
            only ``mcp.tool.secret_leak.detected`` / ``.types`` / ``.count`` / ``.scan_truncated`` on the span and
            the ``mcp.tool.secret_leaks`` counter. ``max_scan_bytes`` (default 65536) is counted in UTF-16 code
            units, exactly like the JS package, not bytes. The matched text is never recorded. A signal, not a
            guarantee: pattern-based, and it never changes span status.

    Never raises into the host, with one exception: ``setup_sdk=True`` without ``service_name`` raises
    ``ValueError`` here, at startup.
    """
    options = resolve_options(
        enabled=enabled,
        enable_metrics=enable_metrics,
        fingerprinting=fingerprinting,
        error_recording=error_recording,
        setup_sdk=setup_sdk,
        service_name=service_name,
        exporter_url=exporter_url,
        flush_on_exit=flush_on_exit,
        sdk_tracing=sdk_tracing,
        sensitive_tools=sensitive_tools,
        secret_leak_detection=secret_leak_detection,
        **unknown,
    )
    try:
        _instrument(server, options)
    except Exception as exc:  # never throw into the host
        with contextlib.suppress(Exception):
            logger.warning(
                "opentel-mcp: instrumentation failed (%s); the server is running uninstrumented.",
                type(exc).__name__,
            )
    return server


def _instrument(server: Any, options: Any) -> None:
    if not options.enabled:
        return
    target = _resolve_target(server)
    if target is None:
        logger.warning(
            "opentel-mcp: %s is not a supported MCP server (expected a low-level Server, FastMCP (mcp 1.x) or "
            "MCPServer (mcp 2.x)); nothing was instrumented.",
            type(server).__name__,
        )
        return
    kind, lowlevel, high = target
    if adapters.already_instrumented(server) or adapters.already_instrumented(lowlevel):
        logger.warning(
            "opentel-mcp: this server is already instrumented; ignoring the second instrument_mcp_server() call."
        )
        return

    if options.setup_sdk:
        from ._dev import setup_dev_sdk

        dev = setup_dev_sdk(options)
        if dev is not None:
            _attach_shutdown(high if high is not None else lowlevel, dev)

    tracer = trace.get_tracer("opentel-mcp", __version__)
    metrics_recorder = MetricsRecorder() if options.enable_metrics else None
    recorder = ToolCallRecorder(options, tracer, metrics_recorder, "own")

    if kind == "v1":
        installed = adapters.install_v1(lowlevel, recorder)
    else:
        installed = adapters.install_v2_handler(lowlevel, recorder)
        if installed:
            recorder.span_mode = adapters.decide_sdk_tracing(lowlevel, options, recorder)
            if high is not None:
                adapters.install_cause_capture(high, recorder)

    if installed:
        adapters.mark_instrumented(server)
        adapters.mark_instrumented(lowlevel)
    else:
        logger.warning(
            "opentel-mcp: could not install the tools/call hook (unsupported mcp SDK shape); nothing was instrumented."
        )


def _attach_shutdown(obj: Any, dev: Any) -> None:
    """``server.shutdown()`` mirrors JS: flush and shut down the providers dev mode created."""
    try:
        if not hasattr(obj, "shutdown"):
            obj.shutdown = dev.shutdown
    except Exception:
        pass
