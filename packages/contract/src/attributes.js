/**
 * @module attributes
 *
 * Span/metric attribute constants for the `mcp.tool.outcome` half of
 * opentel-mcp's telemetry surface. Moved out of opentel-mcp core
 * (v0.9.0, `src/attributes.js`) as part of the two-axis observation
 * contract extraction — everything else in core's `attributes.js`
 * (cost/token/budget attributes, spec attributes like
 * `mcp.method.name`, the general `error.type`/`ATTR_ERROR_TYPE`
 * attribute name) stays in core; only the constants below, all specific
 * to the two-axis contract, moved here. Core re-exports all of them
 * (`src/attributes.js`) so its own emission and any consumer of this
 * package can never define two different copies of the same value.
 *
 * IMPORTANT: `ATTR_MCP_TOOL_OUTCOME` is a METRIC attribute only — set on
 * the `mcp.tool.duration` histogram's data points (opentel-mcp core's
 * `src/metrics.js`), never as a span attribute (ADR 008, Finding 5). A
 * per-span "silent failure" (isError: true reported inside an
 * otherwise-successful response) is identified on the SPAN itself via
 * `error.type === ERROR_TYPE_TOOL_ERROR` below, combined with the span's
 * own status code — not via this attribute. See `span.d.ts`'s
 * `SerializedSpan.errorType` in this package for the exact per-span
 * discriminator a consumer should use.
 */

/**
 * Well-known `error.type` value for a JSON-RPC call that succeeded but
 * whose CallToolResult has `isError: true` — a tool-level failure, not a
 * thrown exception or transport/protocol error. The one value in this
 * file that is a genuine SPAN attribute value (set via opentel-mcp
 * core's own `ATTR_ERROR_TYPE`, `'error.type'`, which stays in core since
 * it's a general-purpose attribute name, not specific to this contract).
 */
export const ERROR_TYPE_TOOL_ERROR = 'tool_error';

/**
 * NOT part of the MCP semantic conventions. opentel-mcp's own addition, on
 * the `mcp.tool.duration` histogram (see opentel-mcp core's
 * `src/metrics.js`): which of the three call outcomes a given duration
 * measurement belongs to. Metric attribute only — see this module's
 * docblock.
 */
export const ATTR_MCP_TOOL_OUTCOME = 'mcp.tool.outcome';

/** Well-known mcp.tool.outcome value: the call succeeded. */
export const MCP_TOOL_OUTCOME_SUCCESS = 'success';

/** Well-known mcp.tool.outcome value: the handler threw or its promise rejected. */
export const MCP_TOOL_OUTCOME_ERROR = 'error';

/** Well-known mcp.tool.outcome value: isError: true (see ERROR_TYPE_TOOL_ERROR above). */
export const MCP_TOOL_OUTCOME_SILENT_FAILURE = 'silent_failure';
