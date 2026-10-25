"""Error recording on the thrown path (port of ``recordThrownException`` and ``error-recording/*``).

Modes (``OTEL_MCP_ERROR_RECORDING_MODE``): ``full`` (default; scrubbed and capped), ``normalized``
(optionally through a redactor) and ``none`` (status only). Nothing here may raise.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from opentelemetry.trace import Span, StatusCode

from ._coerce import Coerced, coerce_error
from ._compose import MAX_ERROR_CLASS_LENGTH, normalize_exception
from ._jsre import from_u16, to_u16
from ._normalize import MAX_INPUT_LENGTH
from ._secrets import scrub_secrets_u16

logger = logging.getLogger("opentel_mcp")

MAX_FULL_EXCEPTION_MESSAGE_LENGTH = 4096
MAX_FULL_EXCEPTION_STACK_LENGTH = 16384
MAX_REDACTOR_OUTPUT_LENGTH = MAX_INPUT_LENGTH
TRUNCATION_MARKER = " …[truncated by opentel-mcp]"
ENV_MODE = "OTEL_MCP_ERROR_RECORDING_MODE"
VALID_MODES = ("full", "normalized", "none")

Redactor = Callable[[dict[str, Any]], Any]

_warned_redactor_noop = False


def _reset_redactor_noop_warned_for_tests() -> None:
    global _warned_redactor_noop
    _warned_redactor_noop = False


@dataclass
class ErrorRecordingConfig:
    mode: str = "full"
    redactor: Redactor | None = None


@dataclass
class RecordingState:
    """Caller-owned one-time-warning state (one per instrumented server)."""

    warned_failed: bool = False


def resolve_error_recording_config(partial: Any) -> ErrorRecordingConfig:
    """Resolve the ``error_recording`` option; invalid values fall back to the default with one warning."""
    mode_value: Any = None
    redactor: Any = None
    if isinstance(partial, Mapping):
        mode_value = partial.get("mode")
        redactor = partial.get("redactor")
    elif partial is not None:
        logger.warning(
            "opentel-mcp: error_recording must be a dict like {'mode': 'normalized'}; using the default."
        )
    if mode_value is None:
        mode_value = os.environ.get(ENV_MODE)
    mode = "full"
    if mode_value is not None:
        if isinstance(mode_value, str) and mode_value in VALID_MODES:
            mode = mode_value
        else:
            logger.warning(
                "opentel-mcp: invalid error_recording mode %r (expected one of %s); using 'full'.",
                mode_value,
                VALID_MODES,
            )
    if redactor is not None and not callable(redactor):
        logger.warning("opentel-mcp: error_recording['redactor'] must be callable; ignoring it.")
        redactor = None
    global _warned_redactor_noop
    if redactor is not None and mode != "normalized" and not _warned_redactor_noop:
        _warned_redactor_noop = True
        logger.warning(
            "opentel-mcp: error_recording['redactor'] is configured but the mode is %r, not 'normalized' -- the "
            "redactor is accepted but never invoked in this mode.",
            mode,
        )
    return ErrorRecordingConfig(mode=mode, redactor=redactor)


def scrub_and_cap(text: str, maximum: int) -> str:
    """Scrub credentials (on at most 2x the cap) and cap at ``maximum`` UTF-16 units plus a marker."""
    u = to_u16(text)
    if len(u) > maximum * 2:
        u = u[: maximum * 2]
    scrubbed = scrub_secrets_u16(u)
    if len(scrubbed) > maximum:
        scrubbed = scrubbed[:maximum] + TRUNCATION_MARKER
    return from_u16(scrubbed)


def _cap_type(value: Any) -> str:
    return from_u16(to_u16(str(value))[:MAX_ERROR_CLASS_LENGTH])


def thrown_error_type(err: Any) -> str:
    """``error.type`` for a thrown failure: ``type(e).__name__`` capped at 128 (never ``__qualname__``)."""
    try:
        name = err.name if isinstance(err, Coerced) else coerce_error(err).name
        return _cap_type("Error" if name is None else name)
    except Exception:
        return "Error"


def describe_full_exception(coerced: Coerced) -> tuple[dict[str, str] | None, str | None]:
    """The 'full' event: ``(attributes | None, status_message)``, scrubbed and capped."""
    attributes: dict[str, str] = {}
    status_message: str | None = None
    if coerced.code:
        attributes["exception.type"] = _cap_type(coerced.code)
    elif coerced.name:
        attributes["exception.type"] = _cap_type(coerced.name)
    if isinstance(coerced.message, str) and coerced.message != "":
        attributes["exception.message"] = scrub_and_cap(coerced.message, MAX_FULL_EXCEPTION_MESSAGE_LENGTH)
        status_message = attributes["exception.message"]
    if isinstance(coerced.stack, str) and coerced.stack != "":
        attributes["exception.stacktrace"] = scrub_and_cap(coerced.stack, MAX_FULL_EXCEPTION_STACK_LENGTH)
    has_any = "exception.type" in attributes or "exception.message" in attributes
    return (attributes if has_any else None), status_message


def apply_redactor(
    message_stack: dict[str, Any], redactor: Redactor, state: RecordingState
) -> dict[str, Any] | None:
    """Run the host redactor once; ``None`` when it misbehaved (the caller then records nothing)."""
    result: Any = None
    reason: str | None = None
    try:
        result = redactor(message_stack)
    except Exception:
        reason = "raised"
    if reason is None:
        if not isinstance(result, Mapping) or not isinstance(result.get("message"), str):
            reason = "returned a non-string message"
        elif result.get("stack") is not None and not isinstance(result.get("stack"), str):
            reason = "returned an invalid stack (neither a string nor None)"
    if reason is not None:
        if not state.warned_failed:
            state.warned_failed = True
            # Shape only, never content: a warning that echoed the redacted text would just move the leak to logs.
            with contextlib.suppress(Exception):
                logger.warning(
                    "opentel-mcp: the error_recording redactor %s for this call; recording no exception content "
                    "(span status only) for this event, never the raw content. Warned once per instrumented server.",
                    reason,
                )
        return None
    assert isinstance(result, Mapping)
    stack = result.get("stack")
    return {
        "message": from_u16(to_u16(result["message"])[:MAX_REDACTOR_OUTPUT_LENGTH]),
        "stack": None if stack is None else from_u16(to_u16(stack)[:MAX_REDACTOR_OUTPUT_LENGTH]),
    }


def record_thrown_exception(
    span: Span, err: Any, config: ErrorRecordingConfig, state: RecordingState
) -> None:
    """Record ``err`` on ``span`` per ``config.mode``. Never raises."""
    try:
        if config.mode == "none":
            span.set_status(StatusCode.ERROR)
            return

        coerced = coerce_error(err, with_stack_text=True) if not isinstance(err, Coerced) else err

        if config.mode == "normalized":
            code, name = coerced.code, coerced.name
            exc_type = _cap_type(code if code is not None else (name if name is not None else "Error"))
            attrs: dict[str, str] = {"exception.type": exc_type}
            normalize_input: Any = coerced
            if config.redactor is not None:
                redacted = apply_redactor(
                    {"message": coerced.message, "stack": coerced.stack}, config.redactor, state
                )
                if redacted is None:
                    span.set_status(StatusCode.ERROR)
                    return
                normalize_input = redacted
            norm = normalize_exception(normalize_input, cwd=os.getcwd())
            attrs["exception.message"] = norm.normalized_message
            if norm.frames:
                attrs["exception.stacktrace"] = "\n".join(
                    f"{f.fn or '<anonymous>'}@{f.file}:{'?' if f.line is None else f.line}"
                    for f in norm.frames
                )
            span.add_event("exception", attrs)
            span.set_status(StatusCode.ERROR, norm.normalized_message)
            return

        attributes, status_message = describe_full_exception(coerced)
        if attributes is not None:
            span.add_event("exception", attributes)
        span.set_status(StatusCode.ERROR, status_message)
    except Exception:
        with contextlib.suppress(Exception):
            span.set_status(StatusCode.ERROR)
