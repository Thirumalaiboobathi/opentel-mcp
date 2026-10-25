#!/usr/bin/env python3
"""Writes cases/thrown.py.json: Python-only stack-signature cases (ADR 028, "Python stack signature").

The expectations below are written BY HAND from the ADR's rules; only the SHA-256 is computed, with plain
``hashlib`` and no code from the package under test.  Run ``python conformance/gen_thrown_py.py`` after editing.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent / "cases" / "thrown.py.json"
CTX = {"toolName": "t", "origin": "thrown", "cwd": "/srv/app", "stdlib": ["/usr/lib/python3.12"]}


def frame(filename: str, lineno: int | None, name: str) -> dict[str, object]:
    return {"filename": filename, "lineno": lineno, "name": name}


def case(
    cid: str,
    *,
    frames: list[dict[str, object]],
    stack_signature: str,
    top: str,
    name: str = "RuntimeError",
    message: str = "boom",
    category: str = "internal",
    code: str | None = None,
    ctx: dict[str, object] | None = None,
    normalized_message: str | None = None,
) -> dict[str, object]:
    ctx = ctx or CTX
    norm = message if normalized_message is None else normalized_message
    hash_input = f"v1|{name}|{category}|thrown|t|{norm}|{stack_signature}"
    return {
        "id": cid,
        "input": {"error": {"name": name, "message": message, "code": code, "frames": frames}},
        "ctx": ctx,
        "expect": {
            "stackSignature": stack_signature,
            "signature": f"{name}@{top}"[:60],
            "category": category,
            "errorClass": name,
            "normalizedMessage": norm,
            "hashInput": hash_input,
            "fingerprint": hashlib.sha256(hash_input.encode("utf-8")).hexdigest()[:16],
        },
        "languages": ["py"],
    }


seven = [frame(f"/srv/app/m{i}.py", i * 10, f"f{i}") for i in range(1, 8)]  # outermost first: f1 .. f7

CASES = [
    case(
        "user-frames-innermost-first",
        frames=[frame("/srv/app/server.py", 40, "main"), frame("/srv/app/tools/search.py", 12, "run_query")],
        stack_signature="run_query@tools/search.py:12|main@server.py:40",
        top="run_query:12",
    ),
    case(
        "at-most-five-user-frames",
        frames=seven,
        stack_signature="f7@m7.py:70|f6@m6.py:60|f5@m5.py:50|f4@m4.py:40|f3@m3.py:30",
        top="f7:70",
    ),
    case(
        "stdlib-frames-skipped",
        frames=[frame("/srv/app/a.py", 1, "f"), frame("/usr/lib/python3.12/json/decoder.py", 355, "raw_decode")],
        stack_signature="f@a.py:1",
        top="f:1",
    ),
    case(
        "frozen-and-string-frames-skipped",
        frames=[
            frame("/srv/app/a.py", 3, "g"),
            frame("<frozen importlib._bootstrap>", 1, "_load"),
            frame("<string>", 1, "<module>"),
        ],
        stack_signature="g@a.py:3",
        top="g:3",
    ),
    case(
        "site-packages-fallback-is-dependency",
        frames=[frame("/venv/lib/python3.12/site-packages/httpx/_client.py", 100, "send")],
        stack_signature="send@site-packages/httpx/_client.py:100",
        top="send:100",
        category="dependency",
    ),
    case(
        "user-frames-win-over-site-packages",
        frames=[
            frame("/venv/lib/python3.12/site-packages/mcp/server.py", 9, "dispatch"),
            frame("/srv/app/tool.py", 7, "handler"),
            frame("/venv/lib/python3.12/site-packages/httpx/_client.py", 100, "send"),
        ],
        stack_signature="handler@tool.py:7",
        top="handler:7",
    ),
    case(
        "dist-packages-normalized",
        frames=[frame("/usr/lib/python3/dist-packages/yaml/scanner.py", 55, "scan")],
        stack_signature="scan@site-packages/yaml/scanner.py:55",
        top="scan:55",
        category="dependency",
    ),
    case(
        "site-packages-inside-stdlib-dir-is-not-native",
        frames=[frame("/usr/lib/python3.12/site-packages/foo/bar.py", 5, "go")],
        stack_signature="go@site-packages/foo/bar.py:5",
        top="go:5",
        category="dependency",
    ),
    case(
        "top-level-site-packages-module",
        frames=[frame("/venv/lib/python3.12/site-packages/six.py", 8, "helper")],
        stack_signature="helper@site-packages/six.py:8",
        top="helper:8",
        category="dependency",
    ),
    case(
        "windows-paths",
        frames=[frame("C:\\srv\\app\\tools\\x.py", 9, "run")],
        stack_signature="run@tools/x.py:9",
        top="run:9",
        ctx={**CTX, "cwd": "C:\\srv\\app"},
    ),
    case(
        "unknown-line-number",
        frames=[frame("/srv/app/a.py", None, "f")],
        stack_signature="f@a.py:?",
        top="f:?",
    ),
    case(
        "outside-cwd-stays-absolute",
        frames=[frame("/other/place/x.py", 2, "f")],
        stack_signature="f@/other/place/x.py:2",
        top="f:2",
    ),
    case("no-frames", frames=[], stack_signature="", top="anon:?"),
    case(
        "os-error-code-classifies-network",
        frames=[frame("/srv/app/a.py", 4, "connect")],
        stack_signature="connect@a.py:4",
        top="connect:4",
        name="ConnectionRefusedError",
        message="[Errno 111] Connection refused",
        code="ECONNREFUSED",
        category="network",
        normalized_message="[Errno <NUM>] Connection refused",
    ),
    case(
        "message-normalized-in-hash",
        frames=[frame("/srv/app/a.py", 4, "f")],
        stack_signature="f@a.py:4",
        top="f:4",
        message="user 123e4567-e89b-12d3-a456-426614174000 failed at /var/x/y.json",
        normalized_message="user <UUID> failed at <PATH>",
    ),
    case(
        "function-name-not-qualname",
        frames=[frame("/srv/app/a.py", 4, "method")],
        stack_signature="method@a.py:4",
        top="method:4",
    ),
]

OUT.write_text(
    json.dumps(
        {
            "schema": 1,
            "kind": "thrown-python",
            "note": "Python-only. Hand-written expectations; see conformance/gen_thrown_py.py.",
            "cases": CASES,
        },
        indent=2,
        ensure_ascii=False,
    )
    + "\n",
    encoding="utf-8",
)
print(f"wrote {OUT}")
