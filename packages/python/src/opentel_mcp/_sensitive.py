"""Sensitive tool auditing (port of ``sensitive-tools.js``, ADR 032).

A list of tool names (exact, or with ``*`` wildcards) the operator wants a reviewable record of. A matching call gets
the boolean span attribute ``mcp.tool.sensitive`` and one ``mcp.audit.sensitive_call`` span event with the outcome,
duration and (on failure, when computed) the failure category. Never arguments, never results.

Matching is a linear glob (split on ``*``), never a regular expression built from user text, so a hostile pattern or
tool name cannot cause catastrophic backtracking. Lengths and positions are counted in UTF-16 code units, like core,
so a name matches in Python exactly when it matches in JS.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Callable
from typing import Any

from opentelemetry.trace import Span

from . import _contract as c
from ._jsre import to_u16


class SensitiveToolMatcher:
    """Compiled ``sensitive_tools``. ``size`` is the number of distinct exact names plus wildcard patterns."""

    __slots__ = ("_exact", "_globs", "size")

    def __init__(self, exact: set[str], globs: list[list[str]]) -> None:
        self._exact = exact
        self._globs = globs
        self.size = len(exact) + len(globs)

    def matches(self, tool_name: Any) -> bool:
        if not isinstance(tool_name, str):
            return False
        name = to_u16(tool_name)
        if name in self._exact:
            return True
        if not self._globs or len(name) > c.MAX_MATCHED_NAME_LENGTH:
            return False
        return any(_glob_matches(segments, name) for segments in self._globs)


def _glob_matches(segments: list[str], name: str) -> bool:
    """Linear-time glob: ``*`` matches any run of characters (including none); everything else is literal."""
    first, last = segments[0], segments[-1]
    if not name.startswith(first):
        return False
    if len(name) < len(first) + len(last) or not name.endswith(last):
        return False
    position = len(first)
    end = len(name) - len(last)
    for segment in segments[1:-1]:
        found = name.find(segment, position)
        if found == -1 or found + len(segment) > end:
            return False
        position = found + len(segment)
    return position <= end


def compile_sensitive_tools(value: Any, warn: Callable[..., None]) -> SensitiveToolMatcher | None:
    """Compile the option once. Never raises: invalid entries and shapes warn once (never naming a value) and are skipped.

    Returns ``None`` when nothing valid was configured (the feature is off and costs nothing per call).
    """
    try:
        if value is None:
            return None
        if not isinstance(value, (list, tuple)):
            warn(
                "sensitive_tools:shape",
                "opentel-mcp: sensitive_tools must be a list of tool names; ignoring it. See ADR 032.",
            )
            return None
        exact: set[str] = set()
        globs: list[list[str]] = []
        skipped = 0
        entries = value[: c.MAX_SENSITIVE_PATTERNS]
        if len(value) > c.MAX_SENSITIVE_PATTERNS:
            skipped += len(value) - c.MAX_SENSITIVE_PATTERNS
        for entry in entries:
            if not isinstance(entry, str) or entry == "":
                skipped += 1
                continue
            u16 = to_u16(entry)
            if len(u16) > c.MAX_SENSITIVE_PATTERN_LENGTH:
                skipped += 1
                continue
            if "*" in u16:
                globs.append(u16.split("*"))
            else:
                exact.add(u16)
        if skipped:
            warn(
                "sensitive_tools:entries",
                "opentel-mcp: sensitive_tools: %d entr%s skipped (each must be a non-empty string of at most %d "
                "characters, and at most %d entries are used). See ADR 032.",
                skipped,
                "y was" if skipped == 1 else "ies were",
                c.MAX_SENSITIVE_PATTERN_LENGTH,
                c.MAX_SENSITIVE_PATTERNS,
            )
        matcher = SensitiveToolMatcher(exact, globs)
        return matcher if matcher.size else None
    except Exception:
        with contextlib.suppress(Exception):
            warn(
                "sensitive_tools:read",
                "opentel-mcp: could not read the sensitive_tools option; ignoring it. See ADR 032.",
            )
        return None


def mark_sensitive(span: Span) -> None:
    """Set the boolean marker attribute. Never raises."""
    with contextlib.suppress(Exception):
        span.set_attribute(c.ATTR_MCP_TOOL_SENSITIVE, True)


def record_sensitive_audit(
    span: Span, tool_name: str, outcome: str, duration_ms: float, failure_category: str = ""
) -> None:
    """Add the ``mcp.audit.sensitive_call`` event. Never raises; never arguments or results."""
    with contextlib.suppress(Exception):
        attributes: dict[str, Any] = {
            c.ATTR_GEN_AI_TOOL_NAME: tool_name,
            c.ATTR_MCP_TOOL_OUTCOME: outcome,
            # JS: Math.round(ms * 1000) / 1000
            c.ATTR_MCP_TOOL_DURATION_MS: math.floor(duration_ms * 1000 + 0.5) / 1000,
        }
        if failure_category:
            attributes[c.FINGERPRINT_ATTRIBUTE_KEYS["CATEGORY"]] = failure_category
        span.add_event(c.EVENT_AUDIT_SENSITIVE_CALL, attributes)
