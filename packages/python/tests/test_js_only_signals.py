"""ADR 034 (amended): what stays JS-only after contract version 2 -- clock skew only. Python must not claim it."""

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


def test_contract_lists_only_clock_skew_as_js_only(js_only: Any) -> None:
    assert js_only["since"] == "core 0.18.0"
    assert js_only["spanAttributes"] == ["mcp.tool.freshness.clock_skew_ms"]
    assert js_only["options"] == ["staleness.clockSkewToleranceMs"]
    assert set(js_only) == {"since", "spanAttributes", "options"}


def test_python_does_not_emit_any_js_only_signal(js_only: Any) -> None:
    """Staleness is not ported: a future partial port must move the entry into the contract, not quietly emit it."""
    source = "\n".join(p.read_text(encoding="utf-8") for p in SRC.rglob("*.py"))
    leaked = [name for name in js_only["spanAttributes"] if name in source]
    assert leaked == []
    assert "clockSkewToleranceMs" not in source and "clock_skew_tolerance" not in source
