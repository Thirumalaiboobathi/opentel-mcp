import type { SerializedSpan } from '../../src/types.d.ts';

/**
 * opentel-mcp core's ADR 025 span attribute (core 0.16.0+): true when a
 * tool error gave the agent nothing to act on (no content, or under ~10
 * characters of text with no image/resource). Read as a plain string key,
 * like every other core attribute this UI reads.
 */
export const ATTR_UNACTIONABLE = 'mcp.failure.unactionable';

/** A silent failure (isError: true) that core flagged as unactionable. */
export function isUnactionable(span: SerializedSpan): boolean {
  return span.errorType === 'tool_error' && span.attributes?.[ATTR_UNACTIONABLE] === true;
}

/**
 * Whether any silent failure in `spans` carries the attribute at all
 * (true OR false). Older cores never set it; then the UI shows nothing
 * rather than a misleading "0 unactionable".
 */
export function hasUnactionableSignal(spans: SerializedSpan[]): boolean {
  return spans.some((s) => s.errorType === 'tool_error' && typeof s.attributes?.[ATTR_UNACTIONABLE] === 'boolean');
}
