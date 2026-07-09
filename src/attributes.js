/**
 * @module attributes
 * Semantic attribute constants for opentel-mcp spans.
 *
 * Naming follows OpenTelemetry semantic-conventions style (`ATTR_*`
 * constants holding dot-namespaced strings), mirroring the pattern used by
 * `@opentelemetry/semantic-conventions`. If the OTel GenAI SIG publishes
 * official semantic conventions for MCP upstream, this module will be
 * updated to align with them.
 */

export const ATTR_MCP_SERVER_NAME = 'mcp.server.name';
export const ATTR_MCP_SERVER_VERSION = 'mcp.server.version';
export const ATTR_MCP_TOOL_NAME = 'mcp.tool.name';
export const ATTR_MCP_TOOL_STATUS = 'mcp.tool.status';
export const ATTR_MCP_TOOL_ARGUMENT_COUNT = 'mcp.tool.argument_count';
export const ATTR_MCP_TOOL_ERROR_TYPE = 'mcp.tool.error.type';
export const ATTR_MCP_TOOL_ERROR_MESSAGE = 'mcp.tool.error.message';
export const ATTR_MCP_REQUEST_ID = 'mcp.request.id';

/**
 * Values for ATTR_MCP_TOOL_STATUS. Also used to derive OTel span status
 * in instrument.js.
 * @enum {string}
 */
export const MCP_TOOL_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
});

/**
 * Span name for every tool invocation. Kept low-cardinality per OTel
 * span-naming best practice; use ATTR_MCP_TOOL_NAME for per-tool
 * filtering instead of encoding the tool name into the span name.
 */
export const MCP_TOOL_CALL_SPAN_NAME = 'mcp.tool.call';
