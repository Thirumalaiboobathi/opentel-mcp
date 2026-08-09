/**
 * `.d.ts` companion to `attributes.js` (same base name, same directory —
 * TypeScript resolves them as one module's declaration). Declares the
 * literal string type of every value that module exports; see
 * `attributes.js`'s own docblock for what each one means and why
 * `ATTR_MCP_TOOL_OUTCOME` is metric-only, never a span attribute.
 */
export const ERROR_TYPE_TOOL_ERROR: 'tool_error';
export const ATTR_MCP_TOOL_OUTCOME: 'mcp.tool.outcome';
export const MCP_TOOL_OUTCOME_SUCCESS: 'success';
export const MCP_TOOL_OUTCOME_ERROR: 'error';
export const MCP_TOOL_OUTCOME_SILENT_FAILURE: 'silent_failure';
