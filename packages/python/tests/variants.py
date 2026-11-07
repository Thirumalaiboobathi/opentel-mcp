"""Shared parametrization for the security-signal tests: every supported mcp flavour x ``sdk_tracing`` mode."""

from __future__ import annotations

from typing import Any

from tests import harness
from tests.conftest import Telemetry

SDK_TRACING_MODES = ["replace", "enrich"] if harness.IS_V2 else ["replace"]


def _variants() -> list[tuple[str, str, bool]]:
    out = []
    for flavour in harness.flavours():
        for mode in SDK_TRACING_MODES:
            out.append((flavour, mode, False))
    return out


VARIANTS = _variants()
VARIANT_IDS = [f"{f}-{m}" for f, m, _ in VARIANTS]


def attrs(span: Any) -> dict[str, Any]:
    return dict(span.attributes or {})


def points(tel: Telemetry, name: str) -> list[tuple[dict[str, Any], Any]]:
    return tel.metric_points().get(name, [])


def total(tel: Telemetry, name: str) -> int:
    return int(sum(v for _, v in points(tel, name)))


def ours(span: Any) -> bool:
    """True for the span opentel-mcp started (``sdk_tracing="enrich"`` keeps the SDK's own span instead)."""
    return bool(span.instrumentation_scope.name == "opentel-mcp")
