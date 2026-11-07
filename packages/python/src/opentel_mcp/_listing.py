"""Observing ``tools/list`` for tool definition integrity (ADR 029).

``tools/list`` is wrapped only when ``tool_integrity`` is enabled, so the default behaviour and the existing contract
are unchanged. The events go on the ``tools/list`` span:

* mcp 2.x with the SDK's own tracing middleware: the SDK's ``tools/list`` span is current, and the events land on it.
* mcp 1.x (the SDK has no spans at all) and mcp 2.x without that middleware: opentel-mcp starts a minimal
  ``tools/list`` SERVER span (``mcp.method.name`` and ``jsonrpc.request.id`` only, OK/ERROR status), so there is always
  a span to hold the events. This mirrors core, which spans ``tools/list`` whenever integrity or schema drift is on.

Nothing here may raise into the host; the response is always returned untouched.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, StatusCode, Tracer

from . import _contract as c
from ._integrity import ToolIntegrityObserver
from ._recording import ErrorRecordingConfig, RecordingState, record_thrown_exception
from ._wire import unwrap

logger = logging.getLogger("opentel_mcp")

MCP_METHOD_TOOLS_LIST = "tools/list"
_NON_RECORDING_BASE_EXCEPTIONS = (KeyboardInterrupt, SystemExit, GeneratorExit)


@dataclass
class ListInfo:
    request_id: Any = None
    cursor: Any = None


def _get(obj: Any, *names: str) -> Any:
    for name in names:
        value = obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)
        if value is not None:
            return value
    return None


def result_listing(result: Any) -> tuple[Any, bool]:
    """``(tools, has_next_page)`` from a ``ListToolsResult`` (model or mapping, either SDK line)."""
    r = unwrap(result)
    return _get(r, "tools"), bool(_get(r, "nextCursor", "next_cursor"))


def _is_list_span(span: Span) -> bool:
    try:
        if not span.is_recording():
            return False
        kind = getattr(span, "kind", None)
        return getattr(span, "name", None) == MCP_METHOD_TOOLS_LIST and (
            kind is None or kind == SpanKind.SERVER
        )
    except Exception:
        return False


class ToolsListRecorder:
    def __init__(
        self,
        tracer: Tracer,
        observer: ToolIntegrityObserver,
        error_recording: ErrorRecordingConfig,
        state: RecordingState,
    ) -> None:
        self._tracer = tracer
        self.observer = observer
        self._error_recording = error_recording
        self._state = state

    async def run(self, call: Callable[[], Awaitable[Any]], info: ListInfo) -> Any:
        span: Span = trace.INVALID_SPAN
        token: object | None = None
        owned = False
        try:
            current = trace.get_current_span()
            if _is_list_span(current):
                span = current
            else:
                span = self._tracer.start_span(MCP_METHOD_TOOLS_LIST, kind=SpanKind.SERVER)
                owned = True
                token = otel_context.attach(trace.set_span_in_context(span))
                span.set_attribute(c.ATTR_MCP_METHOD_NAME, MCP_METHOD_TOOLS_LIST)
                if info.request_id is not None:
                    span.set_attribute(c.ATTR_JSONRPC_REQUEST_ID, str(info.request_id))
        except Exception as exc:
            self._debug("begin", exc)
        try:
            result = await call()
        except BaseException as exc:
            if owned and not isinstance(exc, _NON_RECORDING_BASE_EXCEPTIONS):
                with contextlib.suppress(Exception):
                    record_thrown_exception(span, exc, self._error_recording, self._state)
            self._finish(span, token, owned)
            raise
        try:
            tools, has_next = result_listing(result)
            complete = info.cursor is None and not has_next
            self.observer.observe(tools, complete, span)
            if owned:
                span.set_status(StatusCode.OK)
        except Exception as exc:
            self._debug("observe", exc)
        self._finish(span, token, owned)
        return result

    def _finish(self, span: Span, token: object | None, owned: bool) -> None:
        try:
            if token is not None:
                otel_context.detach(token)  # type: ignore[arg-type]
        except Exception as exc:
            self._debug("detach", exc)
        try:
            if owned:
                span.end()
        except Exception as exc:
            self._debug("end", exc)

    @staticmethod
    def _debug(where: str, exc: BaseException) -> None:
        with contextlib.suppress(Exception):
            logger.debug(
                "opentel-mcp: tools/list step %r failed (%s); continuing.", where, type(exc).__name__
            )
