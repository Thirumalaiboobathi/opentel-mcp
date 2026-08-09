export type { ToolOutcome, ToolOutcomeCounts } from './tool-outcome.d.ts';
export { TOOL_OUTCOME } from './tool-outcome.js';

export type { ObservationIntegrity, ObservationState } from './observation-integrity.d.ts';
export { OBSERVATION_INTEGRITY } from './observation-integrity.js';

export type { SerializedSpan } from './span.d.ts';

export {
  ERROR_TYPE_TOOL_ERROR,
  ATTR_MCP_TOOL_OUTCOME,
  MCP_TOOL_OUTCOME_SUCCESS,
  MCP_TOOL_OUTCOME_ERROR,
  MCP_TOOL_OUTCOME_SILENT_FAILURE,
} from './attributes.js';
