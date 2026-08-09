import type { FailureChannel } from '../types.d.ts';

/**
 * Determines which channel an MCP tools/call failure arrived on. Never
 * throws — see `src/fingerprint/classify/channel.js`'s docblock for the
 * full behavior, including recovery of a protocol failure McpServer has
 * disguised as `isError: true`.
 */
export function classifyFailureChannel(failure: unknown): FailureChannel;
