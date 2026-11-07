"""Shared sensitive-tool matching fixtures (``sensitive-tools.json``) against the Python port (ADR 032). No mcp SDK needed."""

from __future__ import annotations

from typing import Any

import pytest

from opentel_mcp._sensitive import compile_sensitive_tools
from tests.conftest import py_cases

SENSITIVE_CASES = py_cases("cases/sensitive-tools.json")


def test_suite_is_nontrivial() -> None:
    assert len(SENSITIVE_CASES) > 30


@pytest.mark.parametrize("case", SENSITIVE_CASES, ids=lambda c: str(c["id"]))
def test_conformance_sensitive_matching(case: dict[str, Any]) -> None:
    matcher = compile_sensitive_tools(case["input"]["patterns"], lambda *a, **k: None)
    actual = {
        "size": 0 if matcher is None else matcher.size,
        "matches": [False if matcher is None else matcher.matches(n) for n in case["input"]["names"]],
    }
    assert actual == case["expect"]
