/**
 * @module attributes
 * Semantic attribute constants for opentel-mcp spans.
 *
 * Names follow the MCP semantic conventions published by the OTel GenAI
 * SIG in open-telemetry/semantic-conventions-genai (the conventions moved
 * there from the main semantic-conventions repo, where they're now marked
 * deprecated). That spec's status is Development, not Stable — see ADR 004
 * for what that means for this package and why we're aligning to it now
 * anyway.
 */

// --- Spec attributes (MCP semconv, server span) ---

/** Required. The JSON-RPC method name, e.g. "tools/call". */
export const ATTR_MCP_METHOD_NAME = 'mcp.method.name';

/** Conditionally Required (when the operation targets a specific tool). */
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';

/** Conditionally Required (when the client executes a request with a non-null id). */
export const ATTR_JSONRPC_REQUEST_ID = 'jsonrpc.request.id';

/**
 * Conditionally Required iff the operation fails — either a thrown
 * exception or a successful JSON-RPC response whose CallToolResult carries
 * isError: true, in which case this is set to ERROR_TYPE_TOOL_ERROR.
 */
export const ATTR_ERROR_TYPE = 'error.type';

/**
 * Recommended. SHOULD be "execute_tool" for tool calls, SHOULD NOT be set
 * otherwise. Lets consumers treat MCP tool-call spans like other GenAI
 * tool-call spans.
 */
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/**
 * Well-known error.type value for a JSON-RPC call that succeeded but whose
 * CallToolResult has isError: true — a tool-level failure, not a transport
 * or protocol error.
 */
export const ERROR_TYPE_TOOL_ERROR = 'tool_error';

/** Well-known gen_ai.operation.name value for tool execution. */
export const GEN_AI_OPERATION_NAME_EXECUTE_TOOL = 'execute_tool';

/** Well-known mcp.method.name value for a tools/call request. */
export const MCP_METHOD_NAME_TOOLS_CALL = 'tools/call';

// --- Custom (non-spec) attributes ---

/**
 * NOT part of the MCP semantic conventions. Our own addition: a
 * privacy-preserving alternative to the spec's opt-in
 * gen_ai.tool.call.arguments attribute (which captures full argument
 * values and is therefore Opt-In due to sensitivity). Recording just the
 * count gives shape/anomaly signal (e.g. "this call suddenly has 0 args")
 * without capturing any argument content. See ADR 004 and the README's
 * "Semantic conventions" section.
 */
export const ATTR_MCP_TOOL_ARGUMENT_COUNT = 'mcp.tool.argument_count';

export const ATTR_MCP_SERVER_NAME = 'mcp.server.name';
export const ATTR_MCP_SERVER_VERSION = 'mcp.server.version';

/**
 * NOT part of the MCP semantic conventions. Our own addition, on the
 * mcp.tool.duration histogram (see src/metrics.js): which of the three
 * call outcomes a given duration measurement belongs to. The spec's
 * mcp.server.operation.duration metric (not yet implemented here — see
 * README roadmap) expresses failure only via error.type; this attribute
 * additionally distinguishes "thrown/protocol error" from "silent failure"
 * (isError: true) so both are visible on the same histogram without
 * requiring a join against error.type, which silent failures don't set
 * on the duration metric.
 */
export const ATTR_MCP_TOOL_OUTCOME = 'mcp.tool.outcome';

/** Well-known mcp.tool.outcome value: the call succeeded. */
export const MCP_TOOL_OUTCOME_SUCCESS = 'success';

/** Well-known mcp.tool.outcome value: the handler threw or its promise rejected. */
export const MCP_TOOL_OUTCOME_ERROR = 'error';

/** Well-known mcp.tool.outcome value: isError: true (see ERROR_TYPE_TOOL_ERROR above). */
export const MCP_TOOL_OUTCOME_SILENT_FAILURE = 'silent_failure';
