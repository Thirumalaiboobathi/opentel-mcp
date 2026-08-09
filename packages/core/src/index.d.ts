import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CostTrackingOptions } from './cost/types.d.ts';
import type { ThrashConfig, ThrashSummary } from './thrash/types.d.ts';
import type { SchemaDriftConfig } from './schema-drift/types.d.ts';
import type { ObservationState } from './observation/types.d.ts';

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

  /**
   * Controls the `mcp.tool.tokens.*` / `mcp.tool.model` / `mcp.tool.cost.*` span attributes, the
   * `mcp.tool.tokens.total` / `mcp.tool.cost.total` metrics, and the optional per-session/per-tool budget
   * guardrail. Any fields you omit from a partial object fall back to their defaults individually —
   * `{ enabled: false }` alone works. See {@link CostTrackingOptions} (`src/cost/types.d.ts`).
   */
  costTracking?: CostTrackingOptions;

  /**
   * Set to `false` to disable deep-failure fingerprinting. When enabled (the default), every thrown error
   * and tool-level failure (`isError: true`) is run through `computeFingerprint()`
   * (`src/fingerprint/compose.js`), adding `mcp.failure.*` span attributes and an `mcp.failure.category`
   * attribute on the `mcp.tool.errors` / `mcp.tool.silent_failures` / `mcp.tool.duration` metrics.
   * `computeFingerprint()` never throws, so this only trades a small amount of per-failure CPU for
   * fingerprinting.
   *
   * `thrashDetection` (below) depends on this: it keys off the same `mcp.failure.fingerprint`
   * fingerprinting computes, so with `fingerprinting: false` thrash detection silently never fires,
   * regardless of `thrashDetection`'s own settings.
   *
   * @default true
   */
  fingerprinting?: boolean;

  /**
   * Controls Agent Thrash Detection (v0.6.0): detecting when a tool is retried repeatedly with the same
   * failure fingerprint, and attributing the wasted tokens/cost to that loop (the 5 `mcp.tool.loop.*`
   * metrics plus one `mcp.loop.detected` span event — see the README's "Agent Thrash Detection" section).
   * Any fields you omit from a partial object fall back to their defaults individually, same as
   * `costTracking` above. Requires `fingerprinting` to also be enabled (the default) — see that option's
   * doc. See {@link ThrashConfig} (`src/thrash/types.d.ts`) for the full field list and defaults,
   * including `assumeSingleSession`, which you should read carefully before enabling on any transport
   * that might serve more than one client: getting it wrong merges unrelated clients' failures into
   * false-positive loops.
   */
  thrashDetection?: Partial<ThrashConfig>;

  /**
   * Controls tool schema drift detection (ADR 010, v0.8.0): capturing each tool's `inputSchema` on every
   * `tools/list` call and flagging when it differs from what was last observed for that tool (a new
   * `tools/list` span plus an `mcp.tool.schema_drift.detected` metric and span event — see
   * `docs/adr/010-schema-drift.md`). Any fields you omit from a partial object fall back to their
   * defaults individually, same as `costTracking`/`thrashDetection` above. Independent of
   * `fingerprinting`/`thrashDetection` — schema drift has its own, unconditional, OTel-independent
   * bookkeeping. `{ enabled: false }` (or omitting this option) is a true no-op: `tools/list` is not
   * wrapped at all, unlike `thrashDetection`/`costTracking`, whose disabled state still wraps `tools/call`
   * for other reasons and merely skips inner logic. See {@link SchemaDriftConfig}
   * (`src/schema-drift/types.d.ts`) for the full field list and defaults.
   */
  schemaDrift?: Partial<SchemaDriftConfig>;
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
 * **v0.8.0 behavior change:** since `schemaDrift.enabled` defaults to
 * `true`, this same before-registration requirement now ALSO applies to
 * `tools/list` — i.e. before any `server.setRequestHandler(ListToolsRequestSchema, ...)`
 * call — for low-level `Server` users specifically. `McpServer` users are
 * unaffected (it registers both together, only once `.tool()`/`.registerTool()`
 * is first called). If your low-level `Server` registers a `tools/list`
 * handler before calling {@link instrumentMcpServer}, upgrading will make
 * this throw where it previously didn't — either reorder that
 * registration, or pass `schemaDrift: { enabled: false }` to opt out. See
 * the README's "Known limitations" and the CHANGELOG's v0.8.0 entry.
 *
 * @param server - The server instance to instrument.
 * @param options - Instrumentation options.
 * @returns The same object that was passed in, for chaining. When
 *   `options.setupNodeSdk` is `true`, the returned object also gets a
 *   `shutdown()` method that flushes and shuts down the `NodeTracerProvider`
 *   created for it — call it during your process's own shutdown sequence to
 *   avoid losing buffered spans. `shutdown` is typed as optional because it
 *   is only attached at runtime when `setupNodeSdk` is `true`; check for its
 *   presence before calling. The returned object also gets a
 *   `getThrashSummary()` method (v0.6.0) returning a point-in-time,
 *   in-process {@link ThrashSummary} — no OTel involved, nothing sent
 *   anywhere; see the README's "Agent Thrash Detection" section. Unlike
 *   `shutdown`, it's attached unconditionally (not gated behind
 *   `setupNodeSdk`) — still typed as optional because it, like `shutdown`,
 *   is never attached when `options.enabled` is `false` (nothing is
 *   instrumented at all in that case).
 *
 *   The returned object also gets a `getObservationState()` method (ADR
 *   008 "Update", v0.8.0) returning the two-axis {@link ObservationState}:
 *   `toolOutcome` (cumulative tool-call outcome counts, from a counter
 *   that increments on every call regardless of `fingerprinting`,
 *   `thrashDetection`, or `enableMetrics`) and `observationIntegrity`
 *   (`'DEGRADED' | 'UNKNOWN'` — note there is no `'HEALTHY'` value; see
 *   the README's "Two-axis observation contract" section for why).
 *   `observationIntegrity` is recomputed on every call to
 *   `getObservationState()`, never cached from instrument time — a host
 *   may register a `TracerProvider` asynchronously after
 *   {@link instrumentMcpServer} already ran. Attached unconditionally, same
 *   as `getThrashSummary`; also never attached when `options.enabled` is
 *   `false`.
 */
export function instrumentMcpServer<T extends Server | McpServer | DuckTypedMcpServer>(
  server: T,
  options?: InstrumentOptions,
): T & {
  shutdown?: () => Promise<void>;
  getThrashSummary?: (options?: { topOffendersLimit?: number }) => ThrashSummary;
  getObservationState?: () => ObservationState;
};

// --- Deep-failure fingerprinting (src/fingerprint/) ---
//
// Re-exported here so TypeScript consumers get these types/values from the
// package root instead of reaching into src/fingerprint/* directly. See
// src/fingerprint/types.d.ts for the full shape documentation.

export type {
  FailureCategory,
  FailureOrigin,
  FailureChannel,
  FingerprintResult,
  FingerprintInputs,
  FingerprintContext,
  Classifier,
  ComputeFingerprintOptions,
} from './fingerprint/types.d.ts';

export { computeFingerprint } from './fingerprint/compose.js';
export { toSpanAttributes, ATTRIBUTE_KEYS, METRIC_SAFE_ATTRIBUTES } from './fingerprint/attributes.js';
export { DEFAULT_CLASSIFIERS } from './fingerprint/classify/index.js';

// --- Cost & token attribution (src/cost/) ---
//
// Re-exported here so TypeScript consumers get these types/values from the
// package root instead of reaching into src/cost/* directly. See
// src/cost/types.d.ts for the full shape documentation.

export type {
  ModelPricing,
  PricingTable,
  UsageExtractor,
  TokenUsage,
  CostTrackingOptions,
} from './cost/types.d.ts';

export { DEFAULT_PRICING } from './cost/pricing.js';
export { defaultExtractor } from './cost/extractor.js';
export { calculateCost } from './cost/calculator.js';

// --- Agent Thrash Detection (src/thrash/) ---
//
// Re-exported here so TypeScript consumers get these types from the
// package root instead of reaching into src/thrash/* directly. See
// src/thrash/types.d.ts for the full shape documentation. Unlike
// src/cost/ and src/fingerprint/ above, no runtime values are re-exported
// here yet — ThrashDetector and createThrashEmitter are internal to
// instrument.js's wiring, not part of the public API.

export type { ThrashConfig, ThrashDetectedEvent, ThrashSummary, ThrashOffender } from './thrash/types.d.ts';

// --- Tool schema drift detection (src/schema-drift/) ---
//
// Re-exported here so TypeScript consumers get these types from the
// package root instead of reaching into src/schema-drift/* directly. See
// src/schema-drift/types.d.ts for the full shape documentation and ADR 010
// (docs/adr/010-schema-drift.md). Same posture as Agent Thrash Detection
// above — no runtime values re-exported: SchemaDriftDetector and
// createSchemaDriftEmitter are internal to instrument.js's wiring, not
// part of the public API.

export type { SchemaDriftConfig, SchemaDriftKind, SchemaDriftEvent } from './schema-drift/types.d.ts';

// --- Two-axis observation contract (src/observation/) ---
//
// Re-exported here so TypeScript consumers get these types from the
// package root instead of reaching into src/observation/* directly. See
// src/observation/types.d.ts for the full shape documentation and ADR 008
// (docs/adr/008-observation-liveness.md, "Update (2026-08-05): The
// two-axis reframe"). Same posture as Agent Thrash Detection and schema
// drift above — no runtime values re-exported: ToolOutcomeCounter and
// detectObservationIntegrity() are internal to instrument.js's wiring,
// not part of the public API.

export type { ToolOutcome, ToolOutcomeCounts, ObservationIntegrity, ObservationState } from './observation/types.d.ts';
