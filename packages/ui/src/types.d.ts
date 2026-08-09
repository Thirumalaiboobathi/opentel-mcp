/**
 * The serialised span shape opentel-mcp-ui consumes over the wire (SSE
 * stream and the `/api/spans/history` snapshot — see `server.js`).
 *
 * Originally defined in the standalone `opentel-mcp-contract` package
 * (v0.9.0's "two-axis observation contract extraction"); moved back here
 * when that extraction was assessed and reverted before ever publishing
 * (see `packages/contract/README.md` for the full reasoning). This type
 * was always UI-specific, not something `opentel-mcp` core produces or
 * has any reference to — core has zero knowledge of `SerializedSpan`'s
 * existence, so it belongs in the package that actually defines and
 * consumes it, not in a shared contract between the two.
 *
 * This is NOT a re-shaping of an OTel `ReadableSpan` — it is a small,
 * stable, JSON-serialisable projection of the handful of fields the
 * dashboard actually renders, produced by `serialize-span.js`. Keeping it
 * a separate, deliberate shape means the UI never depends on
 * `@opentelemetry/sdk-trace-base`'s own (larger, less stable)
 * `ReadableSpan` interface.
 *
 * WHAT IS DELIBERATELY NOT HERE: `ObservationIntegrity`. Per ADR 008,
 * `ObservationIntegrity` is a property of the whole instrumented process
 * — not of any individual span — and every `SerializedSpan` a consumer
 * ever receives was, by construction, successfully captured and
 * transmitted (i.e. tautologically "observed"). A per-span integrity
 * field would misrepresent that axis. Render `ObservationIntegrity` from
 * `ObservationState` instead (imported from `opentel-mcp` — see
 * `summary.js`), once, alongside the span feed — not as a column on it.
 */
export interface SerializedSpan {
  /** Lowercase hex span id (`ReadableSpan.spanContext().spanId`). */
  id: string;

  /** Lowercase hex trace id (`ReadableSpan.spanContext().traceId`). */
  traceId: string;

  /** Span name, e.g. `"tools/call echo"` (see opentel-mcp core's `TOOLS_CALL_METHOD` naming). */
  name: string;

  /** `gen_ai.tool.name` — the MCP tool that was called, when the span represents a `tools/call`. */
  toolName?: string;

  /** Epoch milliseconds the span started. */
  startTimeMs: number;

  /** Wall-clock span duration in milliseconds. */
  durationMs: number;

  /**
   * The span's own OTel status code, as opentel-mcp set it —
   * `SpanStatusCode[code]` stringified, never the numeric enum. `'ERROR'`
   * covers both a thrown/rejected handler AND an `isError: true` result;
   * distinguish the two using `errorType` below.
   */
  status: 'UNSET' | 'OK' | 'ERROR';

  /**
   * `error.type`, when set. Exactly `'tool_error'` identifies a SILENT
   * failure — `isError: true` inside an otherwise-successful response,
   * the case standard OTel tooling (anything that only checks for a
   * thrown exception) would render as a clean, successful span. Any
   * other value (e.g. an exception's `name`, like `'TypeError'`) is a
   * thrown/protocol-level failure — one a naive tracer would also catch.
   * Absent entirely on a genuine success.
   */
  errorType?: string;

  /** `mcp.failure.category`, when fingerprinting was enabled and the call failed. */
  failureCategory?: string;

  /** `mcp.failure.channel` (ADR 007), when fingerprinting was enabled and the call failed. */
  failureChannel?: string;

  /** `mcp.tool.argument_count`. */
  argumentCount?: number;

  /**
   * Every other span attribute opentel-mcp set, verbatim, keyed by its
   * full attribute name (e.g. `"mcp.tool.cost.usd"`). A passthrough bag
   * rather than named fields for every possible attribute — new
   * attributes core adds show up here automatically without a
   * SerializedSpan version bump.
   */
  attributes: Record<string, string | number | boolean | Array<string | number | boolean>>;
}
