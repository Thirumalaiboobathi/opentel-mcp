"""The dev-mode OTLP/HTTP JSON exporter (ADR 028 Decision 8): hex ids, not base64; decimal-string integers."""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import IdGenerator, ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanContext, SpanKind, StatusCode, TraceFlags

from opentel_mcp._dev.otlp_json import (
    OtlpJsonSpanExporter,
    encode_attributes,
    encode_export_request,
    hex_span_id,
    hex_trace_id,
)

TRACE_ID = 0x0AF7651916CD43DD8448EB211C80319C
SPAN_ID = 0x00F067AA0BA902B7
PARENT_ID = 0xB7AD6B7169203331


class FixedIds(IdGenerator):
    def generate_span_id(self) -> int:
        return SPAN_ID

    def generate_trace_id(self) -> int:
        return TRACE_ID


def finished_span(with_parent: bool = True) -> ReadableSpan:
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": "svc"}), id_generator=FixedIds())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("opentel-mcp", "0.1.0")
    parent_ctx = None
    if with_parent:
        parent = SpanContext(TRACE_ID, PARENT_ID, is_remote=True, trace_flags=TraceFlags(1))
        parent_ctx = trace.set_span_in_context(trace.NonRecordingSpan(parent))
    span = tracer.start_span("tools/call echo", kind=SpanKind.SERVER, context=parent_ctx)
    span.set_attribute("gen_ai.tool.name", "echo")
    span.set_attribute("mcp.tool.argument_count", 3)
    span.set_attribute("flag", True)
    span.set_attribute("ratio", 0.5)
    span.set_attribute("list", ["a", "b"])
    span.add_event("exception", {"exception.type": "E"})
    span.set_status(StatusCode.ERROR, "boom")
    span.end()
    (done,) = exporter.get_finished_spans()
    return done


def test_ids_are_lowercase_hex_not_base64() -> None:
    span = encode_export_request([finished_span()])["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert span["traceId"] == "0af7651916cd43dd8448eb211c80319c"
    assert span["spanId"] == "00f067aa0ba902b7"
    assert span["parentSpanId"] == "b7ad6b7169203331"
    assert len(span["traceId"]) == 32 and len(span["spanId"]) == 16 and len(span["parentSpanId"]) == 16
    # what protobuf-JSON's default bytes mapping would have produced is explicitly not what we send
    assert span["traceId"] != base64.b64encode(TRACE_ID.to_bytes(16, "big")).decode()
    assert span["spanId"] != base64.b64encode(SPAN_ID.to_bytes(8, "big")).decode()
    assert span["parentSpanId"] != base64.b64encode(PARENT_ID.to_bytes(8, "big")).decode()
    assert (
        hex_trace_id(1) == "0" * 31 + "1" and hex_span_id(255) == "0" * 14 + "ff"
    )  # zero padded, lower case


def test_root_span_has_no_parent_span_id() -> None:
    span = encode_export_request([finished_span(with_parent=False)])["resourceSpans"][0]["scopeSpans"][0][
        "spans"
    ][0]
    assert "parentSpanId" not in span


def test_integers_and_timestamps_are_decimal_strings_and_the_rest_follows_the_otlp_json_mapping() -> None:
    req = encode_export_request([finished_span()])
    rs = req["resourceSpans"][0]
    assert {"key": "service.name", "value": {"stringValue": "svc"}} in rs["resource"]["attributes"]
    scope = rs["scopeSpans"][0]
    assert scope["scope"] == {"name": "opentel-mcp", "version": "0.1.0"}
    span = scope["spans"][0]
    assert span["kind"] == 2  # SERVER
    assert isinstance(span["startTimeUnixNano"], str) and span["startTimeUnixNano"].isdigit()
    assert isinstance(span["endTimeUnixNano"], str) and int(span["endTimeUnixNano"]) >= int(
        span["startTimeUnixNano"]
    )
    by_key = {a["key"]: a["value"] for a in span["attributes"]}
    assert by_key["gen_ai.tool.name"] == {"stringValue": "echo"}
    assert by_key["mcp.tool.argument_count"] == {"intValue": "3"}
    assert by_key["flag"] == {"boolValue": True}
    assert by_key["ratio"] == {"doubleValue": 0.5}
    assert by_key["list"] == {"arrayValue": {"values": [{"stringValue": "a"}, {"stringValue": "b"}]}}
    assert span["status"] == {"code": 2, "message": "boom"}
    (event,) = span["events"]
    assert event["name"] == "exception" and event["timeUnixNano"].isdigit()


def test_bool_is_not_encoded_as_an_int() -> None:
    assert encode_attributes({"b": True, "i": 1}) == [
        {"key": "b", "value": {"boolValue": True}},
        {"key": "i", "value": {"intValue": "1"}},
    ]


class _Capture(BaseHTTPRequestHandler):
    received: list[tuple[str, dict[str, str], bytes]] = []
    status = 200

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).received.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        self.send_response(type(self).status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a: Any) -> None:
        pass


@pytest.fixture
def server() -> Any:
    _Capture.received = []
    _Capture.status = 200
    httpd = HTTPServer(("127.0.0.1", 0), _Capture)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()
    thread.join(5)


def test_posts_application_json_to_the_given_url(server: Any) -> None:
    url = f"http://127.0.0.1:{server.server_address[1]}/v1/traces"
    assert OtlpJsonSpanExporter(url).export([finished_span()]) is SpanExportResult.SUCCESS
    ((path, headers, body),) = _Capture.received
    assert path == "/v1/traces"
    assert (
        headers["content-type"] == "application/json"
    )  # not application/x-protobuf: the dashboard answers 415 to that
    payload = json.loads(body)
    assert (
        payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["traceId"]
        == "0af7651916cd43dd8448eb211c80319c"
    )


def test_failure_returns_failure_and_warns_once_never_raises(server: Any, opentel_logs: Any) -> None:
    exporter = OtlpJsonSpanExporter("http://127.0.0.1:1/v1/traces", timeout_s=1)
    assert exporter.export([finished_span()]) is SpanExportResult.FAILURE
    assert exporter.export([finished_span()]) is SpanExportResult.FAILURE
    assert sum("could not send spans" in r.getMessage() for r in opentel_logs.records) == 1
    _Capture.status = 415
    bad = OtlpJsonSpanExporter(f"http://127.0.0.1:{server.server_address[1]}/v1/traces")
    assert bad.export([finished_span()]) is SpanExportResult.FAILURE


def test_shutdown_stops_exporting(server: Any) -> None:
    exporter = OtlpJsonSpanExporter(f"http://127.0.0.1:{server.server_address[1]}/v1/traces")
    exporter.shutdown()
    assert exporter.export([finished_span()]) is SpanExportResult.FAILURE
    assert _Capture.received == []
