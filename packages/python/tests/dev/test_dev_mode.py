"""Dev mode (``setup_sdk=True``) in a real process: stderr only, OTLP JSON out, flush on exit and on SIGTERM."""

from __future__ import annotations

import json
import os
import pathlib
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

PKG_ROOT = pathlib.Path(__file__).resolve().parents[2]


class _Sink(BaseHTTPRequestHandler):
    bodies: list[dict[str, Any]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        assert self.headers["Content-Type"] == "application/json"
        type(self).bodies.append(json.loads(body))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a: Any) -> None:
        pass


@pytest.fixture
def sink() -> Any:
    _Sink.bodies = []
    httpd = HTTPServer(("127.0.0.1", 0), _Sink)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd, f"http://127.0.0.1:{httpd.server_address[1]}/v1/traces"
    httpd.shutdown()
    httpd.server_close()
    thread.join(5)


def spawn(**env: str) -> subprocess.Popen[str]:
    full = {
        **os.environ,
        "PYTHONPATH": str(PKG_ROOT),
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
        **env,
    }
    return subprocess.Popen(
        [sys.executable, "-m", "tests.dev._child"],
        cwd=PKG_ROOT,
        env=full,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def span_names(bodies: list[dict[str, Any]]) -> list[str]:
    return [
        s["name"]
        for b in bodies
        for rs in b["resourceSpans"]
        for ss in rs["scopeSpans"]
        for s in ss["spans"]
        if s["name"].startswith("tools/call")
    ]


def test_stderr_gets_spans_and_metrics_and_stdout_stays_clean() -> None:
    proc = spawn()
    out, err = proc.communicate(timeout=60)
    assert proc.returncode == 0, err
    assert out == "", "stdout is the JSON-RPC channel for stdio servers"
    span_lines = [
        json.loads(line) for line in err.splitlines() if line.startswith("{") and '"traceId"' in line
    ]
    tool_spans = [s for s in span_lines if s["name"].startswith("tools/call")]
    assert len(tool_spans) == 1
    s = tool_spans[0]
    assert s["resource"]["attributes"]["service.name"] == "dev-mode-test"
    assert len(s["traceId"]) == 32 and len(s["id"]) == 16
    assert s["attributes"]["error.type"] == "tool_error"
    # metrics are flushed at exit, so the final export carries them
    assert "mcp.tool.silent_failures" in err and "mcp.tool.calls" in err


def test_exporter_url_gets_otlp_json_with_hex_ids_flushed_on_normal_exit(sink: Any) -> None:
    _, url = sink
    proc = spawn(EXPORTER_URL=url)
    _, err = proc.communicate(timeout=60)
    assert proc.returncode == 0, err
    assert span_names(_Sink.bodies) == [span_names(_Sink.bodies)[0]] and len(span_names(_Sink.bodies)) == 1
    span = next(
        s
        for b in _Sink.bodies
        for rs in b["resourceSpans"]
        for ss in rs["scopeSpans"]
        for s in ss["spans"]
        if s["name"].startswith("tools/call")
    )
    int(span["traceId"], 16)
    int(span["spanId"], 16)
    assert len(span["traceId"]) == 32 and len(span["spanId"]) == 16


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_sigterm_flushes_then_exits_with_the_default_status(sink: Any, tmp_path: pathlib.Path) -> None:
    _, url = sink
    ready = tmp_path / "ready"
    proc = spawn(EXPORTER_URL=url, WAIT="1", READY_FILE=str(ready))
    deadline = time.monotonic() + 60
    while not ready.exists():
        assert proc.poll() is None, proc.communicate()[1]
        assert time.monotonic() < deadline, "child never became ready"
        time.sleep(0.05)
    assert _Sink.bodies == [], "the batch processor has not flushed yet (5s schedule delay)"
    proc.send_signal(signal.SIGTERM)
    proc.communicate(timeout=30)
    assert proc.returncode == -signal.SIGTERM  # re-raised with the default handler: usual exit status
    assert len(span_names(_Sink.bodies)) == 1


def test_force_flush_sends_spans_without_waiting_for_exit(sink: Any, tmp_path: pathlib.Path) -> None:
    _, url = sink
    ready = tmp_path / "ready"
    proc = spawn(EXPORTER_URL=url, WAIT="1", READY_FILE=str(ready), FORCE_FLUSH="1")
    try:
        deadline = time.monotonic() + 60
        while not ready.exists():
            assert proc.poll() is None, proc.communicate()[1]
            assert time.monotonic() < deadline
            time.sleep(0.05)
        assert len(span_names(_Sink.bodies)) == 1
    finally:
        proc.kill()
        proc.communicate(timeout=30)
