"""Regex-source parity (ADR 028 Finding 5): the Python tables must not drift from core's regexes."""

from __future__ import annotations

from typing import Any

from opentel_mcp import _classify, _normalize, _secrets
from tests.conftest import load_conformance


def _flags(flags: str) -> str:
    return "".join(sorted(flags.replace("g", "")))


def _steps(js: list[dict[str, str]], mine: tuple[tuple[str, str, str], ...]) -> None:
    assert len(js) == len(mine)
    for j, (source, flags, replacement) in zip(js, mine, strict=True):
        assert source == j["source"]
        assert _flags(flags) == _flags(j["flags"])
        assert replacement == j["replacement"]


def test_secret_steps_match_core() -> None:
    patterns: Any = load_conformance("patterns.json")
    assert patterns["secretPlaceholder"] == _secrets.SECRET_PLACEHOLDER
    _steps(patterns["secretSteps"], _secrets.SECRET_STEP_SOURCES)


def test_normalize_steps_match_core() -> None:
    _steps(load_conformance("patterns.json")["normalizeSteps"], _normalize.NORMALIZE_STEP_SOURCES)


def test_classifier_regexes_match_core() -> None:
    private = load_conformance("patterns.json")["privateRegexes"]
    mine = {
        "classify/validation.js#MESSAGE_RE": (_classify.VALIDATION_MESSAGE_RE, "i"),
        "classify/timeout.js#MESSAGE_RE": (_classify.TIMEOUT_MESSAGE_RE, "i"),
        "classify/network.js#MESSAGE_RE": (_classify.NETWORK_MESSAGE_RE, "i"),
        "classify/auth.js#MESSAGE_RE": (_classify.AUTH_MESSAGE_RE, "i"),
        "classify/serialization.js#JSON_RE": (_classify.SERIALIZATION_JSON_RE, "i"),
        "classify/serialization.js#UNEXPECTED_TOKEN_RE": (_classify.SERIALIZATION_UNEXPECTED_TOKEN_RE, "i"),
        "classify/channel.js#NOT_FOUND_RE": (_classify.NOT_FOUND_RE_SRC, "i"),
        "classify/channel.js#DISABLED_RE": (_classify.DISABLED_RE_SRC, "i"),
        "classify/channel.js#MCP_ERROR_WRAPPER_RE": (_classify.MCP_ERROR_WRAPPER_RE_SRC, ""),
    }
    assert set(mine) == set(private)
    for key, (source, flags) in mine.items():
        assert source == private[key]["source"], key
        assert flags == private[key]["flags"], key


def test_classifier_tables_match_core() -> None:
    tables = load_conformance("patterns.json")["classifierTables"]
    mine: dict[str, Any] = {
        "validation#KNOWN_NAMES": _classify.VALIDATION_KNOWN_NAMES,
        "timeout#KNOWN_NAMES": _classify.TIMEOUT_KNOWN_NAMES,
        "timeout#KNOWN_CODES": _classify.TIMEOUT_KNOWN_CODES,
        "network#KNOWN_CODES": _classify.NETWORK_KNOWN_CODES,
        "auth#KNOWN_STATUSES": _classify.AUTH_KNOWN_STATUSES,
        "auth#KNOWN_NAMES": _classify.AUTH_KNOWN_NAMES,
        "auth#KNOWN_CODES": _classify.AUTH_KNOWN_CODES,
        "dependency#KNOWN_NAMES": _classify.DEPENDENCY_KNOWN_NAMES,
        "dependency#KNOWN_PREFIXES": _classify.DEPENDENCY_KNOWN_PREFIXES,
    }
    assert set(mine) == set(tables)
    for key, value in mine.items():
        assert sorted(value) == sorted(tables[key]), key
