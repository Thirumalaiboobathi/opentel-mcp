"""Security signals end to end with the real dashboard (Python 0.2.0 / ADRs 029-033).

A Python server with all four features on exports to the real ``opentel-mcp-ui`` (``packages/ui``); the assertions go
through the dashboard's own HTTP API (``/api/spans/history``), i.e. exactly the data its Security panel is drawn from:
a pin mismatch, a secret-leak signal, an auth failure and sensitive calls. A second test runs a JS reference server and
the Python server with the SAME tool definitions and asserts the dashboard received the SAME integrity hashes.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

import pytest

from opentel_mcp import compute_tool_definition_hash
from tests import harness
from tests.e2e._security_child import WRONG_PIN, key_shaped
from tests.e2e.ui_support import NODE, PKG_ROOT, REPO_ROOT, Ui, ui, wait_until

__all__ = ["ui"]  # the pytest fixture lives in ui_support

pytestmark = pytest.mark.e2e

JS_SERVER = PKG_ROOT / "tests" / "e2e" / "_js_server.mjs"


def run(argv: list[str], ui: Ui, cwd: Any, **env: str) -> tuple[str, str]:
    full = {**os.environ, "PYTHONPATH": str(PKG_ROOT), "EXPORTER_URL": f"{ui.base}/v1/traces", **env}
    proc = subprocess.Popen(
        argv, cwd=cwd, env=full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8"
    )
    try:
        out, err = proc.communicate(timeout=120)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate(timeout=30)
        raise
    assert proc.returncode == 0, err
    assert out == "", "stdout is the JSON-RPC channel for stdio servers; it must stay clean"
    return out, err


def run_python_server(ui: Ui, **env: str) -> str:
    _, err = run([sys.executable, "-m", "tests.e2e._security_child"], ui, PKG_ROOT, **env)
    return err


def events_of(span: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [e["attributes"] for e in span.get("events", []) if e["name"] == name]


def wait_for_spans(ui: Ui, predicate: Any, what: str) -> list[dict[str, Any]]:
    return wait_until(lambda: predicate(ui.history()) and ui.history(), what)  # type: ignore[no-any-return]


def tool_span(spans: list[dict[str, Any]], tool: str) -> dict[str, Any]:
    (span,) = [s for s in spans if s["name"] == f"tools/call {tool}"]
    return span


def list_spans_with_events(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [s for s in spans if s["name"] == "tools/list" and s.get("events")]


def python_tool_definitions() -> list[dict[str, Any]]:
    """The tools the Python harness server lists, as wire JSON (what a JS server is told to serve too)."""
    return [{"name": n, "description": n, "inputSchema": harness.INPUT_SCHEMA} for n in harness.TOOL_NAMES]


def test_all_four_signals_reach_the_dashboard(ui: Ui) -> None:
    stderr = run_python_server(ui, FLAVOUR="lowlevel")
    spans = wait_for_spans(
        ui,
        lambda s: (
            len([x for x in s if x["name"].startswith("tools/call")]) == 3 and list_spans_with_events(s)
        ),
        "the tool calls and the tools/list span to reach the dashboard",
    )

    # 1. pin mismatch: on the tools/list span, hashes only, high severity
    (list_span,) = list_spans_with_events(spans)
    (mismatch,) = events_of(list_span, "mcp.tool.integrity.pin_mismatch")
    expected_definition = {"name": "ok", "description": "ok", "inputSchema": harness.INPUT_SCHEMA}
    assert mismatch == {
        "gen_ai.tool.name": "ok",
        "mcp.tool.integrity.expected_hash": WRONG_PIN,
        "mcp.tool.integrity.actual_hash": compute_tool_definition_hash(expected_definition),
        "mcp.tool.integrity.severity": "high",
    }
    assert [e["name"] for e in list_span["events"]] == ["mcp.tool.integrity.pin_mismatch"]

    # 2. secret leak: a signal on the emit call, derived data only
    leak = tool_span(spans, "emit")
    assert leak["status"] != "ERROR"  # a leak is not an error
    assert leak["attributes"]["mcp.tool.secret_leak.detected"] is True
    assert leak["attributes"]["mcp.tool.secret_leak.types"] == ["aws_access_key_id"]
    assert leak["attributes"]["mcp.tool.secret_leak.count"] == 1

    # 3. auth failure: the category the panel's per-tool auth counts and burst highlight are computed from
    auth = tool_span(spans, "auth_silent")
    assert auth["status"] == "ERROR" and auth["failureCategory"] == "auth"

    # 4. sensitive calls: the marker and one audit event per call, with the outcome
    assert leak["attributes"]["mcp.tool.sensitive"] is True
    assert auth["attributes"]["mcp.tool.sensitive"] is True
    (leak_audit,) = events_of(leak, "mcp.audit.sensitive_call")
    assert leak_audit["gen_ai.tool.name"] == "emit" and leak_audit["mcp.tool.outcome"] == "success"
    assert isinstance(leak_audit["mcp.tool.duration_ms"], (int, float))
    (auth_audit,) = events_of(auth, "mcp.audit.sensitive_call")
    assert auth_audit["mcp.tool.outcome"] == "silent_failure" and auth_audit["mcp.failure.category"] == "auth"
    ok = tool_span(spans, "ok")
    assert "mcp.tool.sensitive" not in ok["attributes"] and not ok.get("events")

    # privacy: the key-shaped text reached neither the dashboard's data nor the child's stderr
    key = key_shaped()
    assert key not in json.dumps(spans) and key not in stderr
    assert "debug dump" not in json.dumps(spans)

    # the dashboard's own summary still counts the calls as before (3 calls, 1 silent failure)
    summary = ui.summary()
    assert summary["buffered"]["total"] == 3 and summary["buffered"]["silentFailure"] == 1


@pytest.mark.skipif(not harness.IS_V2, reason="one SDK line is enough for the sdk_tracing variant")
@pytest.mark.parametrize("flavour", ["mcpserver"])
def test_security_signals_with_the_sdk_span_enriched(ui: Ui, flavour: str) -> None:
    run_python_server(ui, FLAVOUR=flavour, SDK_TRACING="enrich")
    spans = wait_for_spans(
        ui,
        lambda s: (
            len([x for x in s if x["name"].startswith("tools/call")]) == 3 and list_spans_with_events(s)
        ),
        "the spans to reach the dashboard",
    )
    assert events_of(list_spans_with_events(spans)[0], "mcp.tool.integrity.pin_mismatch")
    assert tool_span(spans, "emit")["attributes"]["mcp.tool.secret_leak.detected"] is True
    assert tool_span(spans, "auth_silent")["failureCategory"] == "auth"
    assert events_of(tool_span(spans, "emit"), "mcp.audit.sensitive_call")


def integrity_hashes(spans: list[dict[str, Any]]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for span in list_spans_with_events(spans):
        for attrs in events_of(span, "mcp.tool.integrity.pin_mismatch"):
            hashes[attrs["gen_ai.tool.name"]] = attrs["mcp.tool.integrity.actual_hash"]
    return hashes


@pytest.mark.skipif(NODE is None, reason="needs node")
def test_js_and_python_servers_report_the_same_integrity_hash_for_the_same_definitions(ui: Ui) -> None:
    tools = python_tool_definitions()
    run([NODE or "node", str(JS_SERVER)], ui, REPO_ROOT, TOOLS_JSON=json.dumps(tools))
    js = integrity_hashes(wait_for_spans(ui, list_spans_with_events, "the JS server's tools/list span"))
    assert set(js) == {t["name"] for t in tools}

    seen_before = {s["id"] for s in ui.history()}
    run_python_server(ui, FLAVOUR="lowlevel", PIN_ALL="1")
    py_spans = wait_for_spans(
        ui,
        lambda s: any(x["id"] not in seen_before for x in list_spans_with_events(s)),
        "the Python server's tools/list span",
    )
    py = integrity_hashes([s for s in py_spans if s["id"] not in seen_before])
    assert py == js, "the same tool definitions must hash identically in both languages"
    for tool in tools:  # and both equal what the exported helper computes for the definition
        assert js[tool["name"]] == compute_tool_definition_hash(tool)
