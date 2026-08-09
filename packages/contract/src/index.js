/**
 * @module opentel-mcp-contract
 *
 * The two-axis observation contract (ADR 008) that opentel-mcp core
 * emits and opentel-mcp-ui renders: `ToolOutcome` (did the tool succeed
 * or fail?) and `ObservationIntegrity` (can the instrumentation actually
 * tell?), plus the span-attribute constants and serialised-span shape
 * needed to observe them. Zero runtime dependencies — types and frozen
 * constant objects only, so it is safe to depend on from anywhere
 * (including Lambda-style core deployments, and the UI).
 */

export { TOOL_OUTCOME } from './tool-outcome.js';
export { OBSERVATION_INTEGRITY } from './observation-integrity.js';
export {
  ERROR_TYPE_TOOL_ERROR,
  ATTR_MCP_TOOL_OUTCOME,
  MCP_TOOL_OUTCOME_SUCCESS,
  MCP_TOOL_OUTCOME_ERROR,
  MCP_TOOL_OUTCOME_SILENT_FAILURE,
} from './attributes.js';
