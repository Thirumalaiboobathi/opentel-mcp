/**
 * @module exporters/stderr
 * A SpanExporter that prints spans to stderr rather than stdout.
 *
 * stdio-transport MCP servers write their JSON-RPC protocol messages to
 * stdout, so a diagnostic exporter sharing that stream would corrupt the
 * protocol for a real client (see ADR 003). Modeled on
 * @opentelemetry/sdk-trace's ConsoleSpanExporter, but writes via
 * console.error (stderr) instead of console.dir (stdout).
 */

export class StderrSpanExporter {
  export(spans, resultCallback) {
    for (const span of spans) {
      console.error({
        resource: { attributes: span.resource.attributes },
        traceId: span.spanContext().traceId,
        name: span.name,
        kind: span.kind,
        id: span.spanContext().spanId,
        timestamp: span.startTime,
        duration: span.duration,
        attributes: span.attributes,
        status: span.status,
        events: span.events,
      });
    }
    // 0 === ExportResultCode.SUCCESS (@opentelemetry/core) — inlined to
    // avoid adding that package as a dependency for one enum value.
    resultCallback({ code: 0 });
  }

  shutdown() {
    return Promise.resolve();
  }

  forceFlush() {
    return Promise.resolve();
  }
}
