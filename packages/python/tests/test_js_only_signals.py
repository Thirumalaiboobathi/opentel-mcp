"""ADR 034: the v0.18 core signals are recorded in the contract as JS-only; the Python port must not claim them."""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "opentel_mcp"


@pytest.fixture(scope="module")
def js_only() -> Any:
    return json.loads((ROOT / "conformance" / "contract.json").read_text(encoding="utf-8"))["jsOnly"]


def _names(js_only: Any) -> list[str]:
    return [
        *js_only["spanAttributes"],
        *(e["name"] for e in js_only["spanEvents"]),
        *(m["name"] for m in js_only["metrics"]),
    ]


def test_contract_lists_the_js_only_signals(js_only: Any) -> None:
    assert js_only["since"] == "core 0.18.0"
    assert "mcp.tool.integrity.pin_mismatch" in _names(js_only)
    assert "mcp.tool.secret_leaks" in _names(js_only)
    assert "mcp.tool.auth_failures" in _names(js_only)
    assert "mcp.tool.freshness.clock_skew_ms" in _names(js_only)


def test_python_does_not_emit_any_js_only_signal(js_only: Any) -> None:
    """A future partial port must move the entry into the contract proper, not quietly start emitting it."""
    source = "\n".join(p.read_text(encoding="utf-8") for p in SRC.rglob("*.py"))
    leaked = [name for name in _names(js_only) if name in source]
    assert leaked == []
