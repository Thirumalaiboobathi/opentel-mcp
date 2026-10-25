"""Small unit tests for helpers whose behaviour the integration tests only touch indirectly."""

from __future__ import annotations

import errno
import json
import signal
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from opentel_mcp import _coerce, _stack, _wire
from opentel_mcp._compose import compute_fingerprint, hash_inputs, normalize_exception
from opentel_mcp._dev import DevSdk
from opentel_mcp._dev import flush as flush_mod
from opentel_mcp._dev.stderr import StderrSpanExporter, span_to_object


class FakeMcpError(Exception):
    """Shaped like mcp 1.x ``McpError`` / 2.x ``MCPError``: ``.error`` carries the JSON-RPC code and message."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.error = type("E", (), {"code": code, "message": message})()


def test_exception_is_coerced_with_name_not_qualname() -> None:
    class Outer:
        class Inner(Exception):
            pass

    c = _coerce.coerce_exception(Outer.Inner("m"))
    assert c.name == "Inner" and c.message == "m" and c.is_exception


def test_oserror_errno_becomes_the_node_style_code() -> None:
    c = _coerce.coerce_exception(ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"))
    assert c.code == "ECONNREFUSED"
    fp = compute_fingerprint(ConnectionRefusedError(errno.ECONNREFUSED, "x"), tool_name="t", origin="thrown")
    assert fp.category == "network"  # classifies exactly as a Node ECONNREFUSED does


def test_string_code_wins_and_mcp_errors_expose_the_jsonrpc_code() -> None:
    class WithCode(Exception):
        code = "E_CUSTOM"

    assert _coerce.coerce_exception(WithCode("x")).code == "E_CUSTOM"
    c = _coerce.coerce_exception(FakeMcpError(-32602, "Tool x not found"))
    assert c.code == -32602 and c.message == "Tool x not found"


def test_status_precedence_ints_only() -> None:
    class E(Exception):
        status = 401
        status_code = 500

    assert _coerce.exception_status(E()) == 401

    class OnlyCode(Exception):
        status_code = 403

    assert _coerce.exception_status(OnlyCode()) == 403

    class WithResponse(Exception):
        response = type("R", (), {"status_code": 429})()

    assert _coerce.exception_status(WithResponse()) == 429

    class Wrong(Exception):
        status = "401"
        status_code = True

    assert _coerce.exception_status(Wrong()) is None


def test_coerce_error_other_shapes() -> None:
    assert _coerce.coerce_error("plain").name == "Error"
    assert _coerce.coerce_error(5).message == "5"
    assert _coerce.coerce_error({"isError": True, "content": []}).message == ""
    assert _coerce.coerce_error({"isError": True, "content": [{"text": None}]}).message == ""
    full = _coerce.coerce_error(ValueError("v"), with_stack_text=True)
    assert full.stack is not None and "ValueError: v" in full.stack


def test_traceback_text_parse_and_frame_normalization() -> None:
    text = 'Traceback (most recent call last):\n  File "/srv/app/a.py", line 3, in outer\n    x()\n  File "/srv/app/b.py", line 9, in inner\n    y()\nValueError: v\n'
    assert _stack.parse_traceback_text(text) == [("/srv/app/a.py", 3, "outer"), ("/srv/app/b.py", 9, "inner")]
    assert _stack.parse_traceback_text(None) == []
    frames, sig = _stack.normalize_frames(_stack.parse_traceback_text(text), cwd="/srv/app")
    assert sig == "inner@b.py:9|outer@a.py:3" and [f.fn for f in frames] == ["inner", "outer"]


def test_our_own_frames_are_never_part_of_a_signature() -> None:
    import opentel_mcp._compose as compose_mod

    frames, sig = _stack.normalize_frames([(compose_mod.__file__, 1, "compute_fingerprint")], cwd="/")
    assert frames == [] and sig == ""


def test_live_traceback_frames_use_the_function_name() -> None:
    def thrower() -> None:
        raise ValueError("x")

    try:
        thrower()
    except ValueError as exc:
        n = normalize_exception(exc, cwd=str(__import__("os").getcwd()))
    assert n.frames[0].fn == "thrower" and n.frames[0].file.endswith("test_units.py")
    assert n.stack_signature.startswith("thrower@")


def test_hash_replaces_lone_surrogates() -> None:
    assert hash_inputs("a\ud800b") == hash_inputs("a�b")
    assert len(hash_inputs("x")) == 16


def test_wire_helpers() -> None:
    class Model:
        is_error = True

        def model_dump(self, **kw: Any) -> dict[str, Any]:
            assert kw == {"by_alias": True, "mode": "json", "exclude_none": True}
            return {"isError": True, "content": []}

    class Wrapper:
        root = Model()

    assert _wire.is_tool_error(Wrapper()) and _wire.to_wire(Wrapper()) == {"isError": True, "content": []}
    assert not _wire.is_tool_error({"isError": 1})  # literal True only
    assert not _wire.is_tool_error(None) and _wire.to_wire(None) == {}
    assert _wire.to_wire({"a": 1}) == {"a": 1}


def test_stderr_exporter_writes_json_lines_with_hex_ids_to_stderr_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    span = provider.get_tracer("t").start_span("tools/call x")
    span.set_attribute("k", "v")
    span.end()
    (done,) = memory.get_finished_spans()
    obj = span_to_object(done)
    assert len(obj["traceId"]) == 32 and len(obj["id"]) == 16 and obj["attributes"] == {"k": "v"}
    exporter = StderrSpanExporter()
    exporter.export([done])
    captured = capsys.readouterr()
    assert captured.out == "" and json.loads(captured.err)["name"] == "tools/call x"
    assert exporter.force_flush() is True
    exporter.shutdown()


def test_dev_sdk_flush_and_shutdown_never_raise() -> None:
    class P:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def force_flush(self, timeout: int) -> bool:
            self.calls.append("flush")
            return True

        def shutdown(self) -> None:
            self.calls.append("shutdown")

    class Broken:
        def force_flush(self, timeout: int) -> bool:
            raise RuntimeError

        def shutdown(self) -> None:
            raise RuntimeError

    p = P()
    sdk = DevSdk(p, Broken())
    assert sdk.force_flush() is False  # a failing provider is reported, not raised
    sdk.shutdown()
    sdk.shutdown()
    assert p.calls == ["flush", "shutdown"]
    assert DevSdk(None, None).force_flush() is True


def test_signal_handler_flushes_then_chains_to_a_callable_previous_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(flush_mod, "_flush_all", lambda: calls.append("flush"))
    monkeypatch.setitem(flush_mod._previous, int(signal.SIGTERM), lambda sig, frame: calls.append("previous"))
    flush_mod._handler_for(int(signal.SIGTERM))(int(signal.SIGTERM), None)
    assert calls == ["flush", "previous"]


def test_signal_handler_respects_an_ignored_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(flush_mod, "_flush_all", lambda: calls.append("flush"))
    monkeypatch.setitem(flush_mod._previous, int(signal.SIGTERM), signal.SIG_IGN)
    flush_mod._handler_for(int(signal.SIGTERM))(int(signal.SIGTERM), None)
    assert calls == ["flush"]
