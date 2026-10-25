"""Turning a failure value into the JS ``{name, message, stack, code, status}`` record.

Port of ``fingerprint/normalize/exception.js``'s ``coerceError`` with the Python
rules from ADR 028 Finding 5 ("Coercing a Python exception").
"""

from __future__ import annotations

import errno
import traceback
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any


@dataclass
class Coerced:
    name: Any
    message: Any
    #: Rendered stack text (Python ``traceback`` format, or caller supplied). ``None`` when there is none.
    stack: str | None = None
    code: Any = None
    status: Any = None
    #: Live traceback for Python exceptions, so frames are read structurally, never re-parsed.
    tb: TracebackType | None = field(default=None, repr=False)
    #: Raw frames (outermost first) given directly, used by synthetic conformance cases.
    frames: list[tuple[str, int | None, str]] | None = field(default=None, repr=False)
    is_exception: bool = False


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _mcp_error_parts(exc: BaseException) -> tuple[int, str] | None:
    """``(jsonrpc_code, message)`` for mcp 1.x ``McpError`` / 2.x ``MCPError`` (duck typed, no import)."""
    error = getattr(exc, "error", None)
    code = _int_or_none(getattr(error, "code", None))
    message = getattr(error, "message", None)
    if code is not None and isinstance(message, str):
        return code, message
    return None


def exception_status(exc: BaseException) -> int | None:
    """``e.status``, then ``e.status_code``, then ``e.response.status_code``; ints only."""
    for source in (exc, getattr(exc, "response", None)):
        if source is None:
            continue
        names = ("status", "status_code") if source is exc else ("status_code",)
        for attr in names:
            try:
                value = _int_or_none(getattr(source, attr, None))
            except Exception:
                value = None
            if value is not None:
                return value
    return None


# Fallback when errno carries no usable POSIX name: the builtin exception type says what happened.
_OSERROR_TYPE_CODES: tuple[tuple[type[OSError], str], ...] = (
    (ConnectionRefusedError, "ECONNREFUSED"),
    (ConnectionResetError, "ECONNRESET"),
    (ConnectionAbortedError, "ECONNABORTED"),
    (BrokenPipeError, "EPIPE"),
    (TimeoutError, "ETIMEDOUT"),
)


def posix_errno_name(name: str | None) -> str | None:
    """``WSAECONNREFUSED`` -> ``ECONNREFUSED``: Windows reports Winsock names, Node (and Linux) the POSIX ones.

    Only ``E...`` names survive; anything else (``WSAHOST_NOT_FOUND``, ...) has no POSIX/Node equivalent.
    """
    if not name:
        return None
    if name.startswith("WSAE"):
        name = name[3:]
    return name if name.startswith("E") and name[1:].replace("_", "").isalnum() else None


def oserror_code(exc: OSError) -> str | None:
    """The Node-style code for an ``OSError``, identical on every OS."""
    name = posix_errno_name(errno.errorcode.get(exc.errno)) if isinstance(exc.errno, int) else None
    if name:
        return name
    for kind, code in _OSERROR_TYPE_CODES:
        if isinstance(exc, kind):
            return code
    return None


def exception_code(exc: BaseException) -> Any:
    """``e.code`` if a ``str``; ``errno.errorcode[e.errno]`` for ``OSError``; the JSON-RPC code for MCP errors."""
    try:
        code = getattr(exc, "code", None)
    except Exception:
        code = None
    if isinstance(code, str) and code:
        return code
    if isinstance(exc, OSError):
        name = oserror_code(exc)
        if name:
            return name
    mcp = _mcp_error_parts(exc)
    if mcp is not None:
        return mcp[0]
    return None


def format_traceback(exc: BaseException) -> str | None:
    """Standard ``traceback`` text (what ``span.record_exception`` records); ``None`` if it can't be rendered."""
    try:
        text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    except Exception:
        return None
    return text or None


def coerce_exception(exc: BaseException, *, with_stack_text: bool = False) -> Coerced:
    mcp = _mcp_error_parts(exc)
    try:
        message: Any = mcp[1] if mcp is not None else str(exc)
    except Exception:
        message = ""
    return Coerced(
        name=type(exc).__name__,
        message=message,
        stack=format_traceback(exc) if with_stack_text else None,
        code=exception_code(exc),
        status=exception_status(exc),
        tb=exc.__traceback__,
        is_exception=True,
    )


def _get(obj: Mapping[str, Any], key: str) -> Any:
    return obj.get(key)


def coerce_error(err: Any, *, with_stack_text: bool = False) -> Coerced:
    """Port of ``coerceError``. ``err`` is never ``None`` (callers filter that)."""
    if isinstance(err, str):
        return Coerced(name="Error", message=err)

    if isinstance(err, BaseException):
        return coerce_exception(err, with_stack_text=with_stack_text)

    if isinstance(err, Mapping):
        if err.get("isError") is True and isinstance(err.get("content"), list):
            content = err["content"]
            first = content[0] if content else None
            text = first.get("text") if isinstance(first, Mapping) else None
            return Coerced(name="MCPToolError", message="" if text is None else text)
        name = _get(err, "name")
        message = _get(err, "message")
        stack = _get(err, "stack")
        frames = err.get("frames") if isinstance(err.get("frames"), list) else None
        status = _get(err, "status")
        if status is None:
            status = _get(err, "statusCode")
        return Coerced(
            name="Error" if name is None else name,
            message="[object Object]" if message is None else message,
            stack=stack if isinstance(stack, str) else None,
            code=_get(err, "code"),
            status=status,
            frames=[(f["filename"], f.get("lineno"), f["name"]) for f in frames] if frames else None,
        )

    return Coerced(name="Error", message=str(err))
