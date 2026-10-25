"""``ToolCallRecorder``: the one place that owns the ``tools/call`` span, attributes, fingerprint and metrics.

Adapters (mcp 1.x / 2.x) only extract ``tool_name``, ``arguments``, ``request_id``, ``_meta`` and the result.
Nothing here may raise into the host: every hook is wrapped, failures degrade to one warning, and the original
exception (or result) always passes through untouched. Argument values and result content are never read
beyond ``isError`` and the first text block of an *error* result (for the fingerprint, as core does).
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.propagate import extract
from opentelemetry.trace import Span, SpanKind, StatusCode, Tracer

from . import _contract as c
from ._classify import classify_failure_channel
from ._coerce import exception_code
from ._compose import ATTR_CHANNEL, Fingerprint, compute_fingerprint
from ._config import Options
from ._metrics import MetricsRecorder
from ._recording import RecordingState, record_thrown_exception, thrown_error_type
from ._wire import is_tool_error, to_wire

logger = logging.getLogger("opentel_mcp")

_NON_RECORDING_BASE_EXCEPTIONS = (KeyboardInterrupt, SystemExit, GeneratorExit)


@dataclass
class CallInfo:
    tool_name: str | None = None
    argument_count: int = 0
    request_id: Any = None
    meta: Any = None


class CauseHolder:
    """Filled by the ``MCPServer.call_tool`` wrapper (2.x) with the ``UnexpectedToolError`` it saw."""

    __slots__ = ("exc",)

    def __init__(self) -> None:
        self.exc: BaseException | None = None


CAUSE: contextvars.ContextVar[CauseHolder | None] = contextvars.ContextVar("opentel_mcp_cause", default=None)

_MAX_CAUSE_HOPS = 8


def _is_unexpected_wrapper(exc: BaseException) -> bool:
    return type(exc).__name__ in ("UnexpectedToolError", "UnexpectedResourceError")


def original_cause(wrapper: BaseException | None) -> BaseException | None:
    """Walk ``__cause__`` past ``Unexpected*Error`` wrappers to the first other exception (<= 8 hops)."""
    cur = wrapper
    hops = 0
    while cur is not None and _is_unexpected_wrapper(cur) and hops < _MAX_CAUSE_HOPS:
        nxt = cur.__cause__
        if nxt is None and not cur.__suppress_context__:
            nxt = cur.__context__
        cur = nxt
        hops += 1
    if cur is None or _is_unexpected_wrapper(cur):
        return None
    return cur


def extract_parent_context(meta: Any) -> otel_context.Context | None:
    """W3C trace context from ``params._meta`` (ADR 017); ``None`` means "use the ambient context"."""
    try:
        if meta is None:
            return None
        if not isinstance(meta, Mapping):
            dump = getattr(meta, "model_dump", None)
            meta = dump() if callable(dump) else None
        if not isinstance(meta, Mapping) or not isinstance(meta.get("traceparent"), str):
            return None
        carrier = {k: v for k, v in meta.items() if k in ("traceparent", "tracestate") and isinstance(v, str)}
        ctx = extract(carrier)
        if not trace.get_current_span(ctx).get_span_context().is_valid:
            return None
        return ctx
    except Exception:
        return None


def _channel_input_for_exception(exc: BaseException) -> Any:
    """A ``{code, message}`` shape for JSON-RPC style errors; anything else is simply 'unknown' (as in JS)."""
    try:
        code = exception_code(exc)
        if isinstance(code, int) and not isinstance(code, bool):
            error = getattr(exc, "error", None)
            message = getattr(error, "message", None)
            if not isinstance(message, str):
                message = str(exc)
            return {"code": code, "message": message}
    except Exception:
        pass
    return None


def _is_foreign_tools_call_span(span: Span) -> bool:
    """A recording SERVER span already named ``tools/call...`` belongs to another instrumentation."""
    try:
        if not span.is_recording():
            return False
        name = getattr(span, "name", None)
        if not isinstance(name, str) or not (
            name == c.MCP_METHOD_TOOLS_CALL or name.startswith(c.MCP_METHOD_TOOLS_CALL + " ")
        ):
            return False
        kind = getattr(span, "kind", None)
        return kind is None or kind == SpanKind.SERVER
    except Exception:
        return False


class _Active:
    __slots__ = ("owned", "span", "token", "tool_name")

    def __init__(self, span: Span, token: object | None, owned: bool, tool_name: str | None) -> None:
        self.span = span
        self.token = token
        self.owned = owned
        self.tool_name = tool_name


class ToolCallRecorder:
    """Per instrumented server.

    ``span_mode`` is ``"own"`` (we start the one ``tools/call`` span), ``"enrich"`` (explicit
    ``sdk_tracing="enrich"``: only ever enrich the SDK's span) or ``"enrich-or-own"`` (the replace -> enrich
    fallback: enrich the SDK span when one is current, else start our own so spans never silently vanish).
    """

    def __init__(
        self,
        options: Options,
        tracer: Tracer,
        metrics_recorder: MetricsRecorder | None,
        span_mode: str = "own",
    ) -> None:
        self.options = options
        self.tracer = tracer
        self.metrics = metrics_recorder
        self.span_mode = span_mode
        self.state = RecordingState()
        self._warned: set[str] = set()

    # -- diagnostics ------------------------------------------------------------------------------------------

    def warn_once(self, key: str, message: str, *args: Any) -> None:
        if key in self._warned:
            return
        self._warned.add(key)
        with contextlib.suppress(Exception):
            logger.warning(message, *args)

    def _failed(self, where: str, exc: BaseException) -> None:
        # Type name only: the message could contain request-derived text.
        self.warn_once(
            f"hook:{where}",
            "opentel-mcp: instrumentation step %r failed (%s); continuing without it. Further failures are not logged.",
            where,
            type(exc).__name__,
        )

    # -- the call --------------------------------------------------------------------------------------------

    async def run(
        self, call: Callable[[], Awaitable[Any]], info: CallInfo, holder: CauseHolder | None = None
    ) -> Any:
        active: _Active | None = None
        try:
            active = self._begin(info)
        except Exception as exc:
            self._failed("begin", exc)
            active = None
        start = time.perf_counter()
        try:
            result = await call()
        except BaseException as exc:
            if active is not None and not isinstance(exc, _NON_RECORDING_BASE_EXCEPTIONS):
                try:
                    self._on_thrown(active, exc, start)
                except Exception as hook_exc:
                    self._failed("thrown", hook_exc)
            raise
        else:
            if active is not None:
                try:
                    self._on_result(active, result, start, holder)
                except Exception as hook_exc:
                    self._failed("result", hook_exc)
            return result
        finally:
            if active is not None:
                self._end(active)

    # -- begin / end -----------------------------------------------------------------------------------------

    def _begin(self, info: CallInfo) -> _Active:
        tool_name = info.tool_name if isinstance(info.tool_name, str) else None
        current = trace.get_current_span()
        foreign = _is_foreign_tools_call_span(current)

        owned = False
        span: Span
        token: object | None = None
        if (self.span_mode == "own" and not foreign) or (self.span_mode == "enrich-or-own" and not foreign):
            owned = True
        elif self.span_mode == "own" and foreign:
            self.warn_once(
                "foreign-span",
                "opentel-mcp: another instrumentation already started a tools/call span for this request; "
                "enriching it instead of nesting a second span.",
            )

        if owned:
            name = f"{c.MCP_METHOD_TOOLS_CALL} {tool_name}" if tool_name else c.MCP_METHOD_TOOLS_CALL
            parent = extract_parent_context(info.meta)
            span = self.tracer.start_span(name, kind=SpanKind.SERVER, context=parent)
            try:
                token = otel_context.attach(trace.set_span_in_context(span, parent))
            except Exception:
                span.end()
                raise
        else:
            span = current

        active = _Active(span, token, owned, tool_name)
        try:
            if owned:
                self._set_initial_attributes(span, info, tool_name)
            elif span.is_recording():
                self._set_enrich_attributes(span, info, tool_name)
        except Exception as exc:
            self._failed("attributes", exc)
        self._metric(lambda m: m.record_call(tool_name))
        return active

    @staticmethod
    def _set_initial_attributes(span: Span, info: CallInfo, tool_name: str | None) -> None:
        span.set_attribute(c.ATTR_MCP_METHOD_NAME, c.MCP_METHOD_TOOLS_CALL)
        span.set_attribute(c.ATTR_GEN_AI_OPERATION_NAME, c.GEN_AI_OPERATION_EXECUTE_TOOL)
        if tool_name is not None:
            span.set_attribute(c.ATTR_GEN_AI_TOOL_NAME, tool_name)
        span.set_attribute(c.ATTR_MCP_TOOL_ARGUMENT_COUNT, int(info.argument_count))
        if info.request_id is not None:
            span.set_attribute(c.ATTR_JSONRPC_REQUEST_ID, str(info.request_id))

    @staticmethod
    def _set_enrich_attributes(span: Span, info: CallInfo, tool_name: str | None) -> None:
        # The SDK already set method, operation, tool name and request id; we add what it lacks.
        span.set_attribute(c.ATTR_MCP_TOOL_ARGUMENT_COUNT, int(info.argument_count))

    def _end(self, active: _Active) -> None:
        try:
            if active.token is not None:
                otel_context.detach(active.token)  # type: ignore[arg-type]
        except Exception as exc:
            self._failed("detach", exc)
        try:
            if active.owned:
                active.span.end()
        except Exception as exc:
            self._failed("end", exc)

    # -- outcomes ---------------------------------------------------------------------------------------------

    def _fingerprint_attributes(self, span: Span, fp: Fingerprint, channel: str) -> None:
        if span.is_recording():
            span.set_attributes({**fp.span_attributes(), ATTR_CHANNEL: channel})

    def _on_result(self, active: _Active, result: Any, start: float, holder: CauseHolder | None) -> None:
        span, tool = active.span, active.tool_name
        duration_ms = (time.perf_counter() - start) * 1000.0
        if not is_tool_error(result):
            if span.is_recording():
                span.set_status(StatusCode.OK)
            self._metric(lambda m: m.record_duration(tool, duration_ms, c.OUTCOME_SUCCESS))
            return

        wire = to_wire(result)
        if span.is_recording():
            span.set_attribute(c.ATTR_ERROR_TYPE, c.ERROR_TYPE_TOOL_ERROR)
            span.set_status(StatusCode.ERROR)

        category = ""
        cause = original_cause(holder.exc) if holder is not None else None
        if self.options.fingerprinting:
            subject: Any = cause if cause is not None else wire
            fp = compute_fingerprint(subject, tool_name=tool, origin=c.ORIGIN_TOOL_ERROR)
            self._fingerprint_attributes(span, fp, classify_failure_channel(wire))
            category = fp.category

        if cause is not None and span.is_recording():
            # MCPServer 2.x converted a crash into a generic isError result: record the original through
            # error_recording (scrubbed/capped in full mode, normalized only, or nothing).
            record_thrown_exception(span, cause, self.options.error_recording, self.state)
            span.set_attribute(c.ATTR_ERROR_TYPE, c.ERROR_TYPE_TOOL_ERROR)

        self._metric(lambda m: m.record_silent_failure(tool, category))
        self._metric(lambda m: m.record_duration(tool, duration_ms, c.OUTCOME_SILENT_FAILURE, category))

    def _on_thrown(self, active: _Active, exc: BaseException, start: float) -> None:
        span, tool = active.span, active.tool_name
        duration_ms = (time.perf_counter() - start) * 1000.0
        error_type = thrown_error_type(exc)

        if active.owned and span.is_recording():
            record_thrown_exception(span, exc, self.options.error_recording, self.state)
            span.set_attribute(c.ATTR_ERROR_TYPE, error_type)
        # Enrich: the SDK records the exception, sets error.type and the status after we re-raise.

        category = ""
        if self.options.fingerprinting:
            fp = compute_fingerprint(exc, tool_name=tool, origin=c.ORIGIN_THROWN)
            self._fingerprint_attributes(
                span, fp, classify_failure_channel(_channel_input_for_exception(exc))
            )
            category = fp.category

        self._metric(lambda m: m.record_error(tool, error_type, category))
        self._metric(lambda m: m.record_duration(tool, duration_ms, c.OUTCOME_ERROR, category))

    def _metric(self, fn: Callable[[MetricsRecorder], None]) -> None:
        if self.metrics is None:
            return
        try:
            fn(self.metrics)
        except Exception as exc:
            self._failed("metrics", exc)
