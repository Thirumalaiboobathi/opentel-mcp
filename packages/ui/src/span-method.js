/**
 * @module span-method
 *
 * Which MCP method a buffered span represents. opentel-mcp core sets
 * `mcp.method.name` on every span it creates (tools/call, tools/list, and,
 * with core 0.16.0's opt-in coverage, resources/* and prompts/*). The
 * matrix, hero stat, silent-failure feed, health grades and /api/summary
 * are all about TOOL CALLS, so they count only tools/call spans: a
 * tools/list or resources/read span is not a "successful tool call".
 *
 * Spans with no `mcp.method.name` (very old cores, hand-built fixtures)
 * fall back to the span name's `tools/call` prefix (ADR 004 naming).
 *
 * web/data/method.ts mirrors this for the browser bundle; a test keeps
 * the two in agreement.
 */

/** @typedef {import('./types.d.ts').SerializedSpan} SerializedSpan */

export const TOOLS_CALL_METHOD = 'tools/call';

/**
 * @param {SerializedSpan} span
 * @returns {string | undefined}
 */
export function spanMethod(span) {
  const method = span?.attributes?.['mcp.method.name'];
  if (typeof method === 'string') return method;
  const name = typeof span?.name === 'string' ? span.name : '';
  return name === TOOLS_CALL_METHOD || name.startsWith(`${TOOLS_CALL_METHOD} `) ? TOOLS_CALL_METHOD : undefined;
}

/**
 * @param {SerializedSpan} span
 * @returns {boolean}
 */
export function isToolCallSpan(span) {
  return spanMethod(span) === TOOLS_CALL_METHOD;
}
