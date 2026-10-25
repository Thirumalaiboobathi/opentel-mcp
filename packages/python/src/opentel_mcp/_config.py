"""Option resolution (port of ``resolveOptions``, config.js). Invalid values fall back with one warning."""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass
from typing import Any

from ._recording import ErrorRecordingConfig, resolve_error_recording_config

logger = logging.getLogger("opentel_mcp")

DEFAULT_FLUSH_TIMEOUT_MS = 2000
SDK_TRACING_MODES = ("replace", "enrich")

_warned: set[str] = set()


def _warn_once(key: str, message: str, *args: Any) -> None:
    if key in _warned:
        return
    _warned.add(key)
    with contextlib.suppress(Exception):
        logger.warning(message, *args)


def _reset_warned_for_tests() -> None:
    _warned.clear()


@dataclass(frozen=True)
class Options:
    enabled: bool
    enable_metrics: bool
    fingerprinting: bool
    error_recording: ErrorRecordingConfig
    setup_sdk: bool
    service_name: str | None
    exporter_url: str | None
    flush_timeout_ms: int | None  # None => flush on exit disabled
    sdk_tracing: str


def _bool(name: str, value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    _warn_once(f"bool:{name}", "opentel-mcp: %s must be a bool (got %r); using %r.", name, value, default)
    return default


def _flush_timeout(value: Any, setup_sdk: bool) -> int | None:
    requested = value is not None and value is not False
    if not setup_sdk:
        if requested:
            _warn_once(
                "flush_ignored",
                "opentel-mcp: flush_on_exit was provided but setup_sdk is False, so it has no effect. The host "
                "application owns its providers; flush them in your own shutdown sequence.",
            )
        return None
    if value is False:
        return None
    if value is None or value is True:
        return DEFAULT_FLUSH_TIMEOUT_MS
    if isinstance(value, dict):
        t = value.get("timeout_ms")
        if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0:
            return int(t)
        if t is not None:
            _warn_once(
                "flush_timeout",
                "opentel-mcp: flush_on_exit['timeout_ms'] must be a positive number; using %d.",
                DEFAULT_FLUSH_TIMEOUT_MS,
            )
        return DEFAULT_FLUSH_TIMEOUT_MS
    _warn_once(
        "flush_value", "opentel-mcp: flush_on_exit must be a bool or {'timeout_ms': int}; using the default."
    )
    return DEFAULT_FLUSH_TIMEOUT_MS


def resolve_options(
    *,
    enabled: Any = True,
    enable_metrics: Any = True,
    fingerprinting: Any = True,
    error_recording: Any = None,
    setup_sdk: Any = False,
    service_name: Any = None,
    exporter_url: Any = None,
    flush_on_exit: Any = None,
    sdk_tracing: Any = "replace",
    **unknown: Any,
) -> Options:
    """Raises ``ValueError`` only for ``setup_sdk=True`` without ``service_name`` (startup, never per request)."""
    for name in unknown:
        _warn_once(f"unknown:{name}", "opentel-mcp: unknown option %r ignored.", name)

    sdk = _bool("setup_sdk", setup_sdk, False)
    has_name = isinstance(service_name, str) and service_name.strip() != ""
    if sdk and not has_name:
        raise ValueError(
            "opentel-mcp: service_name is required when setup_sdk is True (it names the resource of the "
            "tracer provider this library creates). It is not needed otherwise -- the host application's "
            "registered provider owns the resource."
        )
    if not sdk and has_name:
        _warn_once(
            "service_name_ignored",
            "opentel-mcp: service_name was provided but setup_sdk is False, so it has no effect. Resource "
            "attributes come from the TracerProvider the host application registered.",
        )
    url = exporter_url if isinstance(exporter_url, str) and exporter_url.strip() else None
    if exporter_url is not None and url is None:
        _warn_once("exporter_url_value", "opentel-mcp: exporter_url must be a non-empty string; ignoring it.")
    if url is not None and not sdk:
        _warn_once(
            "exporter_url_ignored", "opentel-mcp: exporter_url has no effect unless setup_sdk is True."
        )
        url = None

    tracing = sdk_tracing
    if tracing not in SDK_TRACING_MODES:
        _warn_once(
            "sdk_tracing",
            "opentel-mcp: sdk_tracing must be 'replace' or 'enrich' (got %r); using 'replace'.",
            sdk_tracing,
        )
        tracing = "replace"

    return Options(
        enabled=_bool("enabled", enabled, True),
        enable_metrics=_bool("enable_metrics", enable_metrics, True),
        fingerprinting=_bool("fingerprinting", fingerprinting, True),
        error_recording=resolve_error_recording_config(error_recording),
        setup_sdk=sdk,
        service_name=service_name.strip() if has_name else None,
        exporter_url=url,
        flush_timeout_ms=_flush_timeout(flush_on_exit, sdk),
        sdk_tracing=str(tracing),
    )
