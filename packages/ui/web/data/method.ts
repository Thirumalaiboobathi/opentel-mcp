import type { SerializedSpan } from '../../src/types.d.ts';

/**
 * Browser-side mirror of src/span-method.js (see its docblock): which MCP
 * method a span represents, from `mcp.method.name`, falling back to the
 * span name's `tools/call` prefix. test/span-method.test.js keeps the two
 * implementations in agreement.
 */
export const TOOLS_CALL_METHOD = 'tools/call';

export function spanMethod(span: SerializedSpan): string | undefined {
  const method = span.attributes?.['mcp.method.name'];
  if (typeof method === 'string') return method;
  const name = typeof span.name === 'string' ? span.name : '';
  return name === TOOLS_CALL_METHOD || name.startsWith(`${TOOLS_CALL_METHOD} `) ? TOOLS_CALL_METHOD : undefined;
}

export function isToolCallSpan(span: SerializedSpan): boolean {
  return spanMethod(span) === TOOLS_CALL_METHOD;
}
