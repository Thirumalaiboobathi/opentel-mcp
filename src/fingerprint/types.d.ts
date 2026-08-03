/**
 * Shared type definitions for the deep-failure-fingerprinting feature.
 *
 * This is a hand-written declaration file, not a compiled build artifact —
 * this project ships plain JS with no TypeScript build step (see
 * CONTRIBUTING.md). It exists purely so TypeScript consumers (and editors)
 * get accurate types; the `.js` files in this directory carry their own
 * JSDoc `@typedef {import('./types.d.ts').Foo}` references back into this
 * file, the same pattern `src/index.d.ts` uses for the top-level API.
 */

/** The eight failure buckets a fingerprinted error is classified into. */
export type FailureCategory =
  | 'validation'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'dependency'
  | 'serialization'
  | 'internal'
  | 'unknown';

/** Where a failure was observed. */
export type FailureOrigin =
  | 'tool_error' // MCP CallToolResult.isError === true
  | 'thrown' // JS exception during handler
  | 'transport'; // JSON-RPC / transport layer failure

/**
 * Which channel an MCP tools/call failure arrived on — see
 * `classifyFailureChannel()` (`src/fingerprint/classify/channel.js`) and
 * ADR 007 (`docs/adr/007-protocol-error-channel.md`) for the full design.
 *
 * Deliberately a SEPARATE type from {@link FailureOrigin} above, not a
 * replacement or refinement of it: `FailureOrigin` has been part of the
 * hashed `FingerprintInputs` since v0.4.0, while `FailureChannel` is
 * additive — surfaced only as the standalone `mcp.failure.channel` span
 * attribute (`ATTRIBUTE_KEYS.CHANNEL`, `src/fingerprint/attributes.d.ts`)
 * and never part of the fingerprint hash. See ADR 007's "Where the new
 * dimension lives" section for why the two are kept apart.
 *
 * - `'execution'` — a JSON-RPC-successful `CallToolResult` carrying
 *   `isError: true`: a genuine business-logic tool failure. Also recovered
 *   here (rather than misreported) when a high-level `McpServer` disguises
 *   a protocol failure as `isError: true` but the disguise doesn't match a
 *   known SDK wrapper shape — see `classifyFailureChannel()`'s docblock.
 * - `'protocol.not_found'` — a JSON-RPC `MethodNotFound` (-32601), or an
 *   `InvalidParams` (-32602) whose message indicates an unknown or
 *   disabled tool.
 * - `'protocol.input'` — an `InvalidParams` (-32602) whose message
 *   indicates the agent supplied invalid arguments.
 * - `'protocol.output'` — an `InvalidParams` (-32602) whose message
 *   indicates the TOOL's own output failed its declared output schema —
 *   a server-side bug, never the agent's fault. Excluded from Agent
 *   Thrash Detection entirely (`ThrashConfig`, `src/thrash/detector.js`).
 * - `'protocol.other'` — any other JSON-RPC error code, or an
 *   `InvalidParams` (-32602) whose message doesn't match a known shape.
 * - `'unknown'` — the failure doesn't confidently resemble either the
 *   execution or protocol shape.
 */
export type FailureChannel =
  | 'execution'
  | 'protocol.not_found'
  | 'protocol.input'
  | 'protocol.output'
  | 'protocol.other'
  | 'unknown';

/** One normalized stack frame, produced by {@link parseAndNormalizeStack}. */
export interface NormalizedStackFrame {
  /** Function name, `""` if anonymous. */
  readonly fn: string;
  /** Project-relative path, or `node_modules/<pkg>`. */
  readonly file: string;
  readonly line: number | null;
  /** `node:internal`, native code, etc. */
  readonly isNative: boolean;
  readonly isUserCode: boolean;
}

/** The normalized, low-cardinality inputs that get hashed into a fingerprint. */
export interface FingerprintInputs {
  /** e.g. `"TypeError"`, `"ZodError"`, `"MCPToolError"`. */
  readonly errorClass: string;
  readonly category: FailureCategory;
  readonly origin: FailureOrigin;
  /** Only set for `tool_error`, else `null`. */
  readonly toolName: string | null;
  /** After the full normalization pipeline. */
  readonly normalizedMessage: string;
  /** Top N normalized frames, joined. */
  readonly stackSignature: string;
}

/** Result of {@link computeFingerprint}. */
export interface FingerprintResult {
  /** 16-hex-char hash (64 bits). */
  readonly fingerprint: string;
  /** Human-readable, ~≤60 chars. */
  readonly signature: string;
  readonly category: FailureCategory;
  readonly origin: FailureOrigin;
  /** For downstream consumers (clustering etc.). */
  readonly inputs: FingerprintInputs;
}

/** Caller-supplied context for {@link computeFingerprint}. */
export interface FingerprintContext {
  readonly toolName?: string;
  readonly origin: FailureOrigin;
  /** For path normalization. @default process.cwd() */
  readonly cwd?: string;
}

/** A single, pure classification rule. */
export interface Classifier {
  readonly name: string;
  match(err: unknown, ctx: FingerprintContext): FailureCategory | null;
}

/** One step of the message-normalization pipeline (see normalize/patterns.js). */
export interface NormalizeStep {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** Options accepted by {@link computeFingerprint}. */
export interface ComputeFingerprintOptions {
  /** Prepended to {@link DEFAULT_CLASSIFIERS}. */
  readonly classifiers?: readonly Classifier[];
  /** Overrides the default of 5 top stack frames. */
  readonly stackFrames?: number;
}
