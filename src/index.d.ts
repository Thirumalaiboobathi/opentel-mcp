import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Options for {@link instrumentMcpServer}.
 */
export interface InstrumentOptions {
  /**
   * Names the resource of the `NodeTracerProvider` this library creates.
   *
   * Required (and must be a non-empty string) when `setupNodeSdk` is `true` —
   * omitting it in that mode throws at runtime. Has no effect when
   * `setupNodeSdk` is `false` or omitted; in that mode, resource attributes
   * (including `service.name`) come from whatever `TracerProvider` the host
   * application has already registered, and passing `serviceName` anyway is
   * harmless but logs a one-time `diag.warn`.
   */
  serviceName?: string;

  /**
   * OTLP/HTTP traces endpoint (e.g. `'http://localhost:4318/v1/traces'`).
   *
   * Only takes effect when `setupNodeSdk` is `true`.
   */
  exporterUrl?: string;

  /**
   * Set to `false` to disable instrumentation entirely; {@link instrumentMcpServer}
   * becomes a no-op.
   *
   * @default true
   */
  enabled?: boolean;

  /**
   * Set to `false` to disable the `mcp.tool.*` metrics. Tracing is
   * unaffected.
   *
   * Metrics are already a zero-overhead no-op when no `MeterProvider` is
   * registered (the default `@opentelemetry/api` behavior) — this flag is
   * for opting out of metrics even when a `MeterProvider` **is**
   * registered, not a substitute for that default.
   *
   * @default true
   */
  enableMetrics?: boolean;

  /**
   * When `true`, {@link instrumentMcpServer} creates and registers its own
   * `NodeTracerProvider` (always exporting to stderr; additionally to
   * `exporterUrl` via OTLP/HTTP if set).
   *
   * When `false` (the default), spans are emitted via whatever OpenTelemetry
   * `TracerProvider` the host application has already registered globally —
   * or dropped silently if none has been registered. This default keeps
   * {@link instrumentMcpServer} from ever overriding a host application's own
   * OpenTelemetry setup.
   *
   * @default false
   */
  setupNodeSdk?: boolean;
}

/**
 * A high-level McpServer-like object, matched structurally the same way
 * {@link instrumentMcpServer} itself matches it at runtime (see ADR 001):
 * an object exposing a `.server` that looks like a low-level `Server` (has
 * `setRequestHandler`), plus a `.tool` or `.registerTool` method.
 *
 * This structural fallback exists because the imported `McpServer` class
 * has private fields, which makes TypeScript treat assignability to it as
 * effectively nominal — an `McpServer` instance created by a *different*
 * resolved copy of `@modelcontextprotocol/sdk` (e.g. a hoisting mismatch in
 * a monorepo) would otherwise fail the type check even though it works
 * fine at runtime, since the runtime never uses `instanceof McpServer` in
 * the first place. This type mirrors the duck-typing the runtime already
 * performs instead of relying on class identity.
 */
export type DuckTypedMcpServer = {
  server: { setRequestHandler: (...args: any[]) => any };
  tool?: (...args: any[]) => any;
  registerTool?: (...args: any[]) => any;
};

/**
 * Instruments an MCP server so every tool call emits an OpenTelemetry span.
 *
 * Accepts either a low-level `Server` (from
 * `@modelcontextprotocol/sdk/server/index.js`) or a high-level `McpServer`
 * (from `@modelcontextprotocol/sdk/server/mcp.js`). Must be called before any
 * `tools/call` handler is registered — i.e. before any
 * `server.setRequestHandler(CallToolRequestSchema, ...)` (low-level) or
 * `.tool()`/`.registerTool()` (McpServer) calls. Idempotent: calling this
 * more than once — on the same object, or on the outer `McpServer` and its
 * inner `Server` interchangeably — is a no-op after the first call.
 *
 * @param server - The server instance to instrument.
 * @param options - Instrumentation options.
 * @returns The same object that was passed in, for chaining. When
 *   `options.setupNodeSdk` is `true`, the returned object also gets a
 *   `shutdown()` method that flushes and shuts down the `NodeTracerProvider`
 *   created for it — call it during your process's own shutdown sequence to
 *   avoid losing buffered spans. `shutdown` is typed as optional because it
 *   is only attached at runtime when `setupNodeSdk` is `true`; check for its
 *   presence before calling.
 */
export function instrumentMcpServer<T extends Server | McpServer | DuckTypedMcpServer>(
  server: T,
  options?: InstrumentOptions,
): T & { shutdown?: () => Promise<void> };

// --- Deep-failure fingerprinting (src/fingerprint/) ---
//
// Re-exported here so TypeScript consumers get these types/values from the
// package root instead of reaching into src/fingerprint/* directly. See
// src/fingerprint/types.d.ts for the full shape documentation.

export type {
  FailureCategory,
  FailureOrigin,
  FingerprintResult,
  FingerprintInputs,
} from './fingerprint/types.d.ts';

export { computeFingerprint } from './fingerprint/compose.js';
export { toSpanAttributes, ATTRIBUTE_KEYS, METRIC_SAFE_ATTRIBUTES } from './fingerprint/attributes.js';
export { DEFAULT_CLASSIFIERS } from './fingerprint/classify/index.js';
