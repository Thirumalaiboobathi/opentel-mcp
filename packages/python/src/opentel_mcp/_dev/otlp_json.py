"""A small OTLP/HTTP **JSON** trace exporter, used only by dev mode to talk to opentel-mcp-ui.

Not a general-purpose exporter and not part of the public API (ADR 028, round-1 decision 3): production users keep
the standard ``opentelemetry-exporter-otlp-proto-http`` exporter with their own provider. The official one sends
only ``application/x-protobuf``, which the dashboard answers with 415.

The OTLP JSON mapping differs from protobuf-JSON defaults in two ways that matter here: trace and span ids are
**hex** strings (32/16 lowercase characters), never base64, and 64-bit integers (``…UnixNano``, ``intValue``) are
decimal strings.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

logger = logging.getLogger("opentel_mcp")

# opentelemetry.trace.SpanKind -> OTLP SpanKind enum number.
_KIND = {"INTERNAL": 1, "SERVER": 2, "CLIENT": 3, "PRODUCER": 4, "CONSUMER": 5}
# opentelemetry.trace.StatusCode -> OTLP Status.StatusCode number.
_STATUS = {"UNSET": 0, "OK": 1, "ERROR": 2}


def hex_trace_id(trace_id: int) -> str:
    return format(trace_id, "032x")


def hex_span_id(span_id: int) -> str:
    return format(span_id, "016x")


def encode_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return {"arrayValue": {"values": [encode_value(v) for v in value]}}
    return {"stringValue": str(value)}


def encode_attributes(attributes: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    return [{"key": str(k), "value": encode_value(v)} for k, v in (attributes or {}).items()]


def encode_span(span: ReadableSpan) -> dict[str, Any]:
    ctx = span.get_span_context()
    assert ctx is not None
    out: dict[str, Any] = {
        "traceId": hex_trace_id(ctx.trace_id),
        "spanId": hex_span_id(ctx.span_id),
        "name": span.name,
        "kind": _KIND.get(span.kind.name, 0),
        "startTimeUnixNano": str(span.start_time or 0),
        "endTimeUnixNano": str(span.end_time or span.start_time or 0),
        "attributes": encode_attributes(span.attributes),
        "events": [
            {
                "timeUnixNano": str(e.timestamp),
                "name": e.name,
                "attributes": encode_attributes(e.attributes),
            }
            for e in span.events
        ],
        "status": {"code": _STATUS.get(span.status.status_code.name, 0)},
    }
    if span.parent is not None:
        out["parentSpanId"] = hex_span_id(span.parent.span_id)
    if span.status.description:
        out["status"]["message"] = span.status.description
    return out


def encode_export_request(spans: Sequence[ReadableSpan]) -> dict[str, Any]:
    """``ExportTraceServiceRequest`` as OTLP JSON, grouped by resource and instrumentation scope."""
    groups: dict[int, tuple[ReadableSpan, dict[tuple[str, str], list[dict[str, Any]]]]] = {}
    for span in spans:
        res_key = id(span.resource)
        if res_key not in groups:
            groups[res_key] = (span, {})
        scope = span.instrumentation_scope
        scope_key = (getattr(scope, "name", "") or "", getattr(scope, "version", "") or "")
        groups[res_key][1].setdefault(scope_key, []).append(encode_span(span))
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": encode_attributes(first.resource.attributes)},
                "scopeSpans": [
                    {"scope": {"name": name, "version": version}, "spans": encoded}
                    for (name, version), encoded in scopes.items()
                ],
            }
            for first, scopes in groups.values()
        ]
    }


class OtlpJsonSpanExporter(SpanExporter):
    """POSTs OTLP/HTTP JSON (``Content-Type: application/json``) with the stdlib; failures never raise.

    One attempt per batch, no retries; ``timeout_s`` bounds connect and every socket read, so an unreachable or
    silent endpoint costs at most about that long.
    """

    def __init__(self, url: str, timeout_s: float = 2.0) -> None:
        self._url = url
        self._timeout_s = timeout_s
        self._warned = False
        self._shutdown = False

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._shutdown:
            return SpanExportResult.FAILURE
        try:
            body = json.dumps(encode_export_request(spans)).encode("utf-8")
            request = urllib.request.Request(
                self._url, data=body, method="POST", headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=self._timeout_s) as response:
                response.read()
            return SpanExportResult.SUCCESS
        except Exception as exc:
            if not self._warned:
                self._warned = True
                logger.warning(
                    "opentel-mcp: could not send spans to %s (%s); is opentel-mcp-ui running? Further failures are not logged.",
                    self._url,
                    type(exc).__name__,
                )
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        self._shutdown = True

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True
