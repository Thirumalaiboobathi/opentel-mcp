"""Shared secret-detection fixtures (``secret-types.json``, ``secret-scan.json``) against the Python port (ADR 030)."""

from __future__ import annotations

from typing import Any

import pytest

from opentel_mcp._leak import scan_result_for_secrets
from opentel_mcp._secrets import detect_secret_types
from tests.conftest import py_cases

TYPES = py_cases("cases/secret-types.json")
SCANS = py_cases("cases/secret-scan.json")


def _id(case: dict[str, Any]) -> str:
    return str(case["id"])


def test_suite_is_nontrivial() -> None:
    assert len(TYPES) > 40
    assert len(SCANS) > 40


@pytest.mark.parametrize("case", TYPES, ids=_id)
def test_secret_types(case: dict[str, Any]) -> None:
    types, count = detect_secret_types(case["input"]["text"])
    assert {"types": sorted(types), "count": count} == case["expect"]


@pytest.mark.parametrize("case", SCANS, ids=_id)
def test_secret_scan(case: dict[str, Any]) -> None:
    scan = scan_result_for_secrets(case["input"]["result"], case["input"]["maxScanBytes"])
    actual = (
        {"scan": None}
        if scan is None
        else {"scan": {"types": sorted(scan.types), "count": scan.count, "truncated": scan.truncated}}
    )
    assert actual == case["expect"]
