"""Shared tool-integrity fixtures (``tool-hash.json``, ``integrity-tracker.json``) against the Python port (ADR 029)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from opentel_mcp._integrity import ToolIntegrityTracker, compute_tool_definition_hash
from tests.conftest import py_cases

HASHES = py_cases("cases/tool-hash.json")
TRACKERS = py_cases("cases/integrity-tracker.json")


def _id(case: dict[str, Any]) -> str:
    return str(case["id"])


def test_suite_is_nontrivial() -> None:
    assert len(HASHES) > 80
    assert len(TRACKERS) > 25


@pytest.mark.parametrize("case", HASHES, ids=_id)
def test_tool_definition_hash_matches_js_exactly(case: dict[str, Any]) -> None:
    definition = json.loads(case["input"]["definitionJson"])
    assert {"hash": compute_tool_definition_hash(definition)} == case["expect"]


def _drop_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _drop_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_drop_none(v) for v in value]
    return value


@pytest.mark.parametrize("case", TRACKERS, ids=_id)
def test_tracker_sequences(case: dict[str, Any]) -> None:
    tracker = ToolIntegrityTracker(case["input"]["pins"])
    steps = []
    for step in case["input"]["steps"]:
        obs = tracker.observe(step["tools"], step["complete"])
        findings = []
        for f in obs.findings:
            item = {"kind": f.kind, "tool": f.tool}
            for key, value in (
                ("oldHash", f.old_hash),
                ("newHash", f.new_hash),
                ("expected", f.expected),
                ("actual", f.actual),
            ):
                if value is not None:
                    item[key] = value
            findings.append(item)
        steps.append(
            {
                "findings": findings,
                "violationTools": obs.violation_tools,
                "firstSnapshot": obs.first_snapshot,
            }
        )
    expected = {"steps": steps, "hashes": tracker.get_hashes()}
    # JSON.stringify drops an undefined firstSnapshot; Python keeps None -> compare after dropping both
    assert _drop_none(expected) == _drop_none(case["expect"])
