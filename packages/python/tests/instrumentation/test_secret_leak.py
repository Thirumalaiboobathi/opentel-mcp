"""Opt-in secret leak detection in tool outputs (ADR 030)."""

from __future__ import annotations

import logging
import time
from typing import Any

import pytest
from opentelemetry.trace import StatusCode

from opentel_mcp import _leak, instrument_mcp_server
from opentel_mcp._config import resolve_options
from opentel_mcp._leak import resolve_secret_leak_config, scan_result_for_secrets
from tests import harness
from tests.conftest import Telemetry
from tests.variants import VARIANT_IDS, VARIANTS, attrs, points, total

pytestmark = pytest.mark.anyio

# Key-shaped values are assembled at runtime so no credential-looking literal exists in source.
AWS = "AKIA" + "IOSFODNN7" + "EXAMPLE"
OPENAI = "sk" + "-" + "abcdefghijklmnopqrstuvwxyz" + "1234"
GITHUB = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz" + "0123456789"
JWT = ".".join(["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnop_-qrstuv"])
BEARER = "Bearer " + "abcdefghijklmnopqrstuvwxyz" + "012345"
URL = "postgres://" + "admin:" + "hunter2pass" + "@db.internal/app"
ASSIGN = "pass" + "word=" + "hunter2"

CASES = {
    "aws_access_key_id": AWS,
    "provider_api_key": OPENAI,
    "jwt": JWT,
    "http_auth_credential": BEARER,
    "url_credentials": URL,
    "secret_assignment": ASSIGN,
}

NAME = "mcp.tool.secret_leaks"


def make(flavour: str, mode: str, **options: Any) -> tuple[Any, Any]:
    options.setdefault("secret_leak_detection", {"enabled": True})
    return harness.build(flavour, lambda s: instrument_mcp_server(s, sdk_tracing=mode, **options))


@pytest.fixture(params=VARIANTS, ids=VARIANT_IDS)
def variant(request: pytest.FixtureRequest) -> tuple[str, str, bool]:
    return request.param  # type: ignore[no-any-return]


# --- option -------------------------------------------------------------------------------------------------------


def _warn(*_: Any) -> None:
    return None


def test_default_is_off_and_defaults_are_the_documented_ones() -> None:
    cfg = resolve_options().secret_leak
    assert (cfg.enabled, cfg.max_scan_bytes) == (False, 65536)
    assert resolve_options(secret_leak_detection={"enabled": True}).secret_leak.max_scan_bytes == 65536


@pytest.mark.parametrize("bad", ["yes", 1, [], ("enabled",), True, 3.5])
def test_non_dict_option_warns_once_and_is_ignored(bad: Any, opentel_logs: pytest.LogCaptureFixture) -> None:
    cfg = resolve_options(secret_leak_detection=bad).secret_leak
    resolve_options(secret_leak_detection=bad)
    assert cfg.enabled is False
    assert len([r for r in opentel_logs.records if r.levelno == logging.WARNING]) == 1


@pytest.mark.parametrize("bad", [0, -1, 1.5, "100", True, float("nan"), float("inf")])
def test_bad_max_scan_bytes_falls_back_with_one_warning(
    bad: Any, opentel_logs: pytest.LogCaptureFixture
) -> None:
    cfg = resolve_options(secret_leak_detection={"enabled": True, "max_scan_bytes": bad}).secret_leak
    assert (cfg.enabled, cfg.max_scan_bytes) == (True, 65536)
    (w,) = [r for r in opentel_logs.records if r.levelno == logging.WARNING]
    assert repr(bad) not in w.getMessage() or bad in (
        0,
        -1,
    )  # the value itself is never echoed (numbers aside)


def test_bad_enabled_keeps_it_off(opentel_logs: pytest.LogCaptureFixture) -> None:
    assert resolve_options(secret_leak_detection={"enabled": "true"}).secret_leak.enabled is False
    assert len([r for r in opentel_logs.records if r.levelno == logging.WARNING]) == 1


def test_integral_float_and_valid_int_are_accepted() -> None:
    assert (
        resolve_options(
            secret_leak_detection={"enabled": True, "max_scan_bytes": 4096.0}
        ).secret_leak.max_scan_bytes
        == 4096
    )
    assert (
        resolve_options(
            secret_leak_detection={"enabled": True, "max_scan_bytes": 1}
        ).secret_leak.max_scan_bytes
        == 1
    )


def test_hostile_option_mapping_never_raises() -> None:
    class Hostile(dict):  # type: ignore[type-arg]
        def get(self, *a: Any) -> Any:
            raise RuntimeError("boom")

        def __contains__(self, k: object) -> bool:
            raise RuntimeError("boom")

    assert resolve_secret_leak_config(Hostile(), _warn).enabled is False


# --- end to end, both SDK lines ---------------------------------------------------------------------------------


@pytest.mark.parametrize(("kind", "text"), CASES.items(), ids=CASES.keys())
async def test_each_type_is_detected_in_a_success_result(
    kind: str, text: str, variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("emit", {"text": f"here you go: {text}"})
    assert not out.is_error
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert a["mcp.tool.secret_leak.detected"] is True
    assert kind in a["mcp.tool.secret_leak.types"]
    assert list(a["mcp.tool.secret_leak.types"]) == sorted(a["mcp.tool.secret_leak.types"])
    assert isinstance(a["mcp.tool.secret_leak.count"], int) and a["mcp.tool.secret_leak.count"] >= 1
    assert "mcp.tool.secret_leak.scan_truncated" not in a
    assert span.status.status_code is StatusCode.OK  # a leak is a signal, not an error
    assert points(telemetry, NAME) == [({"gen_ai.tool.name": "emit"}, 1)]


async def test_secret_in_an_error_result_is_detected_and_status_stays_error(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("emit_err", {"text": f"upstream said {BEARER}"})
    assert out.is_error
    (span,) = telemetry.tool_call_spans()
    a = attrs(span)
    assert (
        a["mcp.tool.secret_leak.detected"] is True
        and "http_auth_credential" in a["mcp.tool.secret_leak.types"]
    )
    assert span.status.status_code is StatusCode.ERROR
    assert a["error.type"] == "tool_error"
    assert points(telemetry, NAME) == [({"gen_ai.tool.name": "emit_err"}, 1)]


async def test_clean_results_leave_no_trace(variant: tuple[str, str, bool], telemetry: Telemetry) -> None:
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        await client.call("emit", {"text": "all good, nothing to see"})
    (span,) = telemetry.tool_call_spans()
    assert not any(k.startswith("mcp.tool.secret_leak.") for k in attrs(span))
    assert NAME not in telemetry.metric_points()


async def test_disabled_by_default_and_when_false(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    for opts in ({"secret_leak_detection": None}, {"secret_leak_detection": {"enabled": False}}):
        server, lowlevel = harness.build(
            variant[0], lambda s, o=opts: instrument_mcp_server(s, sdk_tracing=variant[1], **o)
        )
        async with harness.connect(server, lowlevel) as client:
            await client.call("emit", {"text": AWS})
    assert not any(
        k.startswith("mcp.tool.secret_leak.") for s in telemetry.tool_call_spans() for k in attrs(s)
    )
    assert NAME not in telemetry.metric_points()


async def test_metrics_disabled_still_sets_span_attributes(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    server, lowlevel = make(variant[0], variant[1], enable_metrics=False)
    async with harness.connect(server, lowlevel) as client:
        await client.call("emit", {"text": AWS})
    (span,) = telemetry.tool_call_spans()
    assert attrs(span)["mcp.tool.secret_leak.detected"] is True
    assert NAME not in telemetry.metric_points()


async def test_truncation_is_flagged_and_counted_in_utf16_units(
    variant: tuple[str, str, bool], telemetry: Telemetry
) -> None:
    # 10 rockets = 20 UTF-16 units; the key starts at unit 20. A budget of 30 units cuts it, 40 + len fits.
    text = "\U0001f680" * 10 + AWS
    server, lowlevel = make(
        variant[0], variant[1], secret_leak_detection={"enabled": True, "max_scan_bytes": 30}
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call("emit", {"text": text})
    server2, lowlevel2 = make(
        variant[0], variant[1], secret_leak_detection={"enabled": True, "max_scan_bytes": 20 + len(AWS)}
    )
    async with harness.connect(server2, lowlevel2) as client:
        await client.call("emit", {"text": text})
    cut, fits = telemetry.tool_call_spans()
    assert attrs(cut)["mcp.tool.secret_leak.scan_truncated"] is True
    assert "mcp.tool.secret_leak.detected" not in attrs(cut)
    assert attrs(fits)["mcp.tool.secret_leak.detected"] is True
    assert "mcp.tool.secret_leak.scan_truncated" not in attrs(fits)
    assert total(telemetry, NAME) == 1


async def test_detection_failure_never_reaches_the_call(
    variant: tuple[str, str, bool],
    telemetry: Telemetry,
    monkeypatch: pytest.MonkeyPatch,
    opentel_logs: pytest.LogCaptureFixture,
) -> None:
    def boom(*_: Any, **__: Any) -> Any:
        raise RuntimeError(f"detector exploded on {AWS}")

    monkeypatch.setattr(_leak, "detect_secret_types_u16", boom)
    server, lowlevel = make(variant[0], variant[1])
    async with harness.connect(server, lowlevel) as client:
        out = await client.call("emit", {"text": AWS})
    assert not out.is_error and out.texts == [AWS]
    (span,) = telemetry.tool_call_spans()
    assert not any(k.startswith("mcp.tool.secret_leak.") for k in attrs(span))
    assert span.status.status_code is StatusCode.OK
    assert AWS not in opentel_logs.text


# --- canary: the matched text reaches no span, event, metric or log ---------------------------------------------


async def test_matched_text_never_reaches_spans_events_metrics_or_logs(
    variant: tuple[str, str, bool], telemetry: Telemetry, opentel_logs: pytest.LogCaptureFixture
) -> None:
    server, lowlevel = make(variant[0], variant[1], sensitive_tools=["emit*"])
    secrets = list(CASES.values())
    async with harness.connect(server, lowlevel) as client:
        for text in secrets:
            await client.call("emit", {"text": f"x {text} y"})
            await client.call("emit_err", {"text": f"x {text} y"})
    everything = (
        repr(
            [
                (
                    s.name,
                    dict(s.attributes or {}),
                    [(e.name, dict(e.attributes or {})) for e in s.events],
                    s.status,
                )
                for s in telemetry.spans()
            ]
        )
        + repr(telemetry.metric_points())
        + opentel_logs.text
    )
    for text in secrets:
        # the secret-assignment value and every other recognizable fragment
        for fragment in {
            text,
            text.split("=")[-1],
            text.split(":")[-1],
            text.split("@")[0][-12:],
            text[-14:],
        }:
            if len(fragment) >= 8:
                assert fragment not in everything, fragment
    assert total(telemetry, NAME) == 2 * len(secrets)


# --- scanner unit tests: hostile shapes, windows, performance ---------------------------------------------------


def _scan(result: Any, cap: int = 65536) -> Any:
    return scan_result_for_secrets(result, cap)


def test_hostile_result_shapes_never_raise() -> None:
    class Boom:
        @property
        def content(self) -> Any:
            raise RuntimeError("getter boom")

    class BoomItem:
        type = "text"

        @property
        def text(self) -> Any:
            raise RuntimeError("getter boom")

    class HostileList(list):  # type: ignore[type-arg]
        def __len__(self) -> int:
            raise RuntimeError("len boom")

    shapes: list[Any] = [
        None,
        42,
        "string",
        b"bytes",
        [],
        {},
        {"content": None},
        {"content": "AKIA..."},
        {"content": {"0": {"type": "text", "text": AWS}}},
        {"content": (x for x in [{"type": "text", "text": AWS}])},
        {
            "content": [
                None,
                1,
                "x",
                [],
                {"type": "text"},
                {"type": "text", "text": None},
                {"type": "text", "text": 5},
            ]
        },
        {"content": [{"type": ["text"], "text": AWS}]},
        {"content": [{"type": "text", "text": b"AKIA"}]},
        Boom(),
        {"content": [BoomItem()]},
        {"content": HostileList([{"type": "text", "text": AWS}])},
    ]
    for shape in shapes:
        out = _scan(shape)
        assert out is None or isinstance(out.count, int)


def test_models_and_dicts_are_scanned_alike() -> None:
    class Item:
        type = "text"

        def __init__(self, text: str) -> None:
            self.text = text

    class Result:
        def __init__(self, content: Any) -> None:
            self.content = content

    for result in (
        {"content": [{"type": "text", "text": AWS}]},
        Result([Item(AWS)]),
        Result((Item(AWS),)),
        {"root": 1, "content": ({"type": "text", "text": AWS},)},
    ):
        out = _scan(result)
        assert out is not None and out.types == {"aws_access_key_id"} and out.count == 1


def test_non_text_items_and_structured_content_are_not_scanned() -> None:
    result = {
        "content": [{"type": "image", "data": AWS}, {"type": "resource", "resource": {"text": AWS}}],
        "structuredContent": {"k": AWS},
        "_meta": {"k": AWS},
    }
    out = _scan(result)
    assert out is not None and out.types == frozenset() and out.count == 0


def test_a_secret_split_across_items_is_missed() -> None:
    out = _scan({"content": [{"type": "text", "text": AWS[:10]}, {"type": "text", "text": AWS[10:]}]})
    assert out is not None and out.count == 0


def test_item_count_is_bounded() -> None:
    items = [{"type": "text", "text": "ok"}] * 10_000 + [{"type": "text", "text": AWS}]
    out = _scan({"content": items})
    assert out is not None and out.count == 0 and out.truncated is True


def test_a_huge_single_item_is_cut_cheaply() -> None:
    started = time.perf_counter()
    out = _scan({"content": [{"type": "text", "text": "a" * 50_000_000 + AWS}]})
    assert out is not None and out.truncated is True and out.count == 0
    assert time.perf_counter() - started < 1.0


def test_match_count_is_capped() -> None:
    out = _scan({"content": [{"type": "text", "text": (AWS + " ") * 5000}]})
    assert out is not None and out.count == 1000


@pytest.mark.parametrize(
    "text",
    [
        "a" * 65536,
        "a://" + "b:" * 32000,
        "scheme://" + "u" * 65000,
        "x://" + "a:" * 20000 + "b" * 20000,
        "eyJ" + "a" * 65000,
        "eyJaaaaaa.eyJaaaaaa." + "a" * 64000,
        "sk-" + "a" * 65000,
        "Bearer " + "a" * 65000,
        "Bearer " + "a" * 15 + " " + ("Bearer " + "a" * 15 + " ") * 3000,
        "password=" * 7000,
        "password:" + "a" * 64000,
        "token : " * 8000,
        ("api_key" + " " * 40) * 1500,
        "A" * 65000 + "KIA",
        ("ab" * 40 + ":") * 800 + "//",
        "\U0001f680" * 32000,
        "http://" + "\u00e9" * 60000,
        ("." * 255 + ":") * 250,
    ],
)
def test_pathological_inputs_stay_fast_at_the_cap(text: str) -> None:
    started = time.perf_counter()
    out = _scan({"content": [{"type": "text", "text": text}]})
    elapsed = time.perf_counter() - started
    assert out is not None
    assert elapsed < 3.0, f"{elapsed:.2f}s"


def test_benign_64k_scan_is_fast() -> None:
    text = ("lorem ipsum dolor sit amet, consectetur " * 2000)[:65536]
    started = time.perf_counter()
    for _ in range(5):
        _scan({"content": [{"type": "text", "text": text}]})
    assert (time.perf_counter() - started) / 5 < 0.25
