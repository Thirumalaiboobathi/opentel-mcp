"""Tool definition integrity ("rug pull" detection), a port of ``tool-integrity/*`` (ADR 029).

* :func:`compute_tool_definition_hash` -- ``"sha256:" + <64 hex>`` over a canonical JSON serialization of exactly the
  text and structure a model reads to decide what a tool does: ``name``, ``title``, ``description``, ``inputSchema``,
  ``outputSchema``, ``annotations`` (each only when present). The canonical text must be **byte-identical** with the JS
  implementation, so it reproduces JavaScript's rules rather than Python's ``json.dumps``:

  - object keys sorted by UTF-16 code unit (not by code point: an astral key sorts before U+E000..U+FFFF),
  - array order kept, no whitespace,
  - ``JSON.stringify`` string escaping (lower-case ``\\u00xx``, lone surrogates escaped, U+2028/9 and DEL raw),
  - ECMAScript ``Number::toString`` for numbers (``1`` and ``1.0`` are the same; ``-0`` is ``0``; ``1e21`` is
    ``1e+21``; integers beyond 2**53 are rounded to a double first, as ``JSON.parse`` would; non-finite -> ``null``),
  - no Unicode normalization, and a key named ``__proto__`` is hashed like any other.

* :class:`ToolIntegrityTracker` -- pure, edge-triggered change / pin-mismatch / added / removed detection.
* :class:`ToolIntegrityObserver` -- the OpenTelemetry glue: events on the ``tools/list`` span, the
  ``mcp.tool.integrity_violations`` counter and the dev-mode ``pins`` snippet.

Only tool names and hashes ever leave this module: never description, schema or annotation text.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from opentelemetry.trace import Span

from . import _contract as c
from ._jsre import to_u16

logger = logging.getLogger("opentel_mcp")

#: Nesting deeper than this is treated as unhashable (also stops cyclic structures).
MAX_DEPTH = 256
_HASH_RE = re.compile(c.TOOL_HASH_PATTERN)
_SURROGATE_RANGE = range(0xD800, 0xE000)


# --------------------------------------------------------------------------------------------------------------
# canonical JSON (ECMAScript JSON.stringify, keys sorted by UTF-16 code unit)
# --------------------------------------------------------------------------------------------------------------

_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def js_quote(s: str) -> str:
    """``JSON.stringify(s)`` for a string (well-formed JSON.stringify: lone surrogates become ``\\udxxx``)."""
    out = ['"']
    for ch in s:
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
            continue
        cp = ord(ch)
        if cp < 0x20 or cp in _SURROGATE_RANGE:
            out.append(f"\\u{cp:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(value: int | float) -> str:
    """``JSON.stringify(number)``: ECMAScript ``Number::toString`` for finite values, ``null`` otherwise."""
    try:
        x = float(value)  # int -> nearest double, exactly what JSON.parse yields for the same digits
    except OverflowError:
        return "null"
    if x != x or x in (float("inf"), float("-inf")):
        return "null"
    if x == 0:
        return "0"  # also -0
    sign = "-" if x < 0 else ""
    x = abs(x)
    d = Decimal(repr(x))  # repr is the shortest round-trip digit string, like ECMAScript's
    _, raw_digits, exp = d.as_tuple()
    digits = "".join(map(str, raw_digits))
    stripped = digits.rstrip("0")
    exp = int(exp) + (len(digits) - len(stripped))
    digits = stripped or "0"
    k = len(digits)
    n = k + exp  # value = 0.digits * 10**n
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mant = digits if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _canonical(value: Any, depth: int) -> str:
    if depth > MAX_DEPTH:
        raise RecursionError("too deep")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return js_quote(value)
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(v, depth + 1) for v in value) + "]"
    if isinstance(value, Mapping):
        items: list[tuple[str, Any]] = []
        for key in value:
            if not isinstance(key, str):
                raise TypeError("non-string key")
            items.append((key, value[key]))
        items.sort(key=lambda kv: to_u16(kv[0]))  # UTF-16 code-unit order == Array.prototype.sort() default
        return "{" + ",".join(f"{js_quote(k)}:{_canonical(v, depth + 1)}" for k, v in items) + "}"
    raise TypeError(f"not JSON: {type(value).__name__}")


# Python-model attribute spellings per hashed field (mcp 1.x uses camelCase attributes, 2.x snake_case).
_ATTRS: dict[str, tuple[str, ...]] = {
    "name": ("name",),
    "title": ("title",),
    "description": ("description",),
    "inputSchema": ("inputSchema", "input_schema"),
    "outputSchema": ("outputSchema", "output_schema"),
    "annotations": ("annotations",),
}


def _field(definition: Any, name: str) -> Any:
    """The raw value of a hashed field, or ``_ABSENT``.

    A ``Mapping`` is read key by key (``None`` is PRESENT: JS keeps ``null``). A Python model (mcp ``Tool``) uses ``None``
    for "not provided", which the wire omits, so ``None`` means absent there. Never raises past the caller's guard.
    """
    if isinstance(definition, Mapping):
        return definition.get(name, _ABSENT)  # type: ignore[no-any-return]
    for attr in _ATTRS[name]:
        value = getattr(definition, attr, None)
        if value is not None:
            if name == "annotations" and not isinstance(value, Mapping):
                dump = getattr(value, "model_dump", None)
                if callable(dump):
                    value = dump(by_alias=True, mode="json", exclude_none=True)
            return value
    return _ABSENT


class _Absent:
    __slots__ = ()


_ABSENT: Any = _Absent()


def canonical_tool_definition(definition: Any) -> str | None:
    """The canonical JSON text that is hashed, or ``None`` when it cannot be produced. Never log or export it."""
    try:
        if definition is None or isinstance(definition, (str, bytes, int, float, bool)):
            return None
        if isinstance(definition, (list, tuple)):
            # JS: typeof [] === "object" and an array has none of the hashed fields, so it hashes like {} (a quirk
            # pinned by the shared fixture ``not-an-object-array``).
            return _canonical({}, 0)
        if (
            not isinstance(definition, Mapping)
            and not hasattr(definition, "__dict__")
            and not hasattr(definition, "__slots__")
        ):
            return None
        picked: dict[str, Any] = {}
        for name in c.HASHED_DEFINITION_FIELDS:
            value = _field(definition, name)
            if value is not _ABSENT:
                picked[name] = value
        return _canonical(picked, 0)
    except Exception:
        return None


def compute_tool_definition_hash(definition: Any) -> str | None:
    """``"sha256:" + <64 hex>`` over the canonical JSON of a tool definition; byte-identical with the JS package.

    ``definition`` is one entry of a ``tools/list`` response: a mapping (``{"name": ..., "inputSchema": ...}``) or an
    mcp ``Tool`` model. Covers ``name``, ``title``, ``description``, ``inputSchema``, ``outputSchema`` and
    ``annotations`` (those present); ``_meta``, ``icons`` and vendor keys are not covered. Use it to compute the values
    for ``tool_integrity={"pins": {...}}``. Never raises; returns ``None`` for something that is not a hashable
    definition (not an object, cyclic or deeper than 256 levels, not JSON-representable).
    """
    text = canonical_tool_definition(definition)
    if text is None:
        return None
    return c.TOOL_HASH_PREFIX + hashlib.sha256(text.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------------------------------
# option
# --------------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolIntegrityConfig:
    enabled: bool = False
    pins: Mapping[str, str] = field(default_factory=dict)


def resolve_tool_integrity_config(value: Any, warn: Callable[..., None]) -> ToolIntegrityConfig:
    """Resolve ``tool_integrity``. Never raises; invalid input warns once (naming the option, never a value)."""
    try:
        if value is None:
            return ToolIntegrityConfig()
        if not isinstance(value, Mapping):
            warn(
                "tool_integrity:shape",
                "opentel-mcp: tool_integrity must be a dict like {'enabled': True}; ignoring it. See ADR 029.",
            )
            return ToolIntegrityConfig()
        enabled = False
        pins: dict[str, str] = {}
        raw_enabled = value.get("enabled")
        if raw_enabled is not None:
            if isinstance(raw_enabled, bool):
                enabled = raw_enabled
            else:
                warn(
                    "tool_integrity:enabled",
                    "opentel-mcp: tool_integrity['enabled'] must be a bool; tool integrity stays off. See ADR 029.",
                )
        raw_pins = value.get("pins")
        if raw_pins is not None:
            if not isinstance(raw_pins, Mapping):
                warn(
                    "tool_integrity:pins_shape",
                    "opentel-mcp: tool_integrity['pins'] must be a dict of tool name -> 'sha256:<64 hex>'; "
                    "ignoring it. See ADR 029.",
                )
            else:
                skipped = 0
                names = list(raw_pins)
                if len(names) > c.MAX_PINS:
                    skipped += len(names) - c.MAX_PINS
                for name in names[: c.MAX_PINS]:
                    pin = raw_pins[name]
                    if isinstance(name, str) and isinstance(pin, str) and _HASH_RE.fullmatch(pin):
                        pins[name] = pin
                    else:
                        skipped += 1
                if skipped:
                    warn(
                        "tool_integrity:pins",
                        "opentel-mcp: tool_integrity['pins']: %d entr%s skipped (each value must match "
                        "sha256:<64 lowercase hex>, and at most %d pins are used). See ADR 029.",
                        skipped,
                        "y was" if skipped == 1 else "ies were",
                        c.MAX_PINS,
                    )
        return ToolIntegrityConfig(enabled, pins)
    except Exception:
        with contextlib.suppress(Exception):
            warn(
                "tool_integrity:read",
                "opentel-mcp: could not read the tool_integrity option; tool integrity stays off. See ADR 029.",
            )
        return ToolIntegrityConfig()


# --------------------------------------------------------------------------------------------------------------
# tracker (pure)
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Finding:
    kind: str  # changed | pin_mismatch | added | removed
    tool: str
    old_hash: str | None = None
    new_hash: str | None = None
    expected: str | None = None
    actual: str | None = None


@dataclass
class Observation:
    findings: list[Finding] = field(default_factory=list)
    #: Tools that newly reported ``changed`` and/or ``pin_mismatch`` (once each).
    violation_tools: list[str] = field(default_factory=list)
    #: The hashes of the first observation that produced any (a complete listing); otherwise ``None``.
    first_snapshot: dict[str, str] | None = None


@dataclass
class _Entry:
    first: str
    last: str
    reported_changed: str | None = None
    reported_pin: str | None = None


def _name_of(tool: Any) -> Any:
    if isinstance(tool, Mapping):
        return tool.get("name")
    return getattr(tool, "name", None)


class ToolIntegrityTracker:
    """State per server instance (not per session). Events are edge-triggered: they fire when a tool's classification
    changes, so a persistent mismatch is reported once per distinct hash, not on every ``tools/list``."""

    def __init__(self, pins: Mapping[str, str]) -> None:
        self._pins = dict(pins)
        self._tools: dict[str, _Entry] = {}
        #: Tool names (in listing order, like a JS Set) of the last COMPLETE listing, or ``None`` before one.
        self._present: dict[str, None] | None = None
        self._current: dict[str, str] = {}
        self._snapshot_taken = False

    def observe(self, tools: Any, complete: bool) -> Observation:
        """Observe one ``tools/list`` response. Never raises."""
        out = Observation()
        try:
            listing = list(tools) if isinstance(tools, (list, tuple)) else []
            seen_now: dict[str, None] = {}
            for tool in listing[: c.MAX_TRACKED_TOOLS]:
                try:
                    name = _name_of(tool)
                except Exception:
                    continue
                if not isinstance(name, str) or name == "":
                    continue
                digest = compute_tool_definition_hash(tool)
                if digest is None:
                    continue
                seen_now[name] = None
                self._current[name] = digest

                entry = self._tools.get(name)
                if entry is None:
                    if len(self._tools) >= c.MAX_TRACKED_TOOLS:
                        continue
                    entry = _Entry(digest, digest)
                    self._tools[name] = entry

                violated = False
                if digest != entry.first:
                    if digest != entry.reported_changed:
                        out.findings.append(Finding("changed", name, old_hash=entry.first, new_hash=digest))
                        entry.reported_changed = digest
                        violated = True
                else:
                    entry.reported_changed = None

                pin = self._pins.get(name)
                if pin is not None:
                    if digest != pin:
                        if digest != entry.reported_pin:
                            out.findings.append(Finding("pin_mismatch", name, expected=pin, actual=digest))
                            entry.reported_pin = digest
                            violated = True
                    else:
                        entry.reported_pin = None
                if violated:
                    out.violation_tools.append(name)

                # Not in the previous complete listing (new, or back after being absent): added.
                if complete and self._present is not None and name not in self._present:
                    out.findings.append(Finding("added", name, new_hash=digest))
                entry.last = digest

            if complete:
                if self._present is not None:
                    for name in self._present:
                        if name not in seen_now:
                            known = self._tools.get(name)
                            out.findings.append(
                                Finding("removed", name, old_hash=known.last if known is not None else None)
                            )
                            self._current.pop(name, None)
                self._present = seen_now

            if not self._snapshot_taken and complete and self._current:
                self._snapshot_taken = True
                out.first_snapshot = self.get_hashes()
        except Exception:
            pass  # never raise into tools/list
        return out

    def get_hashes(self) -> dict[str, str]:
        """The current ``{tool name: hash}`` map from the latest observations."""
        return dict(self._current)


# --------------------------------------------------------------------------------------------------------------
# OpenTelemetry glue
# --------------------------------------------------------------------------------------------------------------


def format_pins_snippet(hashes: Mapping[str, str]) -> str:
    """The dev-mode ``tool_integrity`` snippet printed once to stderr (never stdout: stdio transports use it)."""
    lines = [
        f"            {js_quote(name)}: {js_quote(hashes[name])}," for name in sorted(hashes, key=to_u16)
    ]
    return (
        "[opentel-mcp] tool_integrity: current tool definition hashes. To pin them, pass:\n"
        "    tool_integrity={\n"
        '        "enabled": True,\n'
        '        "pins": {\n' + "\n".join(lines) + "\n        },\n"
        "    },\n"
    )


class ToolIntegrityObserver:
    """Per instrumented server: the tracker plus emission. ``observe`` never raises."""

    def __init__(
        self,
        config: ToolIntegrityConfig,
        record_violation: Callable[[str], None] | None,
        *,
        print_pins: bool,
    ) -> None:
        self.tracker = ToolIntegrityTracker(config.pins)
        self._record_violation = record_violation
        self._print_pins = print_pins

    def observe(self, tools: Any, complete: bool, span: Span) -> None:
        try:
            observation = self.tracker.observe(tools, complete)
            self._emit(observation, span)
            if self._print_pins and observation.first_snapshot:
                with contextlib.suppress(Exception):
                    sys.stderr.write(format_pins_snippet(observation.first_snapshot))
        except Exception as exc:
            with contextlib.suppress(Exception):
                logger.debug(
                    "opentel-mcp: tool integrity check failed, skipping mcp.tool.integrity.* telemetry for this "
                    "tools/list call (%s).",
                    type(exc).__name__,
                )

    def _emit(self, observation: Observation, span: Span) -> None:
        if self._record_violation is not None:
            for tool in observation.violation_tools:
                with contextlib.suppress(Exception):
                    self._record_violation(tool)
        try:
            if not span.is_recording():
                return
        except Exception:
            return
        for f in observation.findings:
            try:
                attrs: dict[str, str] = {c.ATTR_GEN_AI_TOOL_NAME: f.tool}
                if f.kind == "changed":
                    name = c.EVENT_INTEGRITY_CHANGED
                    attrs[c.ATTR_INTEGRITY_OLD_HASH] = str(f.old_hash)
                    attrs[c.ATTR_INTEGRITY_NEW_HASH] = str(f.new_hash)
                elif f.kind == "pin_mismatch":
                    name = c.EVENT_INTEGRITY_PIN_MISMATCH
                    attrs[c.ATTR_INTEGRITY_EXPECTED_HASH] = str(f.expected)
                    attrs[c.ATTR_INTEGRITY_ACTUAL_HASH] = str(f.actual)
                    attrs[c.ATTR_INTEGRITY_SEVERITY] = c.INTEGRITY_SEVERITY_HIGH
                elif f.kind == "added":
                    name = c.EVENT_INTEGRITY_ADDED
                    attrs[c.ATTR_INTEGRITY_NEW_HASH] = str(f.new_hash)
                else:
                    name = c.EVENT_INTEGRITY_REMOVED
                    if f.old_hash:
                        attrs[c.ATTR_INTEGRITY_OLD_HASH] = f.old_hash
                span.add_event(name, attrs)
            except Exception:
                continue
