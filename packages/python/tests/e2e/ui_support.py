"""Shared helpers for the end-to-end tests: start the real opentel-mcp-ui and poll its HTTP API (no fixed sleeps)."""

from __future__ import annotations

import json
import pathlib
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from tests.conftest import REPO_ROOT

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
