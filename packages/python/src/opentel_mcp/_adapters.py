"""Hooking the SDK's ``tools/call`` handler (ADR 028 Decision 3).

mcp 2.x wraps the registered handler itself (public ``get_request_handler`` / ``add_request_handler``), so
lookup, params validation and the initialize gate stay outside: bad params and pre-initialize requests never
produce a span. mcp 1.x wraps ``request_handlers[types.CallToolRequest]`` through a ``dict`` subclass, so
registration order does not matter. We patch per instance only, never SDK classes.
"""

from __future__ import annotations

import contextlib
import inspect
import logging
import weakref
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from ._config import Options
from ._recorder import CAUSE, CallInfo, CauseHolder, ToolCallRecorder

logger = logging.getLogger("opentel_mcp")

_WRAPPED_MARK = "__opentel_mcp_wrapped__"
_instrumented: weakref.WeakSet[Any] = weakref.WeakSet()
_instrumented_ids: set[int] = set()


def already_instrumented(obj: Any) -> bool:
    try:
        return obj in _instrumented
    except TypeError:
        return id(obj) in _instrumented_ids


def mark_instrumented(obj: Any) -> None:
    try:
        _instrumented.add(obj)
    except TypeError:
        _instrumented_ids.add(id(obj))


def _mark(fn: Any) -> Any:
    with contextlib.suppress(Exception):
        setattr(fn, _WRAPPED_MARK, True)
    return fn


def _is_wrapped(fn: Any) -> bool:
    return bool(getattr(fn, _WRAPPED_MARK, False))


def _argument_count(arguments: Any) -> int:
    try:
        return len(arguments) if arguments else 0
    except Exception:
        return 0


# --------------------------------------------------------------------------------------------------------------
# mcp 1.x
# --------------------------------------------------------------------------------------------------------------


class _HandlerDict(dict):  # type: ignore[type-arg]
    """``Server.request_handlers`` that wraps a ``CallToolRequest`` handler whenever one is inserted."""

    def __init__(self, source: Mapping[Any, Any], key: Any, wrap: Callable[[Any], Any]) -> None:
        super().__init__()
        self._key = key
        self._wrap = wrap
        for k, v in source.items():
            self[k] = v

    def _maybe_wrap(self, k: Any, v: Any) -> Any:
        if k is self._key and callable(v) and not _is_wrapped(v):
            try:
                return self._wrap(v)
            except Exception:
                return v
        return v

    def __setitem__(self, k: Any, v: Any) -> None:
        super().__setitem__(k, self._maybe_wrap(k, v))

    def update(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        for k, v in dict(*args, **kwargs).items():
            self[k] = v

    def setdefault(self, k: Any, default: Any = None) -> Any:
        if k not in self:
            self[k] = default
        return self[k]


def install_v1(lowlevel: Any, recorder: ToolCallRecorder) -> bool:
    """Wrap the low-level 1.x server's ``CallToolRequest`` handler. Returns ``False`` if the SDK shape is unknown."""
    try:
        from mcp import types
    except Exception:
        return False
    key = getattr(types, "CallToolRequest", None)
    handlers = getattr(lowlevel, "request_handlers", None)
    if key is None or not isinstance(handlers, dict):
        return False

    def wrap(handler: Callable[[Any], Awaitable[Any]]) -> Callable[[Any], Awaitable[Any]]:
        async def instrumented(req: Any) -> Any:
            info = _call_info_v1(req, lowlevel)
            return await recorder.run(lambda: handler(req), info)

        return _mark(instrumented)  # type: ignore[no-any-return]

    lowlevel.request_handlers = _HandlerDict(handlers, key, wrap)
    return True


def _call_info_v1(req: Any, lowlevel: Any) -> CallInfo:
    info = CallInfo()
    try:
        params = req.params
        info.tool_name = getattr(params, "name", None)
        info.argument_count = _argument_count(getattr(params, "arguments", None))
        info.meta = getattr(params, "meta", None)
    except Exception:
        pass
    try:
        info.request_id = lowlevel.request_context.request_id
    except Exception:
        info.request_id = None
    return info


# --------------------------------------------------------------------------------------------------------------
# mcp 2.x
# --------------------------------------------------------------------------------------------------------------


class _SdkTracingWithoutToolsCall:
    """Delegates to the SDK's ``OpenTelemetryMiddleware`` for everything except ``tools/call``.

    The SDK keeps its spans for initialize, tools/list, resources/*, prompts/*; only its ``tools/call`` span goes
    away, so ours is the single one.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def __call__(self, ctx: Any, call_next: Any) -> Any:
        if getattr(ctx, "method", None) == "tools/call":
            return await call_next(ctx)
        return await self._inner(ctx, call_next)


def _sdk_middleware_class() -> type | None:
    try:
        from mcp.server._otel import OpenTelemetryMiddleware

        return OpenTelemetryMiddleware  # type: ignore[no-any-return]
    except Exception:
        return None


def _find_sdk_middleware(middleware: list[Any]) -> int | None:
    cls = _sdk_middleware_class()
    for i, m in enumerate(middleware):
        if isinstance(m, _SdkTracingWithoutToolsCall):
            return None
        if (cls is not None and isinstance(m, cls)) or type(m).__name__ == "OpenTelemetryMiddleware":
            return i
    return None


def _takes_ctx_and_call_next(m: Any) -> bool:
    try:
        params = list(inspect.signature(m.__call__).parameters.values())
    except (TypeError, ValueError):
        return False
    if any(p.kind is p.VAR_POSITIONAL for p in params):
        return True
    return len([p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]) == 2


def decide_sdk_tracing(lowlevel: Any, options: Options, recorder: ToolCallRecorder) -> str:
    """Apply ``sdk_tracing`` and return the recorder's ``span_mode``.

    ``"own"`` -> we start the span; ``"enrich"`` -> explicit enrichment; ``"enrich-or-own"`` -> the fallback.
    Never raises.
    """
    if options.sdk_tracing == "enrich":
        _warn_enrich_privacy(options, recorder)
        return "enrich"

    def fallback(reason: str) -> str:
        recorder.warn_once(
            "replace-fallback",
            "opentel-mcp: could not replace the mcp SDK's tools/call span (%s); falling back to "
            'sdk_tracing="enrich". The SDK records thrown exceptions raw in this mode.',
            reason,
        )
        _warn_enrich_privacy(options, recorder)
        return "enrich-or-own"

    try:
        middleware = getattr(lowlevel, "middleware", None)
        if not isinstance(middleware, list):
            return fallback("the server has no middleware list")
        idx = _find_sdk_middleware(middleware)
        if idx is None:
            return "own"  # nothing to replace (already removed or already replaced)
        sdk_mw = middleware[idx]
        if not _takes_ctx_and_call_next(sdk_mw):
            return fallback("the SDK middleware no longer takes (ctx, call_next)")
        middleware[idx] = _SdkTracingWithoutToolsCall(sdk_mw)
        logger.info(
            "opentel-mcp: replaced the mcp SDK's tools/call span with opentel-mcp's (scrubbed exceptions, "
            'error-recording modes). Pass sdk_tracing="enrich" to keep the SDK span.'
        )
        return "own"
    except Exception as exc:
        return fallback(type(exc).__name__)


def _warn_enrich_privacy(options: Options, recorder: ToolCallRecorder) -> None:
    er = options.error_recording
    if er.mode in ("normalized", "none") or er.redactor is not None:
        recorder.warn_once(
            "enrich-raw-exceptions",
            'opentel-mcp: sdk_tracing="enrich" keeps the mcp SDK\'s tools/call span, and the SDK records thrown '
            "exceptions on it raw (full message and stack, unscrubbed and uncapped). error_recording mode %r (and "
            'any redactor) do not apply to that span. Use sdk_tracing="replace" (the default) to honour them.',
            er.mode,
        )


def _call_info_v2(ctx: Any, params: Any) -> CallInfo:
    info = CallInfo()
    try:
        info.tool_name = getattr(params, "name", None)
        info.argument_count = _argument_count(getattr(params, "arguments", None))
    except Exception:
        pass
    try:
        info.request_id = getattr(ctx, "request_id", None)
        meta = getattr(ctx, "meta", None)
        if meta is None:
            raw = getattr(ctx, "params", None)
            meta = raw.get("_meta") if isinstance(raw, Mapping) else None
        info.meta = meta
    except Exception:
        pass
    return info


def install_v2_handler(lowlevel: Any, recorder: ToolCallRecorder) -> bool:
    """Re-register the ``tools/call`` entry with our wrapper (``HandlerEntry`` is frozen, so we replace it)."""
    getter = getattr(lowlevel, "get_request_handler", None)
    adder = getattr(lowlevel, "add_request_handler", None)
    if not callable(getter) or not callable(adder):
        return False
    entry = getter("tools/call")
    if entry is None:
        recorder.warn_once(
            "no-handler",
            "opentel-mcp: no tools/call handler is registered on this server yet, so nothing was instrumented. "
            "Register your tools/call handler (on_call_tool=...) before calling instrument_mcp_server().",
        )
        return False
    handler = entry.handler
    if _is_wrapped(handler):
        return True

    async def instrumented(ctx: Any, params: Any) -> Any:
        info = _call_info_v2(ctx, params)
        holder = CauseHolder()
        token = CAUSE.set(holder)
        try:
            return await recorder.run(lambda: handler(ctx, params), info, holder)
        finally:
            with contextlib.suppress(Exception):
                CAUSE.reset(token)

    adder("tools/call", entry.params_type, _mark(instrumented))
    return True


def install_cause_capture(mcp_server: Any, recorder: ToolCallRecorder) -> bool:
    """Per-instance ``call_tool`` wrapper that hands an ``UnexpectedToolError`` to the active holder.

    ``MCPServer._handle_call_tool`` turns the error into an isError result, so neither the handler result nor any
    middleware would otherwise see the original exception (round-2 decision B).
    """
    try:
        original = mcp_server.call_tool
        if not callable(original) or _is_wrapped(original):
            return _is_wrapped(original)
        from mcp.server.mcpserver.exceptions import UnexpectedToolError

        async def call_tool(*args: Any, **kwargs: Any) -> Any:
            try:
                return await original(*args, **kwargs)
            except UnexpectedToolError as exc:
                try:
                    holder = CAUSE.get()
                    if holder is not None:
                        holder.exc = exc
                except Exception:
                    pass
                raise

        mcp_server.call_tool = _mark(call_tool)
        return True
    except Exception as exc:
        recorder.warn_once(
            "cause-capture",
            "opentel-mcp: could not install cause capture (%s); crashes in MCPServer tools will group into one "
            "fingerprint per tool.",
            type(exc).__name__,
        )
        return False
