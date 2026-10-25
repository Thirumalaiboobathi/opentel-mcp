"""Failure classifiers and channel (ports of ``fingerprint/classify/*.js``).

The tables are byte-identical to JS on purpose (ADR 028 round-2 decision F):
the category is hashed into the fingerprint, so a Python-only rule would split
the same failure across languages.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from typing import Any

from ._coerce import Coerced
from ._jsre import compile_js

# --- category classifiers ----------------------------------------------------

VALIDATION_MESSAGE_RE = r"\binvalid\b|\bmust be\b|\brequired\b"
TIMEOUT_MESSAGE_RE = r"\btimed out\b|\btimeout\b"
NETWORK_MESSAGE_RE = r"\bfetch failed\b|\bnetwork\b.*\berror\b"
AUTH_MESSAGE_RE = (
    r"\bunauthorized\b|\bforbidden\b|\bauthenticat|\bnot authorized\b|\bpermissions? denied\b"
    r"|\baccess denied\b|\binsufficient permissions?\b"
)
SERIALIZATION_JSON_RE = r"\bJSON\b"
SERIALIZATION_UNEXPECTED_TOKEN_RE = r"\bunexpected token\b"

_VALIDATION_RE = compile_js(VALIDATION_MESSAGE_RE, "i")
_TIMEOUT_RE = compile_js(TIMEOUT_MESSAGE_RE, "i")
_NETWORK_RE = compile_js(NETWORK_MESSAGE_RE, "i")
_AUTH_RE = compile_js(AUTH_MESSAGE_RE, "i")
_JSON_RE = compile_js(SERIALIZATION_JSON_RE, "i")
_UNEXPECTED_TOKEN_RE = compile_js(SERIALIZATION_UNEXPECTED_TOKEN_RE, "i")

VALIDATION_KNOWN_NAMES = frozenset({"ZodError", "ValidationError", "JoiError", "YupError"})
TIMEOUT_KNOWN_NAMES = frozenset({"TimeoutError", "AbortError"})
TIMEOUT_KNOWN_CODES = frozenset({"ETIMEDOUT", "ESOCKETTIMEDOUT"})
NETWORK_KNOWN_CODES = frozenset(
    {"ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EAI_AGAIN"}
)
AUTH_KNOWN_STATUSES = frozenset({401, 403})
AUTH_KNOWN_NAMES = frozenset({"UnauthorizedError", "ForbiddenError", "AuthError"})
AUTH_KNOWN_CODES = frozenset({"EACCES", "EPERM"})
DEPENDENCY_KNOWN_NAMES = frozenset({"MongoError", "PostgresError", "MySQLError", "RedisError"})
DEPENDENCY_KNOWN_PREFIXES = ("Mongo", "Postgres", "MySQL", "Redis", "Elastic")


def _msg(err: Coerced) -> str | None:
    m = err.message
    return m if isinstance(m, str) else None


def _name(err: Coerced) -> str | None:
    return err.name if isinstance(err.name, str) else None


def _code(err: Coerced) -> str | None:
    return err.code if isinstance(err.code, str) else None


def _status_in(err: Coerced, known: frozenset[int]) -> bool:
    s = err.status
    return isinstance(s, int) and not isinstance(s, bool) and s in known


def _validation(err: Coerced) -> str | None:
    name = _name(err)
    if name is not None and name in VALIDATION_KNOWN_NAMES:
        return "validation"
    # core also checks `err.constructor.name`; on the coerced record that is always "Object".
    msg = _msg(err)
    if msg is not None and _VALIDATION_RE.search(msg):
        return "validation"
    return None


def _timeout(err: Coerced) -> str | None:
    name = _name(err)
    if name is not None and name in TIMEOUT_KNOWN_NAMES:
        return "timeout"
    code = _code(err)
    if code is not None and code in TIMEOUT_KNOWN_CODES:
        return "timeout"
    msg = _msg(err)
    if msg is not None and _TIMEOUT_RE.search(msg):
        return "timeout"
    return None


def _network(err: Coerced) -> str | None:
    code = _code(err)
    if code is not None and code in NETWORK_KNOWN_CODES:
        return "network"
    if err.name == "FetchError":
        return "network"
    msg = _msg(err)
    if msg is not None and _NETWORK_RE.search(msg):
        return "network"
    return None


def _auth(err: Coerced) -> str | None:
    if _status_in(err, AUTH_KNOWN_STATUSES):
        return "auth"
    name = _name(err)
    if name is not None and name in AUTH_KNOWN_NAMES:
        return "auth"
    code = _code(err)
    if code is not None and code in AUTH_KNOWN_CODES:
        return "auth"
    msg = _msg(err)
    if msg is not None and _AUTH_RE.search(msg):
        return "auth"
    return None


def _dependency(err: Coerced) -> str | None:
    name = _name(err)
    if name is None:
        return None
    if name in DEPENDENCY_KNOWN_NAMES:
        return "dependency"
    if name.endswith("Error") and name.startswith(DEPENDENCY_KNOWN_PREFIXES):
        return "dependency"
    return None


def _serialization(err: Coerced) -> str | None:
    msg = _msg(err)
    if err.name == "SyntaxError" and msg is not None and _JSON_RE.search(msg):
        return "serialization"
    if msg is not None and _UNEXPECTED_TOKEN_RE.search(msg):
        return "serialization"
    return None


def _internal(err: Coerced) -> str | None:
    return "internal"


DEFAULT_CLASSIFIERS: tuple[Callable[[Coerced], str | None], ...] = (
    _validation,
    _timeout,
    _network,
    _auth,
    _dependency,
    _serialization,
    _internal,
)


def run_classifiers(err: Coerced) -> str:
    for classifier in DEFAULT_CLASSIFIERS:
        try:
            category = classifier(err)
        except Exception:
            category = None
        if category is not None:
            return category
    return "unknown"


# --- channel -------------------------------------------------------------------

JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
INPUT_VALIDATION_MARKER = "Input validation error:"
OUTPUT_VALIDATION_MARKER = "Output validation error:"
NOT_FOUND_RE_SRC = r"\bnot found\b"
DISABLED_RE_SRC = r"\bdisabled\b"
MCP_ERROR_WRAPPER_RE_SRC = r"^MCP error (-?\d+):\s*([\s\S]*)$"

_NOT_FOUND_RE = compile_js(NOT_FOUND_RE_SRC, "i")
_DISABLED_RE = compile_js(DISABLED_RE_SRC, "i")
_MCP_ERROR_WRAPPER_RE = compile_js(MCP_ERROR_WRAPPER_RE_SRC)


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, Mapping)


def _classify_invalid_params(message: Any) -> str:
    if not isinstance(message, str) or len(message) == 0:
        return "protocol.other"
    if INPUT_VALIDATION_MARKER in message:
        return "protocol.input"
    if OUTPUT_VALIDATION_MARKER in message:
        return "protocol.output"
    if _NOT_FOUND_RE.search(message) or _DISABLED_RE.search(message):
        return "protocol.not_found"
    return "protocol.other"


def _classify_by_code_and_message(code: float, message: Any) -> str:
    if code == JSONRPC_METHOD_NOT_FOUND:
        return "protocol.not_found"
    if code == JSONRPC_INVALID_PARAMS:
        return _classify_invalid_params(message)
    return "protocol.other"


def _first_content_text(result: Mapping[str, Any]) -> str | None:
    content = result.get("content")
    if not isinstance(content, list) or len(content) == 0:
        return None
    first = content[0]
    if not _is_plain_object(first):
        return None
    text = first.get("text")
    return text if isinstance(text, str) else None


def _recover_disguised_protocol_failure(result: Mapping[str, Any]) -> str | None:
    text = _first_content_text(result)
    if text is None:
        return None
    match = _MCP_ERROR_WRAPPER_RE.match(text)
    if not match:
        return None
    code = float(match.group(1))  # Number("...") -- overflows to Infinity, which is not an integer
    if math.isinf(code) or not code.is_integer():
        return None
    return _classify_by_code_and_message(code, match.group(2))


def _recover_v2_disguised_validation_failure(result: Mapping[str, Any]) -> str | None:
    text = _first_content_text(result)
    if text is None:
        return None
    if INPUT_VALIDATION_MARKER in text:
        return "protocol.input"
    if OUTPUT_VALIDATION_MARKER in text:
        return "protocol.output"
    return None


def classify_failure_channel(failure: Any) -> str:
    """'execution' | 'protocol.not_found' | 'protocol.input' | 'protocol.output' | 'protocol.other' | 'unknown'."""
    try:
        if not _is_plain_object(failure):
            return "unknown"
        if failure.get("isError") is True:
            return (
                _recover_disguised_protocol_failure(failure)
                or _recover_v2_disguised_validation_failure(failure)
                or "execution"
            )
        code = failure.get("code")
        if isinstance(code, bool) or not isinstance(code, (int, float)):
            return "unknown"
        if isinstance(code, float) and not code.is_integer():
            return "unknown"
        return _classify_by_code_and_message(code, failure.get("message"))
    except Exception:
        return "unknown"
