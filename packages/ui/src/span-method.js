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

/**
 * The resource/prompt methods opentel-mcp core can trace (opt-in `coverage`,
 * core 0.16.0+). Admitted to the buffer so the Resources & prompts panel
 * works against a live server, but never counted as tool calls.
 * web/data/operations.ts lists the same five methods.
 */
export const OPERATION_METHODS = Object.freeze([
  'resources/read',
  'resources/list',
  'resources/templates/list',
  'prompts/get',
  'prompts/list',
]);

/**
 * The only attributes kept on a resource/prompt span. Everything the panel
 * needs (method, prompt name) and nothing else: core never sends URIs or
 * prompt arguments, and this stops the dashboard storing them if some other
 * sender does.
 */
export const OPERATION_ATTRIBUTE_KEYS = Object.freeze(['mcp.method.name', 'gen_ai.prompt.name']);

/**
 * Ingestion-time check on a raw span name (before any attribute decoding):
 * `<method>` or `<method> <target>` for one of {@link OPERATION_METHODS}
 * (core names prompts/get spans `prompts/get <promptName>`).
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isOperationSpanName(name) {
  if (typeof name !== 'string') return false;
  return OPERATION_METHODS.some((method) => name === method || name.startsWith(`${method} `));
}
