"""Opt-in secret leak detection in tool outputs (port of ``secret-leak.js``, ADR 030).

Reuses the detectors that scrub error text (``_secrets``) on the ``text`` items of a ``tools/call`` result and reports
only THAT a secret-shaped string was returned: a boolean, a bounded list of secret TYPES and a count. The matched text,
its position and its context are never kept, recorded or logged.

The scan budget ``max_scan_bytes`` is measured in **UTF-16 code units** (JavaScript string length), not bytes and not
Python code points, so the same result is cut at the same place in both languages (an astral character such as an emoji
spends two units). Text is scanned in 4096-unit windows that overlap by 256 units, so adversarial input makes each
window quadratic at worst, not the whole result.

A signal, not a guarantee: pattern-based detection misses formats and fires on look-alikes.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from opentelemetry.trace import Span

from . import _contract as c
from ._jsre import to_u16
from ._secrets import detect_secret_types_u16
from ._wire import unwrap

logger = logging.getLogger("opentel_mcp")


@dataclass(frozen=True)
class SecretLeakConfig:
    enabled: bool = False
    max_scan_bytes: int = c.DEFAULT_MAX_SCAN_BYTES


@dataclass(frozen=True)
class ScanResult:
    types: frozenset[str]
    count: int
    truncated: bool


def resolve_secret_leak_config(value: Any, warn: Callable[..., None]) -> SecretLeakConfig:
    """Resolve ``secret_leak_detection``. Never raises; invalid values warn once (naming the option, never the value)."""
    try:
        if value is None:
            return SecretLeakConfig()
        if not isinstance(value, Mapping):
            warn(
                "secret_leak:shape",
                "opentel-mcp: secret_leak_detection must be a dict like {'enabled': True}; ignoring it. See ADR 030.",
            )
            return SecretLeakConfig()
        enabled = False
        max_scan = c.DEFAULT_MAX_SCAN_BYTES
        if "enabled" in value and value["enabled"] is not None:
            if isinstance(value["enabled"], bool):
                enabled = value["enabled"]
            else:
                warn(
                    "secret_leak:enabled",
                    "opentel-mcp: secret_leak_detection['enabled'] must be a bool; secret leak detection stays off. "
                    "See ADR 030.",
                )
        raw = value.get("max_scan_bytes")
        if raw is not None:
            if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
                max_scan = raw
            elif isinstance(raw, float) and raw.is_integer() and raw > 0 and raw < 2**63:
                max_scan = int(raw)  # JS Number.isInteger(4096.0) is true
            else:
                warn(
                    "secret_leak:max_scan_bytes",
                    "opentel-mcp: secret_leak_detection['max_scan_bytes'] must be a positive integer; using %d. "
                    "See ADR 030.",
                    c.DEFAULT_MAX_SCAN_BYTES,
                )
        return SecretLeakConfig(enabled, max_scan)
    except Exception:
        with contextlib.suppress(Exception):
            warn(
                "secret_leak:read",
                "opentel-mcp: could not read the secret_leak_detection option; secret leak detection stays off. "
                "See ADR 030.",
            )
        return SecretLeakConfig()


def _content_items(result: Any) -> list[Any] | tuple[Any, ...] | None:
    r = unwrap(result)
    content = r.get("content") if isinstance(r, Mapping) else getattr(r, "content", None)
    return content if isinstance(content, (list, tuple)) else None


def _text_of(item: Any) -> str | None:
    """The ``text`` of a ``type == "text"`` item (dict or model); ``None`` for anything else."""
    if item is None:
        return None
    if isinstance(item, Mapping):
        kind, text = item.get("type"), item.get("text")
    else:
        kind, text = getattr(item, "type", None), getattr(item, "text", None)
    return text if kind == "text" and isinstance(text, str) else None


def scan_result_for_secrets(result: Any, max_scan: int) -> ScanResult | None:
    """Scan the text items of a result, up to ``max_scan`` UTF-16 code units in total. Never raises.

    ``None`` when the result has no scannable ``content`` or could not be read.
    """
    try:
        content = _content_items(result)
        if content is None:
            return None
        types: set[str] = set()
        count = 0
        truncated = False
        remaining = max_scan
        limit = min(len(content), c.MAX_CONTENT_ITEMS)
        for i in range(limit):
            text = _text_of(content[i])
            if text is None or text == "":
                continue
            if remaining <= 0:
                truncated = True
                break
            # Convert only as much as the budget can use (a code point is at least one unit): bounds the work on a
            # huge item. ``units`` is the whole text when it fits, else a prefix longer than the budget.
            units = to_u16(text[: remaining + 1])
            if len(units) > remaining:
                truncated = True
                take = units[:remaining]
            else:
                take = units
            remaining -= len(take)
            for start in range(0, len(take), c.SCAN_CHUNK_SIZE):
                found_types, found = detect_secret_types_u16(
                    take[start : min(len(take), start + c.SCAN_CHUNK_SIZE + c.SCAN_CHUNK_OVERLAP)]
                )
                types.update(found_types)
                count += found
                if count >= c.MAX_DETECTED_MATCHES:
                    return ScanResult(frozenset(types), c.MAX_DETECTED_MATCHES, truncated)
        if len(content) > limit:
            truncated = True
        return ScanResult(frozenset(types), count, truncated)
    except Exception:
        return None


def apply_secret_leak(
    span: Span, record_metric: Callable[[], None], result: Any, config: SecretLeakConfig
) -> None:
    """Scan a result and, when something secret-shaped is found, set the ADR 030 span attributes and count the leak.

    Never changes span status. Never raises. Only derived signals leave this function.
    """
    try:
        if not config.enabled:
            return
        scan = scan_result_for_secrets(result, config.max_scan_bytes)
        if scan is None:
            return
        if span.is_recording():
            if scan.types:
                span.set_attribute(c.ATTR_SECRET_LEAK_DETECTED, True)
                span.set_attribute(c.ATTR_SECRET_LEAK_TYPES, sorted(scan.types))
                span.set_attribute(c.ATTR_SECRET_LEAK_COUNT, scan.count)
            if scan.truncated:
                span.set_attribute(c.ATTR_SECRET_LEAK_SCAN_TRUNCATED, True)
        if scan.types:
            record_metric()
    except Exception as exc:
        with contextlib.suppress(Exception):
            logger.debug(
                "opentel-mcp: secret leak detection failed for this call; skipped (%s).", type(exc).__name__
            )
