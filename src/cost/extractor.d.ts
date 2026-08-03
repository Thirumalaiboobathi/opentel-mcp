import type { UsageExtractor } from './types.d.ts';

/**
 * Default {@link UsageExtractor}. Recognizes Anthropic/OpenAI/Bedrock usage
 * field conventions, JSON-in-text content, and the MCP `_meta.usage`
 * extension point. Never throws — returns `null` for any unrecognized shape.
 */
export const defaultExtractor: UsageExtractor;
