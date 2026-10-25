"""Flush on exit: ``atexit`` plus a SIGTERM/SIGINT handler that flushes and then chains to the previous handler.

Python does not run ``atexit`` on SIGTERM by default, so the signal handlers are what make a ``kill`` flush.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import signal
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("opentel_mcp")

_lock = threading.Lock()
_registered: dict[Callable[[], None], int] = {}
_previous: dict[int, Any] = {}
_installed = False
_warned = False


def _flush_all() -> None:
    with _lock:
        items = list(_registered.items())
        _registered.clear()
    if not items:
        return
    timeout_s = max(ms for _, ms in items) / 1000.0

    def work() -> None:
        for shutdown, _ in items:
            with contextlib.suppress(Exception):
                shutdown()

    thread = threading.Thread(target=work, name="opentel-mcp-flush", daemon=True)
    thread.start()
    thread.join(timeout_s)


def _handler_for(signum: int) -> Callable[[int, Any], None]:
    def handle(sig: int, frame: Any) -> None:
        _flush_all()
        previous = _previous.get(signum)
        try:
            if callable(previous):
                previous(sig, frame)
                return
            if previous == signal.SIG_IGN:
                return
            # SIG_DFL (or unknown): restore the default and re-raise so the exit status is the usual one.
            signal.signal(signum, signal.SIG_DFL)
            signal.raise_signal(signum)
        except Exception:
            pass

    return handle


def _install() -> None:
    global _installed, _warned
    if _installed:
        return
    _installed = True
    atexit.register(_flush_all)
    if threading.current_thread() is not threading.main_thread():
        return  # signal handlers can only be installed from the main thread
    for name in ("SIGTERM", "SIGINT"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            previous = signal.getsignal(signum)
            if previous is None:
                continue
            if signum == signal.SIGINT and previous is signal.default_int_handler:
                previous = signal.default_int_handler  # chained below: raises KeyboardInterrupt as usual
            _previous[int(signum)] = previous
            signal.signal(signum, _handler_for(int(signum)))
        except Exception as exc:
            if not _warned:
                _warned = True
                logger.warning(
                    "opentel-mcp: flush_on_exit could not install a %s handler (%s); telemetry is flushed on normal exit only.",
                    name,
                    type(exc).__name__,
                )


def register_flush_on_exit(shutdown: Callable[[], None], timeout_ms: int) -> Callable[[], None]:
    """Register ``shutdown`` to run at exit/SIGTERM/SIGINT; returns an unregister function. Never raises."""
    try:
        with _lock:
            _registered[shutdown] = timeout_ms
        _install()
    except Exception:
        pass

    def unregister() -> None:
        with _lock:
            _registered.pop(shutdown, None)

    return unregister
