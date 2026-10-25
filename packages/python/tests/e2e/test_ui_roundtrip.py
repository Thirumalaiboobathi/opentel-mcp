"""End to end with the real dashboard (ADR 028 Decision 10).

Starts ``packages/ui/bin/opentel-mcp-ui.js`` on a free port, runs an instrumented Python MCP server in a child
process with ``setup_sdk=True`` pointed at it, makes a tool call that returns ``isError``, and asserts through the
UI's own ``/api/spans/history`` and ``/api/summary`` that exactly one ``tools/call`` span arrived, marked as a
silent failure, with the hex ids our exporter sent. Every process is cleaned up; waits are on conditions, never
fixed sleeps.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from tests import harness
from tests.conftest import REPO_ROOT, py_cases

pytestmark = pytest.mark.e2e

PKG_ROOT = pathlib.Path(__file__).resolve().parents[2]
UI_BIN = REPO_ROOT / "packages" / "ui" / "bin" / "opentel-mcp-ui.js"
NODE = shutil.which("node")

if NODE is None or not UI_BIN.exists() or not (REPO_ROOT / "node_modules").is_dir():
    pytest.skip(
        "needs node and the monorepo's packages/ui with its npm dependencies installed",
        allow_module_level=True,
    )


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_until(predicate: Callable[[], Any], what: str, timeout: float = 30.0) -> Any:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while True:
        try:
            value = predicate()
            if value:
                return value
        except (urllib.error.URLError, ConnectionError, OSError, ValueError) as exc:
            last = exc
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what} (last error: {last!r})")
        time.sleep(0.02)  # poll interval, not a fixed wait: the loop ends the moment the condition holds


def get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read())


class Ui:
    def __init__(self, proc: subprocess.Popen[bytes], port: int) -> None:
        self.proc = proc
        self.port = port

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def history(self) -> list[dict[str, Any]]:
        spans: list[dict[str, Any]] = get_json(f"{self.base}/api/spans/history")["spans"]
        return spans

    def summary(self) -> dict[str, Any]:
        summary: dict[str, Any] = get_json(f"{self.base}/api/summary")
        return summary


@pytest.fixture
def ui(tmp_path: pathlib.Path) -> Iterator[Ui]:
    port = free_port()
    log = (tmp_path / "ui.log").open("wb")
    proc = subprocess.Popen(
        [NODE or "node", str(UI_BIN), f"--port={port}"], stdout=log, stderr=subprocess.STDOUT, cwd=REPO_ROOT
    )
    handle = Ui(proc, port)
    try:
        wait_until(lambda: proc.poll() is None and handle.summary() is not None, "the dashboard to listen")
        yield handle
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        log.close()
        assert proc.poll() is not None, "dashboard process left running"


def run_child(ui: Ui, **env: str) -> list[dict[str, Any]]:
    """Run the instrumented server once; return the span objects its stderr exporter printed (hex ids)."""
    full = {**os.environ, "PYTHONPATH": str(PKG_ROOT), "EXPORTER_URL": f"{ui.base}/v1/traces", **env}
    proc = subprocess.Popen(
        [sys.executable, "-m", "tests.dev._child"],
        cwd=PKG_ROOT,
        env=full,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        out, err = proc.communicate(timeout=120)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate(timeout=30)
        raise
    assert proc.returncode == 0, err
    assert out == "", "the child must keep stdout clean"
    return [json.loads(line) for line in err.splitlines() if line.startswith("{") and '"traceId"' in line]


def suite_expectation(case_id: str) -> tuple[str, str, str]:
    (case,) = [c for c in py_cases("cases/tool-error.json") if c["id"] == case_id]
    e = case["expect"]
    return str(e["fingerprint"]), str(e["category"]), str(e["channel"])


def only_tool_call(spans: list[dict[str, Any]]) -> dict[str, Any]:
    calls = [s for s in spans if s["name"].startswith("tools/call")]
    assert len(calls) == 1, f"expected exactly one tools/call span, got {[s['name'] for s in spans]}"
    return calls[0]


def assert_silent_failure_roundtrip(
    ui: Ui, printed: list[dict[str, Any]], case_id: str, *, tool: str = "silent"
) -> dict[str, Any]:
    wait_until(lambda: ui.history(), "the span to reach the dashboard")
    span = only_tool_call(ui.history())
    assert span["name"] == f"tools/call {tool}"
    assert span["status"] == "ERROR"
    assert span["toolName"] == tool
    assert span["errorType"] == "tool_error"
    # the ids in the dashboard are the hex ids our exporter sent (and the stderr exporter printed)
    ours = [p for p in printed if p["name"].startswith("tools/call")]
    assert len(ours) == 1
    assert span["id"] == ours[0]["id"] and span["traceId"] == ours[0]["traceId"]
    assert len(span["id"]) == 16 and len(span["traceId"]) == 32
    int(span["id"], 16)
    int(span["traceId"], 16)
    summary = ui.summary()
    assert summary["buffered"]["silentFailure"] == 1
    assert summary["buffered"]["total"] == 1
    if case_id:
        fingerprint, category, channel = suite_expectation(case_id)
        assert span["failureCategory"] == category
        assert span["failureChannel"] == channel
        # cross-language fingerprint identity through the real dashboard
        assert span["attributes"]["mcp.failure.fingerprint"] == fingerprint
    return span


@pytest.mark.skipif(harness.IS_V2, reason="mcp 1.x variant")
def test_mcp1_fastmcp_silent_failure(ui: Ui) -> None:
    printed = run_child(ui, FLAVOUR="fastmcp", TOOL="silent")
    assert_silent_failure_roundtrip(ui, printed, "e2e-silent-text-fastmcp1")


@pytest.mark.skipif(harness.IS_V2, reason="mcp 1.x variant")
def test_mcp1_lowlevel_silent_failure(ui: Ui) -> None:
    printed = run_child(ui, FLAVOUR="lowlevel", TOOL="silent")
    assert_silent_failure_roundtrip(ui, printed, "e2e-silent-text")


@pytest.mark.skipif(not harness.IS_V2, reason="mcp 2.x variants")
class TestMcp2:
    def test_replace(self, ui: Ui) -> None:
        printed = run_child(ui, FLAVOUR="mcpserver", TOOL="silent", SDK_TRACING="replace", LIST_TOOLS="1")
        assert_silent_failure_roundtrip(ui, printed, "e2e-silent-text")
        # only tools/call was taken over: the SDK still produced its own tools/list span in the child ...
        assert any(
            p["name"] == "tools/list" and p["attributes"].get("mcp.method.name") == "tools/list"
            for p in printed
        )
        # ... and the dashboard shows nothing but tools/call spans
        assert all(s["name"].startswith("tools/call") for s in ui.history())

    def test_enrich(self, ui: Ui) -> None:
        printed = run_child(ui, FLAVOUR="mcpserver", TOOL="silent", SDK_TRACING="enrich")
        span = assert_silent_failure_roundtrip(ui, printed, "e2e-silent-text")
        # the span the dashboard received is the SDK's, enriched with ours
        assert span["attributes"]["mcp.protocol.version"]
        assert span["argumentCount"] == 0

    def test_sdk_middleware_already_removed(self, ui: Ui) -> None:
        printed = run_child(ui, FLAVOUR="mcpserver", TOOL="silent", REMOVE_SDK_MIDDLEWARE="1")
        assert_silent_failure_roundtrip(ui, printed, "e2e-silent-text")

    @pytest.mark.parametrize("sdk_tracing", ["replace", "enrich"])
    def test_a_crashing_tool_is_fingerprinted_by_its_original_exception(
        self, ui: Ui, sdk_tracing: str
    ) -> None:
        printed = run_child(ui, FLAVOUR="mcpserver", TOOL="raises", SDK_TRACING=sdk_tracing)
        span = assert_silent_failure_roundtrip(ui, printed, "", tool="raises")
        assert span["attributes"]["mcp.failure.error_class"] == "RuntimeError"  # proves cause capture
        assert span["failureCategory"] == "internal"

    def test_a_successful_call_is_not_a_silent_failure(self, ui: Ui) -> None:
        run_child(ui, FLAVOUR="mcpserver", TOOL="ok")
        wait_until(lambda: ui.history(), "the span to reach the dashboard")
        span = only_tool_call(ui.history())
        assert span["status"] in ("OK", "UNSET") and "errorType" not in span
        assert ui.summary()["buffered"]["silentFailure"] == 0
