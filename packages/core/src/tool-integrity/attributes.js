/**
 * @module tool-integrity/attributes
 *
 * Span event names and attribute keys for tool definition integrity (ADR 029, v0.18.0). Events carry the tool
 * name and hashes only: never description, schema or annotation text.
 */

export const SPAN_EVENT_INTEGRITY_CHANGED = 'mcp.tool.integrity.changed';
export const SPAN_EVENT_INTEGRITY_PIN_MISMATCH = 'mcp.tool.integrity.pin_mismatch';
export const SPAN_EVENT_INTEGRITY_ADDED = 'mcp.tool.integrity.added';
export const SPAN_EVENT_INTEGRITY_REMOVED = 'mcp.tool.integrity.removed';

export const ATTR_INTEGRITY_OLD_HASH = 'mcp.tool.integrity.old_hash';
export const ATTR_INTEGRITY_NEW_HASH = 'mcp.tool.integrity.new_hash';
export const ATTR_INTEGRITY_EXPECTED_HASH = 'mcp.tool.integrity.expected_hash';
export const ATTR_INTEGRITY_ACTUAL_HASH = 'mcp.tool.integrity.actual_hash';
export const ATTR_INTEGRITY_SEVERITY = 'mcp.tool.integrity.severity';
export const INTEGRITY_SEVERITY_HIGH = 'high';

/** Counter name; label: gen_ai.tool.name only. */
export const METRIC_INTEGRITY_VIOLATIONS = 'mcp.tool.integrity_violations';

/** @type {readonly string[]} */
export const INTEGRITY_EVENT_NAMES = Object.freeze([
  SPAN_EVENT_INTEGRITY_CHANGED,
  SPAN_EVENT_INTEGRITY_PIN_MISMATCH,
  SPAN_EVENT_INTEGRITY_ADDED,
  SPAN_EVENT_INTEGRITY_REMOVED,
]);
