"""Dev-mode exporters that write to **stderr**, never stdout (stdout is the JSON-RPC channel for stdio servers)."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from .otlp_json import hex_span_id, hex_trace_id


def _jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return str(value)


def span_to_object(span: ReadableSpan) -> dict[str, Any]:
    """The object shape ``exporters/stderr.js`` prints, with hex ids."""
    ctx = span.get_span_context()
    assert ctx is not None
    return {
        "resource": {"attributes": _jsonable(dict(span.resource.attributes))},
        "traceId": hex_trace_id(ctx.trace_id),
        "name": span.name,
        "kind": span.kind.name,
        "id": hex_span_id(ctx.span_id),
        "timestamp": span.start_time,
        "duration": (span.end_time or 0) - (span.start_time or 0),
        "attributes": _jsonable(dict(span.attributes or {})),
        "status": {"code": span.status.status_code.name, "message": span.status.description},
        "events": [
            {"name": e.name, "time": e.timestamp, "attributes": _jsonable(dict(e.attributes or {}))}
            for e in span.events
        ],
    }


class StderrSpanExporter(SpanExporter):
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            for span in spans:
                print(json.dumps(span_to_object(span), default=str), file=sys.stderr, flush=True)
            return SpanExportResult.SUCCESS
        except Exception:
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True
