/**
 * @module thrash/attributes
 * Span-event attribute constants for Agent Thrash Detection (v0.6.0).
 *
 * Mirrors src/fingerprint/attributes.js's separation of concerns: this
 * file only holds keys for the mcp.loop.detected span event (see
 * src/thrash/emitter.js). It deliberately does NOT define metric-label
 * constants for these same values — the 5 mcp.tool.loop.* metrics carry
 * only gen_ai.tool.name (src/attributes.js), never a per-attribute
 * constant from here. In particular, mcp.failure.fingerprint and
 * mcp.loop.session_id appear below because span events can carry
 * high-cardinality attributes safely, but both are deliberately excluded
 * from every metric in emitter.js: see src/fingerprint/attributes.js's
 * METRIC_SAFE_ATTRIBUTES docblock for why fingerprint must never become a
 * metric label — session id is exactly the same kind of unbounded,
 * per-caller value, for the same reason.
 */

/** Span event name for a detected agent thrash loop. */
export const SPAN_EVENT_NAME_LOOP_DETECTED = 'mcp.loop.detected';

/** Number of consecutive same-fingerprint failures in the loop, at the moment of detection. */
export const ATTR_MCP_LOOP_LENGTH = 'mcp.loop.length';

/** Cumulative input tokens burned by the loop so far. */
export const ATTR_MCP_LOOP_WASTED_TOKENS_IN = 'mcp.loop.wasted_tokens_in';

/** Cumulative output tokens burned by the loop so far. */
export const ATTR_MCP_LOOP_WASTED_TOKENS_OUT = 'mcp.loop.wasted_tokens_out';

/** Cumulative estimated USD cost burned by the loop so far. */
export const ATTR_MCP_LOOP_WASTED_COST_USD = 'mcp.loop.wasted_cost_usd';

/** Elapsed ms between the loop's first and most recent failure. */
export const ATTR_MCP_LOOP_DURATION_MS = 'mcp.loop.duration_ms';

/** Span id of the loop's first failure. */
export const ATTR_MCP_LOOP_FIRST_SPAN_ID = 'mcp.loop.first_span_id';

/** Trace id of the loop's first failure. */
export const ATTR_MCP_LOOP_FIRST_TRACE_ID = 'mcp.loop.first_trace_id';

/**
 * The session this loop belongs to. Span-event only — see this module's
 * docblock. NEVER add this to METRIC_SAFE_ATTRIBUTES or any metric label:
 * session id is unbounded/per-caller, so putting it on a metric would turn
 * every distinct session into its own permanent time series, exactly the
 * cardinality hazard METRIC_SAFE_ATTRIBUTES exists to prevent.
 */
export const ATTR_MCP_LOOP_SESSION_ID = 'mcp.loop.session_id';
