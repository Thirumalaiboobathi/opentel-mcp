import type { CostTrackingOptions } from './cost/types.d.ts';
import type { ThrashConfig, ThrashSummary } from './thrash/types.d.ts';
import type { SchemaDriftConfig } from './schema-drift/types.d.ts';
import type { ErrorRecordingConfig } from './error-recording/types.d.ts';
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

  /**
   * Controls what a THROWN exception (not a tool-level `isError: true` result, which never carries a JS
   * `Error` and is unaffected by this option) puts on the `tools/call`/`tools/list` span (ADR 019,
   * `docs/adr/019-raw-content-on-spans.md` Part 1, v0.13.0).
   *
   * Defaults to `{ mode: 'full' }` — byte-identical to every release before v0.13.0:
   * `span.recordException(err)` plus `span.setStatus({ message: err.message })`, both uncapped.
   * `'normalized'` reuses `normalizeException()` (`src/fingerprint/normalize/exception.js`) — the same
   * coercion + `normalizeMessage()`/`parseAndNormalizeStack()` step `computeFingerprint()`
   * (`src/fingerprint/compose.js`) uses for `mcp.failure.*` on the same `err` — for the exception message
   * and stacktrace (cwd-stripped, `node_modules` version-collapsed): one computation feeds both the span
   * and the fingerprint, so they can't independently drift apart. `'none'` sets only the `ERROR` status
   * code, no message, no `exception` event.
   *
   * Also settable via the `OTEL_MCP_ERROR_RECORDING_MODE` environment variable (lower precedence than this
   * option); an unrecognized value from either source falls back to `'full'` silently, never a throw. See
   * {@link ErrorRecordingConfig} (`src/error-recording/types.d.ts`).
   */
  errorRecording?: Partial<ErrorRecordingConfig>;

  /**
   * Host-supplied stable identifier for one logical service (ADR 012,
   * `docs/adr/012-tracker-lifecycle-and-shared-state.md`, Option C). When provided, the four in-memory
   * trackers this library keeps per instrumented server — the budget tracker, Agent Thrash Detection, the
   * `ToolOutcome` counter, and schema drift detection — are looked up from an internal, bounded,
   * TTL-evicting registry keyed by this string instead of being constructed fresh on every
   * {@link instrumentMcpServer} call. Repeated calls that pass the SAME `instanceKey` therefore share
   * accumulated tracker state — fixing the gap ADR 012 documents under a "fresh Server per request"
   * deployment shape, where every tracker previously reset to empty before ever accumulating anything.
   *
   * Omit (the default, `undefined`) for behavior byte-identical to pre-v0.9.0: trackers are constructed
   * fresh on every call exactly as before, and the registry is never looked up or written to.
   *
   * Also settable via the `OTEL_MCP_INSTANCE_KEY` environment variable (lower precedence than this option;
   * an empty or whitespace-only value from either source is treated as omitted). Distinct `instanceKey`
   * values never share state with each other or with calls that omit the option.
   *
   * The registry itself (`src/registry/instance-registry.js`) stays fully internal — there is no public
   * type for it, and none is needed: nothing in this package's public API accepts or returns a registry
   * instance, so a consumer only ever interacts with this feature through this one string field.
   *
   * Passing an unstable value (e.g. a per-request id) silently defeats the whole point while looking
   * configured — see ADR 012's Option C "Against" for why this is a real footgun, not a hypothetical one.
   * Registry bounds (cap, TTL) and known limitations (single-process only — no cross-instance/serverless
   * sharing) are documented in ADR 012, not repeated here.
   */
  instanceKey?: string;
}

/**
 * A low-level Server-like object, matched structurally the same way
 * {@link instrumentMcpServer} itself matches it at runtime (see ADR 001,
 * ADR 015): an object exposing `setRequestHandler`.
 *
 * **Neither supported SDK's real `Server` class is imported anywhere in
 * this file — deliberately, for both, not just v2.** Earlier revisions of
 * this type existed only for v2 (whose `@modelcontextprotocol/server` was
 * always an optional peer dependency, so its class could never be
 * imported here without breaking type-checking for v1-only consumers —
 * confirmed empirically: an `import('@modelcontextprotocol/server').Server`
 * reference anywhere in this file's public surface fails `Cannot find
 * module '@modelcontextprotocol/server'` even for code that never touches
 * v2 at all, the moment the package isn't resolvable; a plain top-level
 * `import type` has the exact same failure mode). ADR 015 Phase 2 made
 * `@modelcontextprotocol/sdk` (v1) an OPTIONAL peer dependency too — and
 * the identical failure mode applies symmetrically: a top-level `import
 * type { Server } from '@modelcontextprotocol/sdk/server/index.js'`
 * breaks type-checking for a v2-only (or SDK-less) consumer the exact
 * same way, confirmed the same way — caught by `npm run verify:tarball`
 * against a real packed tarball installed into a clean external project
 * with neither SDK present, not predicted in advance. **Both SDKs'
 * classes are therefore handled identically now: never imported, only
 * described structurally.** A purely structural type has no such
 * dependency on either — it never needs to resolve either package to
 * describe either SDK's shape.
 *
 * **Satisfying this type is necessary, but not sufficient, for runtime
 * acceptance** — see {@link DuckTypedMcpServer}'s docblock for the full
 * accounting of why, which applies identically here: only a real
 * `instanceof` match against an actually-installed SDK's `Server` class is
 * accepted at runtime (`detectServerKind()`, `src/instrument.js`); a value
 * that merely has a `setRequestHandler` method but isn't really a v1 or v2
 * `Server` instance will type-check here and still throw
 * `UNSUPPORTED_INPUT_ERROR` at runtime.
 */
export type DuckTypedServer = {
  setRequestHandler: (...args: any[]) => any;
};

/**
 * A high-level McpServer-like object, matched structurally the same way
 * {@link instrumentMcpServer} itself matches it at runtime (see ADR 001):
 * an object exposing a `.server` that looks like a low-level `Server` (has
 * `setRequestHandler`), plus a `.tool` or `.registerTool` method.
 *
 * **Neither SDK's real `McpServer` class is imported here** — see
 * {@link DuckTypedServer}'s docblock for the full history of why (v2's
 * class never could be, without breaking v1-only consumers; v1's class
 * stopped being importable here too once ADR 015 Phase 2 made it an
 * optional peer dependency as well, confirmed by `npm run verify:tarball`
 * failing against a real packed tarball with neither SDK installed). This
 * type is the *only* thing describing an McpServer's shape to
 * TypeScript now, for either SDK, not a fallback alongside a nominal
 * import — a real v1 or v2 `McpServer` instance is accepted purely
 * because it structurally satisfies this shape.
 *
 * One consequence worth stating plainly: **satisfying this type is
 * necessary, but not sufficient, for runtime acceptance.** Before ADR 015
 * Phase 1, an object satisfying this shape reliably worked at runtime too
 * (the runtime's own detection was equally loose). That stopped being true
 * once `detectServerKind()` was hardened to additionally require `.server
 * instanceof <Server>` for a REAL, resolved SDK class
 * (`docs/known-gaps.md` entry 7) — closing a confirmed silent-no-op bug,
 * but as a direct, deliberate consequence, an object that merely has the
 * right shape (e.g. a dual-package-hazard `.server` from a *different*
 * resolved copy of the SDK than this process itself resolves, or a
 * hand-rolled mock not actually built on either SDK) is now REJECTED at
 * runtime (`UNWRAPPABLE_MCPSERVER_ERROR`), not silently accepted. Phase 1
 * considered and explicitly rejected adding an escape hatch for this case
 * — see ADR 015's Update section for the full argument. This type mirrors
 * the duck-typing the runtime's *detection* step performs; it cannot also
 * encode the *nominal* `instanceof` check runtime acceptance ultimately
 * requires, since that would mean importing a class this file cannot
 * safely import for either SDK.
 */
export type DuckTypedMcpServer = {
  server: { setRequestHandler: (...args: any[]) => any };
  tool?: (...args: any[]) => any;
  registerTool?: (...args: any[]) => any;
};

/**
 * Instruments an MCP server so every tool call emits an OpenTelemetry span.
 *
 * Accepts either a low-level `Server` or a high-level `McpServer`, from
 * either of two SDKs (ADR 015, `docs/adr/015-mcp-v2-support.md`):
 * `@modelcontextprotocol/sdk` (v1, protocol revisions through 2025-11-25)
 * or `@modelcontextprotocol/server` (v2, protocol revision 2026-07-28).
 * Both are OPTIONAL peer dependencies — install whichever one(s) you
 * actually use; neither is required just to depend on this package. Must
 * be called before any `tools/call` handler is registered — i.e. before
 * any `server.setRequestHandler(CallToolRequestSchema, ...)` (v1
 * low-level) / `server.setRequestHandler('tools/call', ...)` (v2
 * low-level) or `.tool()`/`.registerTool()` (either SDK's `McpServer`)
 * calls. Idempotent: calling this more than once — on the same object, or
 * on the outer `McpServer` and its inner `Server` interchangeably — is a
 * no-op after the first call.
 *
 * **Throws synchronously, at call time**, for a `server` this cannot
 * confidently wrap, rather than silently instrumenting nothing — this is
 * setup-time validation, not the runtime never-throw discipline the
 * actual tool-call path follows. Two of the three cases this can throw for
 * are new as of ADR 015 Phase 1/2, closing a confirmed silent-no-op gap: a
 * `server` whose shape doesn't resemble either SDK at all, and a
 * `McpServer`-shaped object whose `.server` isn't a recognized `Server`
 * instance from either installed SDK (most often a v2 object when this
 * package's v2 support didn't exist yet, or a duplicate/mismatched SDK
 * install) — see `docs/known-gaps.md` entry 7 and the module-level
 * docblock in `src/instrument.js` for the full detection contract. The
 * third, pre-existing case is the instrument-first ordering violation
 * described below.
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
 * **v2 (`@modelcontextprotocol/server`) support is at parity with v1's**
 * (ADR 015 Phases 1–5, `v0.10.0`): spans, standard attributes, failure
 * fingerprinting, `mcp.failure.channel`/`validation_paths` classification,
 * Agent Thrash Detection's fallback session id (registry-backed via
 * `instanceKey`, same as v1), and `isSingleConnectionTransport()`'s
 * transport-detection heuristic (no longer misclassifies v2's
 * `PerRequestHTTPServerTransport` — `docs/known-gaps.md` entries 6 and 8
 * both closed in `v0.10.0`) all work the same as v1. One narrower gap
 * remains, tracked in `docs/known-gaps.md` entry 6's own update: under
 * v2's default per-request `createMcpHandler` deployment shape,
 * `thrashSessionState` (whether a server has ever proven itself
 * session-aware) is not itself registry-backed, and — structurally, not a
 * bug — MCP spec 2026-07-28 removes protocol-level sessions entirely, so
 * no configuration of this library can produce a *real* session id for a
 * spec-2026-07-28-native deployment in the first place.
 *
 * **Trace context propagation (v0.11.0, ADR 017,
 * `docs/adr/017-trace-context-propagation.md`)** works identically under
 * both SDKs: `request.params._meta` is the same shape in both, so a
 * `tools/call` request carrying a valid W3C `traceparent` in `_meta`
 * joins that tool-call span into the calling agent's own trace, under v1
 * or v2, with no configuration. Server-side extraction only this release
 * — see the ADR's "Forward-compat" section for the deferred client-side
 * shim.
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
export function instrumentMcpServer<T extends DuckTypedServer | DuckTypedMcpServer>(
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
  ChatModelPricing,
  EmbeddingModelPricing,
  PricingTable,
  UsageExtractor,
  TokenUsage,
  CostTrackingOptions,
} from './cost/types.d.ts';

export { DEFAULT_PRICING, DEFAULT_PRICING_LAST_VERIFIED, isDefaultPricingStale } from './cost/pricing.js';
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

// --- Exception-recording mode (src/error-recording/) ---
//
// Re-exported here so TypeScript consumers get this type from the package
// root instead of reaching into src/error-recording/* directly. See
// src/error-recording/types.d.ts for the full shape documentation and ADR
// 019 (docs/adr/019-raw-content-on-spans.md). Same posture as Agent
// Thrash Detection / schema drift above — no runtime value re-exported:
// resolveErrorRecordingConfig() is internal to src/config.js's wiring,
// not part of the public API.

export type { ErrorRecordingConfig } from './error-recording/types.d.ts';

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
