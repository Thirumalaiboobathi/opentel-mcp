/**
 * @module instrument
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { trace, diag, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { getV1Sdk, getV2Sdk } from './sdk/detect.js';
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { resolveOptions } from './config.js';
import { StderrSpanExporter } from './exporters/stderr.js';
import { setupMeter } from './metrics.js';
import { computeFingerprint, MAX_ERROR_CLASS_LENGTH } from './fingerprint/compose.js';
import { toSpanAttributes, ATTRIBUTE_KEYS } from './fingerprint/attributes.js';
import { classifyFailureChannel } from './fingerprint/classify/channel.js';
import { extractValidationPaths } from './fingerprint/classify/validation-paths.js';
import { normalizeException } from './fingerprint/normalize/exception.js';
import { calculateCost, normalizeModelName, isValidModelId, describeInvalidModelId } from './cost/calculator.js';
import { DEFAULT_PRICING_LAST_VERIFIED } from './cost/pricing.js';
import { createBudgetTracker } from './cost/budget.js';
import { extractTraceContext } from './tracecontext/extract.js';
import { ThrashDetector } from './thrash/detector.js';
import { createThrashEmitter } from './thrash/emitter.js';
import { SchemaDriftDetector } from './schema-drift/detector.js';
import { createSchemaDriftEmitter } from './schema-drift/emitter.js';
import { ToolOutcomeCounter } from './observation/tool-outcome-counter.js';
import { detectObservationIntegrity } from './observation/integrity.js';
import { InstanceRegistry } from './registry/instance-registry.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_MCP_TOOL_ARGUMENT_COUNT,
  ATTR_ERROR_TYPE,
  ATTR_MCP_TOOL_TOKENS_INPUT,
  ATTR_MCP_TOOL_TOKENS_OUTPUT,
  ATTR_MCP_TOOL_TOKENS_TOTAL,
  ATTR_MCP_TOOL_MODEL,
  ATTR_MCP_TOOL_COST_USD,
  ATTR_MCP_TOOL_COST_CURRENCY,
  ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED,
  ATTR_MCP_TOOL_COST_BUDGET_SCOPE,
  ATTR_MCP_TOOL_PRICING_STATUS,
  ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED,
  MCP_TOOL_PRICING_STATUS_KNOWN,
  MCP_TOOL_PRICING_STATUS_UNKNOWN,
  MCP_TOOL_PRICING_STATUS_USER_OVERRIDE,
  MCP_TOOL_COST_CURRENCY_USD,
  ERROR_TYPE_TOOL_ERROR,
  GEN_AI_OPERATION_NAME_EXECUTE_TOOL,
  MCP_METHOD_NAME_TOOLS_CALL,
  MCP_METHOD_NAME_TOOLS_LIST,
  MCP_TOOL_OUTCOME_SUCCESS,
  MCP_TOOL_OUTCOME_ERROR,
  MCP_TOOL_OUTCOME_SILENT_FAILURE,
} from './attributes.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');

// Protocol-level JSON-RPC method name. Deliberately hardcoded rather than
// derived from CallToolRequestSchema's zod internals — see ADR 001. Reused
// as the mcp.method.name attribute value and span-name prefix (ADR 004).
const TOOLS_CALL_METHOD = MCP_METHOD_NAME_TOOLS_CALL;

// Same reasoning as TOOLS_CALL_METHOD above, for the tools/list branch ADR
// 010 (docs/adr/010-schema-drift.md) added alongside it — reused as both
// the mcp.method.name attribute value and the tools/list span's name.
const TOOLS_LIST_METHOD = MCP_METHOD_NAME_TOOLS_LIST;

// ADR 010, Q4: schema drift state is per-server-instance, never
// per-session — unlike thrashConnectionFallbackSessionId (randomUUID()),
// this value never needs process-wide uniqueness: SchemaDriftDetector's
// store is already fully isolated per instrumented server instance (one
// detector per instrumentMcpServer() call, exactly like thrashDetector),
// and "scope" is never emitted on any span/metric (see
// schema-drift/emitter.js) — it exists purely to key this one detector's
// internal Map, so any fixed, consistent value works. A literal constant
// is simplest and avoids an unnecessary randomUUID() call per server.
const SCHEMA_DRIFT_SCOPE = 'server';

// Symbol.for(): must be visible across duplicate installs of this package
// (e.g. monorepos with dedup issues), not just within one module instance.
const kInstrumented = Symbol.for('opentel-mcp/instrumented');

// ADR 012, Phase 2 (docs/adr/012-tracker-lifecycle-and-shared-state.md,
// Option C): one registry for the whole process, constructed once here at
// module load. This is the only architecture under which repeated
// instrumentMcpServer() calls that share an instanceKey can actually share
// tracker state — a per-call local variable couldn't be looked up again by
// a later, unrelated call, and there is no other persistent scope this
// library could reach for that doesn't require the host to hold and pass a
// reference itself (ADR 012's Option B, rejected). Confirmed with the ADR's
// author before implementing: the original Decision text never states this
// explicitly (only the REJECTED Option A is described as "module-level"),
// so this is a deliberate implementation choice filling a gap the ADR left
// open, not a restatement of something it already said.
//
// Constructing this costs one empty BoundedTtlMap — negligible, and
// unconditional regardless of whether any call ever supplies instanceKey,
// since the registry must already exist the first time one does. This is
// NOT the same thing as the "no allocation when instanceKey is unset"
// guarantee instrumentMcpServer() makes below — that guarantee is about
// PER-CALL allocation of registry entries/trackers, which getOrCreateTracker()
// (below) skips entirely when instanceKey is undefined; a one-time,
// process-lifetime empty Map is unrelated to and unaffected by that.
const instanceRegistry = new InstanceRegistry();

// Test-only: lets tests get a clean registry regardless of what earlier
// tests in the same file already populated it with (the singleton above is
// shared for the lifetime of this module instance — see its own comment).
// Not part of the public API.
export function __resetInstanceRegistryForTests() {
  instanceRegistry.clear();
}

// Test-only: exposes the singleton's current size so tests can assert
// "instanceKey omitted -> the registry is never touched" directly, rather
// than only inferring it from tracker identity. Not part of the public API.
export function __getInstanceRegistrySizeForTests() {
  return instanceRegistry.size;
}

/**
 * Looks up (or constructs) one of the four ADR-012 trackers. When
 * `instanceKey` is `undefined`, calls `factory()` directly and never
 * touches `registry` at all — this is what keeps the default (instanceKey
 * omitted) path byte-identical to pre-v0.9.0 behavior: no registry lookup,
 * no registry write, no allocation beyond the tracker itself, exactly as
 * before this phase existed.
 *
 * The key is namespaced per tracker type (`${instanceKey}:${trackerSuffix}`)
 * rather than using the raw `instanceKey` directly for all four. ADR 012's
 * Decision text never addresses this: it describes "instrument.js looks up
 * or creates each of the four trackers in an internal, bounded registry
 * keyed by that string" without saying whether that means one shared entry
 * per key (bundling all four trackers into one cached value) or one entry
 * per (key, tracker type) pair. Left as a genuine, unaddressed gap. Chosen
 * here: per-tracker-type namespacing, on ONE shared InstanceRegistry
 * instance — the four tracker types can never collide on the same registry
 * entry (a `ThrashDetector` can never be handed back where a budget tracker
 * was expected, or vice versa), at the cost of all four trackers, across
 * every instanceKey a process uses, sharing one bounded cap/TTL rather than
 * each tracker type getting its own independent bound. Flagged explicitly
 * as a choice, not a rediscovery of something the ADR already decided —
 * four separate InstanceRegistry instances (one per tracker type) would
 * have achieved the same non-collision guarantee structurally, without
 * relying on string-namespace hygiene, and remains a reasonable alternative
 * if independent per-tracker-type bounds turn out to matter in practice.
 *
 * @template V
 * @param {string | undefined} instanceKey
 * @param {string} trackerSuffix - e.g. 'thrash', 'budget', 'tool-outcome', 'schema-drift'.
 * @param {() => V} factory
 * @returns {V}
 */
function getOrCreateTracker(instanceKey, trackerSuffix, factory) {
  if (instanceKey === undefined) return factory();
  return instanceRegistry.getOrCreate(`${instanceKey}:${trackerSuffix}`, factory);
}

const UNSUPPORTED_INPUT_ERROR =
  'opentel-mcp: instrumentMcpServer() expects either a low-level Server ' +
  'instance or a high-level McpServer instance, from a supported MCP SDK: ' +
  '@modelcontextprotocol/sdk (v1, protocol revisions through 2025-11-25) ' +
  'or @modelcontextprotocol/server (v2, protocol revision 2026-07-28). ' +
  'Neither SDK appears to be installed and resolvable from this package, ' +
  'or the object passed does not come from either one — see ' +
  'docs/adr/015-mcp-v2-support.md.';

// ADR 015 Phase 2: the McpServer branch's duck-type check alone is not
// sufficient to guarantee the object is actually wrappable — see
// detectServerKind()'s docblock for the confirmed failure this closes (a
// v2 McpServer duck-types identically to a v1 one, but before Phase 2,
// this package's setRequestHandler patch never matched its dispatch, so
// wrapping silently no-op'd — ADR 015 "Update 2026-08-11"). This message
// is deliberately more specific than UNSUPPORTED_INPUT_ERROR above: it
// names the shape that WAS recognized and the plausible reasons `.server`
// still isn't trusted, rather than repeating the generic "expects Server
// or McpServer" text for a case that already got further than that. Now
// that both SDKs are supported (Phase 2), this branch only fires when
// `.server` matches NEITHER installed SDK's Server class — a duplicate/
// mismatched SDK install, a hoisting issue that makes an installed SDK
// unresolvable from this package's own location, or a genuinely
// unsupported third SDK.
const UNWRAPPABLE_MCPSERVER_ERROR =
  'opentel-mcp: instrumentMcpServer() detected an object shaped like a ' +
  'high-level McpServer (it has .tool()/.registerTool() and a ' +
  '.server.setRequestHandler() method), but its `.server` property is ' +
  'not a recognized Server instance from either supported MCP SDK ' +
  '(@modelcontextprotocol/sdk or @modelcontextprotocol/server), so it ' +
  'cannot be confidently wrapped. This usually means one of: (1) a ' +
  'duplicate or mismatched install of whichever SDK this server actually ' +
  'came from — try `npm dedupe` or check for multiple installed ' +
  'versions; (2) that SDK is installed, but not resolvable from this ' +
  'package\'s own location (e.g. a monorepo/hoisting issue) — confirm it ' +
  'is reachable via normal node_modules resolution from wherever ' +
  'opentel-mcp itself is installed; or (3) an MCP SDK this package does ' +
  'not support at all. See docs/adr/015-mcp-v2-support.md. Refusing to ' +
  'instrument rather than risk producing no telemetry.';

const INSTRUMENT_FIRST_ERROR =
  'opentel-mcp: instrumentMcpServer() must be called BEFORE registering ' +
  'tool handlers. Move instrumentMcpServer(server, options) to immediately ' +
  'after `new Server(...)`, before any server.setRequestHandler(...) calls ' +
  '(low-level Server, either SDK) or .tool()/.registerTool() calls ' +
  '(McpServer, either SDK).';

/**
 * Detects whether `input` is a low-level Server, a high-level McpServer, or
 * a McpServer-*shaped* object that this package cannot confidently wrap —
 * from EITHER supported SDK, `@modelcontextprotocol/sdk` (v1) or
 * `@modelcontextprotocol/server` (v2, ADR 015) — without importing
 * McpServer directly from either. Importing it would risk the same
 * dual-package-hazard class of bug the hello-server example hit (two
 * independently-installed copies of the same SDK producing two distinct
 * classes, so `instanceof` silently fails) — duck-typing the *outer*
 * object sidesteps that and stays tolerant of SDK versions that shuffle
 * McpServer's internals, since only its public, documented shape is
 * checked: a `.server` object, plus a `.tool` or `.registerTool` function.
 *
 * That duck-type check alone answers "does this look like a wrapper around
 * *some* Server?" — not "is the thing it wraps actually a `Server` from a
 * supported SDK, whose `setRequestHandler` this package's patch in
 * `instrumentMcpServer()` can actually intercept?" Those are different
 * questions, and conflating them was a confirmed bug before Phase 2 (ADR
 * 015 "Update 2026-08-11", `docs/known-gaps.md` entry 7): a v2 `McpServer`
 * satisfied the outer duck-type shape exactly but dispatched `tools/call`
 * by a method-name *string*, never by reference-equality against the v1
 * `CallToolRequestSchema` object the pre-Phase-2 patch compared against
 * (ADR 001) — the patch installed without error, but its wrapping branch
 * never fired, and every real tool call ran completely uninstrumented. No
 * exception, no warning, a success return value: exactly the silent-no-op
 * shape this package's own conventions treat as worse than a thrown error
 * (see ADR 002's precedent below).
 *
 * The fix (ADR 015 Phase 1, extended by Phase 2): additionally require
 * `input.server instanceof <Server>` for the McpServer branch, checked
 * against EACH installed SDK's `Server` class in turn (`getV1Sdk()`/
 * `getV2Sdk()`, `./sdk/detect.js` — `null` when that SDK isn't installed,
 * skipping its check entirely rather than crashing) — reusing the exact
 * `instanceof` check the low-level branch below already performs and
 * already accepts the (small, and — no test or report has ever exercised
 * it — purely theoretical) dual-package-hazard risk for, rather than
 * tolerating a *laxer* standard for the wrapped `.server` than this file
 * already applies to a bare `Server` passed directly. Phase 1 established
 * this check for v1 only, deliberately rejecting v2 (no way to wrap it
 * yet); Phase 2 does not weaken that rejection, it extends the same check
 * to a second candidate class — an object whose `.server` matches neither
 * installed SDK's `Server` still falls through to `unwrappable` exactly as
 * before.
 *
 * A real v1 McpServer's `.server` is always `instanceof` v1's `Server`:
 * v1's own `server/mcp.js` constructs it via `this.server = new
 * Server(...)`, imported from the exact same `server/index.js` module
 * `getV1Sdk()` resolves — confirmed by construction, not assumed. A real
 * v2 McpServer's `.server` is, symmetrically, always `instanceof` v2's
 * `Server` — also confirmed by construction (ADR 015). No escape hatch is
 * offered for the case where this rejects a duck-type-matching object
 * whose `.server` isn't `instanceof` either installed SDK's `Server` (see
 * `instrumentMcpServer()`'s docblock and ADR 015's Update for the full
 * argument): any bypass a caller could reach for is, by construction,
 * exactly what would let an unsupported object slip through again,
 * defeating this fix for the one caller least likely to know they're
 * hitting it.
 *
 * @param {unknown} input
 * @returns {{ server: object, outer?: object, kind: 'v1' | 'v2' } | { unwrappable: true, outer: object } | null}
 */
function detectServerKind(input) {
  const v1 = getV1Sdk();
  const v2 = getV2Sdk();

  if (v1 && input instanceof v1.Server) {
    return { server: input, kind: 'v1' };
  }
  if (v2 && input instanceof v2.Server) {
    return { server: input, kind: 'v2' };
  }
  if (
    input &&
    typeof input === 'object' &&
    input.server &&
    typeof input.server.setRequestHandler === 'function' &&
    (typeof input.tool === 'function' || typeof input.registerTool === 'function')
  ) {
    if (v1 && input.server instanceof v1.Server) {
      return { server: input.server, outer: input, kind: 'v1' };
    }
    if (v2 && input.server instanceof v2.Server) {
      return { server: input.server, outer: input, kind: 'v2' };
    }
    return { unwrappable: true, outer: input };
  }
  return null;
}

/**
 * Instruments an MCP server so every tool call emits an OpenTelemetry span.
 *
 * Accepts either a low-level Server or a high-level McpServer (see
 * detectServerKind above); McpServer is unwrapped to its inner Server,
 * which is what's actually patched. Must be called before any `tools/call`
 * handler is registered — i.e. before any `server.setRequestHandler(CallToolRequestSchema, ...)`
 * (low-level) or `.tool()`/`.registerTool()` (McpServer) calls (see ADR 001
 * and ADR 002 in docs/adr/ for why). Idempotent: calling this more than
 * once — on the same object, or on the outer McpServer and its inner
 * Server interchangeably — is a no-op after the first call.
 *
 * Throws synchronously, at call time, rather than silently no-op'ing, in
 * three cases — all setup-time validation, not the runtime never-throw
 * discipline `wrapToolCallHandler` below follows for the instrumented tool
 * call path itself (which must never let this package's own bugs break a
 * host's tool call): `input` doesn't look like a Server or McpServer at all
 * (`UNSUPPORTED_INPUT_ERROR`); `input` duck-types as a McpServer but its
 * `.server` isn't a recognized `@modelcontextprotocol/sdk` `Server` —
 * confirmed reachable by an `@modelcontextprotocol/server` (MCP v2) object,
 * which is NOT supported by this package (`UNWRAPPABLE_MCPSERVER_ERROR`,
 * see detectServerKind() above and ADR 015); or a `tools/call`/`tools/list`
 * handler is already registered before this call (`INSTRUMENT_FIRST_ERROR`,
 * `assertInstrumentFirst` below, ADR 002 — the original precedent this
 * function's other two throws now follow).
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server | import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./config.js').InstrumentOptions} options
 * @returns {*} The same object that was passed in, for chaining. When
 *   `options.setupNodeSdk` is true, the inner Server (and, when instrumenting
 *   an McpServer, the outer object too) gets a `shutdown()` method that
 *   flushes and shuts down the NodeTracerProvider created for it — call it
 *   during your process's own shutdown sequence to avoid losing buffered
 *   spans. When `setupNodeSdk` is false (the default), no `shutdown()` is
 *   attached; lifecycle of the global provider belongs to whoever
 *   registered it. Also gets a `getThrashSummary()` method (v0.6.0,
 *   unconditional — not gated behind `setupNodeSdk`) returning
 *   `ThrashDetector.getSummary()`'s in-process summary, and a
 *   `getObservationState()` method (ADR 008 "Update", v0.8.0 —
 *   also unconditional) returning `{ toolOutcome: { success, failure,
 *   unknown }, observationIntegrity: 'DEGRADED' | 'UNKNOWN' }` —
 *   `toolOutcome` from a counter that increments on every tool call
 *   regardless of `fingerprinting`/`thrashDetection`/`enableMetrics`;
 *   `observationIntegrity` re-evaluated fresh on every call to this
 *   accessor, not cached from instrument time, since a host may register
 *   a `TracerProvider` asynchronously after this function already ran.
 *   All three of `shutdown`/`getThrashSummary`/`getObservationState` are
 *   omitted when `options.enabled` is `false`, since nothing is
 *   instrumented at all in that case.
 */
export function instrumentMcpServer(input, options) {
  const detected = detectServerKind(input);
  if (!detected) {
    throw new Error(UNSUPPORTED_INPUT_ERROR);
  }
  if (detected.unwrappable) {
    // ADR 015 "Update (2026-08-11)": duck-type matched a McpServer shape,
    // but `.server` isn't a recognized Server instance — see
    // detectServerKind()'s docblock for why this can't be confidently
    // wrapped and why no escape hatch is offered here. Throwing here,
    // before any tracker/tracer setup, is the same "fail loudly at setup
    // time, never at runtime" precedent ADR 002's instrument-first check
    // already establishes below (assertInstrumentFirst) — this package's
    // never-throw discipline applies to the instrumented tool-call path,
    // not to instrumentMcpServer() itself deciding whether it can even
    // proceed.
    throw new Error(UNWRAPPABLE_MCPSERVER_ERROR);
  }

  const { server, outer, kind } = detected;

  if ((outer && outer[kInstrumented]) || server[kInstrumented]) {
    // Sync the guard onto both objects in case only one was marked so far
    // (e.g. the inner Server was instrumented directly once before, and
    // this call is the first time the outer McpServer wrapping it is seen).
    server[kInstrumented] = true;
    if (outer) outer[kInstrumented] = true;
    return input;
  }

  const resolved = resolveOptions(options);

  if (!resolved.enabled) {
    server[kInstrumented] = true;
    if (outer) outer[kInstrumented] = true;
    return input;
  }

  assertInstrumentFirst(server, resolved);

  const tracer = setupTracer(server, resolved);
  const metricsRecorder = resolved.enableMetrics ? setupMeter(PACKAGE_VERSION) : null;
  // One tracker per instrumented server, not per call — session/tool cost
  // must accumulate across the server's whole lifetime (see
  // src/cost/budget.js). A no-op tracker when costTracking.budget is unset.
  //
  // ADR 012, Phase 2: when resolved.instanceKey is set, this is looked up
  // from (or, on first use, created in) the process-wide instanceRegistry
  // instead of constructed fresh — see getOrCreateTracker()'s own docblock.
  // When instanceKey is undefined (the default), this line behaves exactly
  // as it did before this phase existed: factory() runs unconditionally,
  // the registry is never touched.
  const budgetTracker = getOrCreateTracker(resolved.instanceKey, 'budget', () =>
    createBudgetTracker(resolved.costTracking.budget),
  );
  // Same one-per-server lifetime as budgetTracker above — thrash episodes
  // accumulate across calls, not within one (see src/thrash/detector.js).
  // Constructed unconditionally, same as budgetTracker: resolved.thrashDetection.enabled
  // gates per-call work (applyThrashDetection/applyThrashSuccessClear
  // below), not this one-time setup. Same ADR-012/instanceKey wiring as
  // budgetTracker above.
  const thrashDetector = getOrCreateTracker(resolved.instanceKey, 'thrash', () => new ThrashDetector(resolved.thrashDetection));
  const thrashEmitter = resolved.enableMetrics ? createThrashEmitter(PACKAGE_VERSION) : null;
  // MCP sessions have a transport-provided id (extra.sessionId below) for
  // session-oriented transports, but stdio has none — there's exactly one
  // connection for the process's lifetime instead. Thrash detection still
  // needs *some* stable per-connection key to group repeated failures
  // under, so this generates one once per instrumented server/connection,
  // used only as a fallback — see resolveThrashSessionId() below for
  // exactly when that fallback is (and, critically, is NOT) permitted.
  // Budget tracking (above) intentionally does NOT get this fallback — it
  // already has its own, different, already-shipped behavior of silently
  // skipping session-scoped tracking with no session id, which this must
  // not change.
  //
  // ADR 015 Finding 3 / known-gaps entry 6: registry-backed via the same
  // getOrCreateTracker()/instanceRegistry machinery the four trackers
  // above already use — same namespacing pattern (a fifth trackerSuffix,
  // 'thrash-fallback-session'), same shared bound/TTL, no new policy
  // introduced. This is what actually fixes the gap: before this, the
  // fallback id was a plain `randomUUID()` local to this function body,
  // regenerated fresh on EVERY instrumentMcpServer() call regardless of
  // instanceKey — so even with the four trackers correctly shared via
  // instanceKey, a v2 per-request factory deployment (or any
  // fresh-Server-per-request deployment) landing on the fallback path
  // still had every request contribute its own unrelated one-off "session"
  // to the shared ThrashDetector, and nothing ever accumulated past 1.
  // Sharing this value the same way the trackers are shared closes that:
  // repeated instrumentMcpServer() calls under the same instanceKey now
  // reuse the SAME generated id, so consecutive failures on what the
  // caller has told us (via assumeSingleSession, or a positively-confirmed
  // single-connection transport — see isSingleConnectionTransport() below)
  // is one logical connection actually accumulate.
  //
  // When instanceKey is undefined (the default), getOrCreateTracker()
  // calls factory() directly without touching the registry at all — this
  // line is then byte-identical to the pre-fix `randomUUID()` call, same
  // as every other getOrCreateTracker() call site above. Fresh per call,
  // exactly as before.
  //
  // Deliberately NOT extended to thrashSessionState (the
  // hasSeenRealSessionId/hasWarnedFallbackUsed flags below) in this same
  // change — that's a narrower, separate gap (a v2 per-request deployment
  // "forgets" it has already proven itself session-aware on each new
  // call), scoped out on purpose. Tracked in docs/known-gaps.md entry 6,
  // not silently dropped.
  const thrashConnectionFallbackSessionId = getOrCreateTracker(resolved.instanceKey, 'thrash-fallback-session', () =>
    randomUUID(),
  );
  // Mutable per-server flag, not a `let` closed over directly: wrapToolCallHandler
  // is a top-level function taking all its state as parameters (see its
  // existing params), not a closure over instrumentMcpServer()'s locals —
  // this holder preserves that pattern while still letting
  // resolveThrashSessionId() persist state across calls. See that
  // function's docblock for why this flag exists at all.
  const thrashSessionState = { hasSeenRealSessionId: false, hasWarnedFallbackUsed: false };
  // Same "plain holder, not instanceKey-shared" reasoning as
  // thrashSessionState immediately above (ADR 019 Part 2, v0.13.0 Phase
  // 2): warnRejectedModel() (see applyCostAttribution()) is a low-stakes
  // diagnostic, not correctness-critical accumulated state the way
  // budgetTracker/thrashDetector are — firing again on a fresh instance
  // under a fresh-Server-per-request deployment is the same known,
  // accepted characteristic docs/known-gaps.md entry 6 already documents
  // for thrashSessionState, not a new problem this introduces.
  const costAttributionState = { warnedRejectedModel: false };
  // Additive to instrumentMcpServer()'s existing return contract (the same
  // input object, for chaining — see this function's own docblock): a
  // getThrashSummary() method attached the same way shutdown() is, just
  // unconditionally rather than gated behind setupNodeSdk, since
  // thrashDetector itself is always constructed (see above). Returns
  // ThrashDetector.getSummary()'s point-in-time, in-process summary — no
  // OTel involved, nothing sent anywhere; safe to call from application
  // code (a health-check endpoint, a periodic console.log, a debugger).
  server.getThrashSummary = (options) => thrashDetector.getSummary(options);
  if (outer) outer.getThrashSummary = server.getThrashSummary;
  if (outer && server.shutdown) {
    outer.shutdown = server.shutdown;
  }

  // ADR 008 (docs/adr/008-observation-liveness.md), "Update (2026-08-05):
  // The two-axis reframe", Phase 3: constructed unconditionally, same as
  // thrashDetector above — there is no separate "observation enabled"
  // config flag at all (unlike schemaDriftDetector below), since
  // ToolOutcome/ObservationIntegrity are a structural, always-on part of
  // instrumentation whenever instrumentation itself is on, not an
  // optional sub-feature. Deliberately NOT gated on fingerprinting,
  // thrashDetection, or enableMetrics — see ToolOutcomeCounter's own
  // docblock for why (Finding 3: those flags gate OTHER bookkeeping this
  // counter must stay independent of). Same ADR-012/instanceKey wiring as
  // budgetTracker/thrashDetector above.
  const toolOutcomeCounter = getOrCreateTracker(resolved.instanceKey, 'tool-outcome', () => new ToolOutcomeCounter());
  // Additive to instrumentMcpServer()'s existing return contract, same
  // pattern as getThrashSummary above: a getObservationState() method,
  // unconditional (not gated on setupNodeSdk), omitted entirely when
  // options.enabled is false (nothing is instrumented at all in that
  // case, so toolOutcomeCounter is never even constructed — see above).
  // detectObservationIntegrity() is called HERE, inside the accessor
  // closure, not once at instrument time: ADR 008 Finding 4 explicitly
  // requires re-evaluating it on every call, since "is a provider
  // registered" can change over a long-lived process's life if the host
  // registers one asynchronously after instrumentMcpServer() already
  // ran — a value computed once at startup would go stale the moment
  // that happens.
  server.getObservationState = () => ({
    toolOutcome: toolOutcomeCounter.getCounts(),
    observationIntegrity: detectObservationIntegrity(resolved.setupNodeSdk),
  });
  if (outer) outer.getObservationState = server.getObservationState;

  // ADR 010 (docs/adr/010-schema-drift.md), Phase 4: unlike thrashDetector/
  // thrashEmitter above, these are constructed ONLY when
  // resolved.schemaDrift.enabled — there is no independent reason to wrap
  // tools/list at all when this feature is off (the tools/list span it
  // introduces exists purely for schema drift, unlike the tools/call span,
  // which already serves other purposes regardless of fingerprinting/
  // thrash/cost). Skipping construction entirely here — not just gating
  // per-call use — is what actually delivers "no allocation when
  // disabled." schemaDriftEmitter is additionally gated on enableMetrics,
  // mirroring thrashEmitter exactly: detection/state-tracking is
  // independent of metrics on/off, only emission is gated. The
  // instanceKey/registry lookup below only runs when schemaDrift.enabled —
  // "no allocation when disabled" takes priority over the ADR-012 wiring,
  // exactly as it already does over every other option here; there is
  // nothing to share across calls for a feature that isn't running at all.
  const schemaDriftDetector = resolved.schemaDrift.enabled
    ? getOrCreateTracker(
        resolved.instanceKey,
        'schema-drift',
        () => new SchemaDriftDetector({ maxTrackedTools: resolved.schemaDrift.maxTrackedTools }),
      )
    : null;
  const schemaDriftEmitter =
    resolved.schemaDrift.enabled && resolved.enableMetrics ? createSchemaDriftEmitter(PACKAGE_VERSION) : null;

  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  // ADR 015 Phase 2: the two SDKs dispatch spec methods differently (ADR
  // 015 Finding 1) — v1's setRequestHandler takes a schema OBJECT as its
  // second argument for a 2-arg call (`CallToolRequestSchema`, reference-
  // equality anchored, ADR 001); v2's takes the method name as a STRING
  // directly. `kind` (from detectServerKind() above) was already resolved
  // once, at detection time — not re-detected per call — so each branch
  // below only ever runs the comparison relevant to the SDK this `server`
  // actually came from. `CallToolRequestSchema`/`ListToolsRequestSchema`
  // come from `getV1Sdk()` (`./sdk/detect.js`), not a static top-level
  // import, since v1 is now an optional peer (ADR 015 Finding 6's Update).
  if (kind === 'v1') {
    const v1 = getV1Sdk();
    server.setRequestHandler = (schema, handler) => {
      if (schema === v1.CallToolRequestSchema) {
        handler = wrapToolCallHandler(
          handler,
          tracer,
          metricsRecorder,
          resolved.fingerprinting,
          resolved.costTracking,
          budgetTracker,
          resolved.thrashDetection,
          thrashDetector,
          thrashEmitter,
          thrashConnectionFallbackSessionId,
          thrashSessionState,
          toolOutcomeCounter,
          server,
          kind,
          resolved.errorRecording,
          costAttributionState,
        );
      } else if (schema === v1.ListToolsRequestSchema && schemaDriftDetector) {
        handler = wrapToolsListHandler(
          handler,
          tracer,
          schemaDriftDetector,
          schemaDriftEmitter,
          SCHEMA_DRIFT_SCOPE,
          kind,
          resolved.errorRecording,
        );
      }
      return originalSetRequestHandler(schema, handler);
    };
  } else {
    // v2: dispatch by method-name STRING (ADR 015 Finding 1), not schema
    // identity — TOOLS_CALL_METHOD/TOOLS_LIST_METHOD are already the plain
    // strings 'tools/call'/'tools/list' (see their definitions above),
    // reused unchanged from the v1 path. Deliberately does NOT import
    // CallToolRequestSchema from @modelcontextprotocol/core/internal — ADR
    // 015 Finding 1 rejected that path explicitly: that subpath's own name
    // says it isn't for third-party consumption, and the string comparison
    // needs no schema object at all.
    //
    // v2's setRequestHandler also has a 3-arg overload for CUSTOM
    // (non-spec) methods — `setRequestHandler(method, schemas, handler)`.
    // `tools/call`/`tools/list` are spec methods and McpServer's own
    // internal registration always uses the 2-arg form (confirmed live,
    // ADR 015 Finding 1), so `maybeHandler === undefined` reliably
    // distinguishes "this is the 2-arg spec-method call we might need to
    // wrap" from "this is some other, unrelated 3-arg custom-method
    // registration" — the latter is passed through completely unchanged,
    // never inspected.
    server.setRequestHandler = (method, handlerOrSchemas, maybeHandler) => {
      if (maybeHandler === undefined && method === TOOLS_CALL_METHOD) {
        handlerOrSchemas = wrapToolCallHandler(
          handlerOrSchemas,
          tracer,
          metricsRecorder,
          resolved.fingerprinting,
          resolved.costTracking,
          budgetTracker,
          resolved.thrashDetection,
          thrashDetector,
          thrashEmitter,
          thrashConnectionFallbackSessionId,
          thrashSessionState,
          toolOutcomeCounter,
          server,
          kind,
          resolved.errorRecording,
          costAttributionState,
        );
      } else if (maybeHandler === undefined && method === TOOLS_LIST_METHOD && schemaDriftDetector) {
        handlerOrSchemas = wrapToolsListHandler(
          handlerOrSchemas,
          tracer,
          schemaDriftDetector,
          schemaDriftEmitter,
          SCHEMA_DRIFT_SCOPE,
          kind,
          resolved.errorRecording,
        );
      }
      return maybeHandler === undefined
        ? originalSetRequestHandler(method, handlerOrSchemas)
        : originalSetRequestHandler(method, handlerOrSchemas, maybeHandler);
    };
  }

  server[kInstrumented] = true;
  if (outer) outer[kInstrumented] = true;
  return input;
}

/**
 * Throws INSTRUMENT_FIRST_ERROR if a tools/call handler — or, when schema
 * drift detection is enabled, a tools/list handler — is already
 * registered on `server`. Uses the SDK's own public
 * assertCanSetRequestHandler(method) — the same check McpServer uses
 * internally — rather than reaching into the private _requestHandlers Map.
 * Feature-detected so a future SDK version that removes this method
 * degrades to relying on docs + the idempotency guard alone (see ADR 002).
 * Works identically whether `server` came from a low-level Server or was
 * unwrapped from an McpServer, since McpServer's .tool()/.registerTool()
 * lazily call this same server's setRequestHandler(CallToolRequestSchema)
 * (and, in the same call, ListToolsRequestSchema) on first registration.
 *
 * tools/list is only checked when resolved.schemaDrift.enabled: ADR 010
 * (Q2) extends this exact constraint to the new branch, but there's no
 * reason to enforce ordering for a schema this instance won't wrap at
 * all (see instrumentMcpServer()'s conditional wrapping decision below).
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server
 * @param {Required<import('./config.js').InstrumentOptions>} resolved
 */
function assertInstrumentFirst(server, resolved) {
  if (typeof server.assertCanSetRequestHandler !== 'function') {
    return;
  }
  try {
    server.assertCanSetRequestHandler(TOOLS_CALL_METHOD);
    if (resolved.schemaDrift.enabled) {
      server.assertCanSetRequestHandler(TOOLS_LIST_METHOD);
    }
  } catch {
    throw new Error(INSTRUMENT_FIRST_ERROR);
  }
}

/**
 * Resolves the Tracer to use for this server, optionally standing up an
 * owned NodeTracerProvider first.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server
 * @param {Required<import('./config.js').InstrumentOptions>} resolved
 * @returns {import('@opentelemetry/api').Tracer}
 */
function setupTracer(server, resolved) {
  if (resolved.setupNodeSdk) {
    // StderrSpanExporter, not ConsoleSpanExporter — stdio-transport MCP
    // servers write JSON-RPC to stdout, so diagnostic span output must go
    // to stderr instead or it corrupts the protocol stream. See ADR 003.
    const spanProcessors = [new SimpleSpanProcessor(new StderrSpanExporter())];
    if (resolved.exporterUrl) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: resolved.exporterUrl })));
    }

    // ADR 016 point 3: only attached when DEFAULT_PRICING is actually
    // contributing to the effective pricing table (same condition the
    // one-time diag.warn in resolveOptions() uses) — a resource attribute
    // naming a table this deployment doesn't use would be noise, not signal.
    const pricingResourceAttributes =
      resolved.costTracking.enabled && resolved.costTracking.usingDefaultPricing
        ? { [ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED]: DEFAULT_PRICING_LAST_VERIFIED }
        : {};

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': resolved.serviceName, ...pricingResourceAttributes }),
      spanProcessors,
    });
    provider.register();

    server.shutdown = () => provider.shutdown();
  }

  // Always the final step: when setupNodeSdk is false, this picks up
  // whatever TracerProvider the host application has already registered
  // globally (or the default no-op tracer if none has), rather than
  // opentel-mcp ever overriding a host's own OpenTelemetry setup.
  return trace.getTracer('opentel-mcp', PACKAGE_VERSION);
}

/**
 * True when `result` is a JSON-RPC-successful CallToolResult carrying a
 * tool-level failure (isError: true) — the "silent failure" this package
 * exists to catch (see the README's "Tool-level failures" section). Single
 * source of truth for that detection: wrapToolCallHandler below keys both
 * the span's status/error.type and the mcp.tool.silent_failures counter /
 * mcp.tool.duration outcome off this same check, rather than repeating
 * `result?.isError === true` at each call site.
 *
 * @param {*} result
 * @returns {boolean}
 */
function isToolResultError(result) {
  return result?.isError === true;
}

/**
 * ADR 015 Phase 2: reads `sessionId`/`requestId` off a wrapped handler's
 * second argument — `extra` for v1, `ctx` for v2 (ADR 015 Finding 1) — the
 * one place `wrapToolCallHandler`/`wrapToolsListHandler` need to branch on
 * `kind` at all; everything downstream of this call (span attributes,
 * fingerprinting, cost/thrash bookkeeping) consumes the same two plain
 * values regardless of which SDK produced them.
 *
 * v1: `extra.sessionId` / `extra.requestId`, both already optional/
 * possibly-absent (stdio has neither).
 *
 * v2: `ctx.sessionId` — the direct equivalent of v1's `extra.sessionId`,
 * still optional (ADR 015 Finding 3: NOT removed from the SDK, just
 * usually undefined under the new stateless-HTTP deployment shape — the
 * same "no session" case stdio already represents for v1, not a new one)
 * — and `ctx.mcpReq.id`, the request identity v2 nests one level deeper
 * than v1's flat `extra.requestId` (ADR 015 Finding 7). `ctx.mcpReq.id` is
 * typed non-optional in v2 (always present), but this function still reads
 * it via optional chaining and lets the caller's own presence guard apply
 * uniformly to both kinds — a non-optional field trivially passes an
 * `undefined`/`null` check, so special-casing it away would only remove a
 * harmless guard, not add real capability.
 *
 * @param {'v1' | 'v2'} kind
 * @param {*} extraOrCtx - The handler's second argument: v1's `extra`, or v2's `ctx`.
 * @returns {{ sessionId: string | undefined, requestId: * }}
 */
function extractSessionAndRequestId(kind, extraOrCtx) {
  if (kind === 'v2') {
    return { sessionId: extraOrCtx?.sessionId, requestId: extraOrCtx?.mcpReq?.id };
  }
  return { sessionId: extraOrCtx?.sessionId, requestId: extraOrCtx?.requestId };
}

/**
 * One-time diagnostic for a tool result's `model` field that failed
 * isValidModelId()'s length/shape gate (ADR 019 Part 2,
 * docs/adr/019-raw-content-on-spans.md, v0.13.0 Phase 2). Distinct from
 * budgetTracker.recordUnpriced()'s own warning (src/cost/budget.js):
 * that one describes a LATER, different condition (a real, valid model
 * name that just doesn't resolve to a price) and only fires when a
 * budget is actually configured. This one fires for any
 * `costTracking.enabled` deployment, budget or not — "your cost/token
 * attribution is silently missing a model" is worth knowing regardless
 * of whether a budget guardrail is in play.
 *
 * CRITICAL, and the entire reason this function exists rather than just
 * inlining a `diag.warn()` call with `value` in it: reports SHAPE ONLY —
 * via describeInvalidModelId() (src/cost/calculator.js), never the
 * rejected value itself. `diag.warn()` output routinely gets piped into
 * a deployment's own logging pipeline; printing the offending string
 * here would relocate this whole gate's problem from spans into logs
 * instead of closing it.
 *
 * Fires at most once per `state` object — see applyCostAttribution()'s
 * own docblock for why `state` (costAttributionState) is constructed
 * fresh per instrumentMcpServer() call rather than instanceKey-shared.
 * Never throws, matching every other diagnostic in this codebase.
 *
 * @param {unknown} value - The rejected `usage.model` value. Read only for its shape (typeof, length) —
 *   never logged, never returned, never otherwise observable outside this function.
 * @param {{ warnedRejectedModel: boolean }} state
 */
function warnRejectedModel(value, state) {
  if (state.warnedRejectedModel) return;
  state.warnedRejectedModel = true;

  try {
    diag.warn(
      `opentel-mcp: a tool result's model field failed validation (${describeInvalidModelId(value)}) and was ` +
        "excluded from mcp.tool.model / gen_ai.response.model / cost attribution; mcp.tool.pricing_status was " +
        "set to 'unknown'. This warning fires once per instrumentMcpServer() call and deliberately never logs " +
        'the value itself — see docs/adr/019-raw-content-on-spans.md Part 2.',
    );
  } catch {
    // Never throw — see this function's own docblock.
  }
}

/**
 * Best-effort cost/token attribution for one tool call's result, added on
 * top of the span and metrics that always fire (see wrapToolCallHandler
 * below). Runs `costTracking.extractor` (defaultExtractor by default — see
 * src/cost/extractor.js) against `result`; if it finds recognizable usage,
 * sets the three mcp.tool.tokens.* span attributes (+ mcp.tool.model and,
 * for ecosystem-dashboard compatibility, gen_ai.response.model — see that
 * constant's docblock in attributes.js for why both are set — when a model
 * was detected) and records mcp.tool.tokens.total. If a model was
 * detected, additionally runs calculateCost() (src/cost/calculator.js)
 * against `costTracking.pricingTable` and, when it resolves (the model is
 * in the table), sets mcp.tool.cost.usd / mcp.tool.cost.currency, records
 * mcp.tool.cost.total, and runs `budgetTracker.recordAndCheck()`
 * (src/cost/budget.js) — if that reports the call pushed a configured
 * budget over its limit, sets mcp.tool.cost.budget_exceeded /
 * mcp.tool.cost.budget_scope. An unrecognized model silently skips cost
 * *and* budget attribution — the token attributes still land. v0.12.0
 * (docs/known-gaps.md entry 9): that "silently" is now only true of the
 * span/metrics — the same branch calls `budgetTracker.recordUnpriced()`
 * instead, which fires a one-time diag.warn() naming the model, but only
 * when a budget is actually configured (a pure no-op otherwise). No
 * behavior change: this is diagnostics only, not a new price or a new
 * budget-exceeded condition.
 *
 * No-op when `costTracking.enabled` is false. Called from both the
 * isToolResultError and success branches below (there's a result to read
 * usage from in either case); never from the thrown-exception catch block,
 * since a thrown/rejected call never produced a result. The whole body is
 * one try/catch — extractor.js, calculator.js, and budget.js already
 * document themselves as never-throw, but span.setAttribute/
 * metricsRecorder calls are outside their control, and this must never be
 * why a tool call span fails to complete.
 *
 * Returns this call's token/cost figures (or null when disabled/no usage
 * found) so the isToolResultError branch can feed them to Agent Thrash
 * Detection (applyThrashDetection() below, v0.6.0) without re-running the
 * extractor/calculateCost a second time — added in v0.6.0, purely
 * additive: nothing in v0.5.0 consumed this function's return value.
 *
 * v0.11.0 (ADR 016, docs/adr/016-pricing-override-and-staleness.md point
 * 4): also sets mcp.tool.pricing_status — unconditionally whenever usage
 * was extracted (even with no model detected, unlike mcp.tool.model/
 * mcp.tool.cost.*), so a dashboard can compute "% of tokens/spend unpriced"
 * directly instead of inferring it from an attribute's absence. Passed to
 * recordTokens/recordCost too, for the same metric-level visibility.
 *
 * v0.13.0 (ADR 019 Part 2, docs/adr/019-raw-content-on-spans.md): `usage.model`
 * is tool-RESULT content, not library-computed metadata — before it's used
 * ANYWHERE below (span attributes, calculateCost(), pricingOverrideKeys
 * lookup, metric labels), it's gated through isValidModelId()
 * (src/cost/calculator.js): a length/character allowlist, never a
 * pricing-table membership check. A value that fails this gate is treated
 * exactly like "no model detected" for every downstream purpose — the
 * existing mcp.tool.pricing_status: "unknown" / budgetTracker.recordUnpriced()
 * machinery already handles that case correctly, so a rejected value is
 * never a silent drop, just a redirection into a path this function
 * already had. warnRejectedModel() below additionally fires a one-time,
 * SHAPE-ONLY diagnostic (never the rejected value itself — see that
 * function's own docblock) distinct from budgetTracker.recordUnpriced()'s
 * own warning, which describes a different, later condition and is gated
 * on a budget being configured; this one isn't.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {ReturnType<import('./metrics.js').setupMeter> | null} metricsRecorder
 * @param {string | undefined} toolName
 * @param {string | undefined} sessionId
 * @param {*} result
 * @param {import('./config.js').CostTrackingOptions & { pricingOverrideKeys: Set<string> }} costTracking
 * @param {ReturnType<import('./cost/budget.js').createBudgetTracker>} budgetTracker
 * @param {{ warnedRejectedModel: boolean }} costAttributionState - ADR 019 Part 2: one-time-warning state
 *   for warnRejectedModel() below, constructed once per instrumentMcpServer() call (same non-instanceKey-shared
 *   granularity as thrashSessionState — see that variable's own comment in instrumentMcpServer()).
 * @returns {{ tokensIn: number, tokensOut: number, costUsd: number } | null}
 */
function applyCostAttribution(span, metricsRecorder, toolName, sessionId, result, costTracking, budgetTracker, costAttributionState) {
  if (!costTracking.enabled) return null;

  try {
    const usage = costTracking.extractor(result);
    if (!usage) return null;

    span.setAttribute(ATTR_MCP_TOOL_TOKENS_INPUT, usage.inputTokens);
    span.setAttribute(ATTR_MCP_TOOL_TOKENS_OUTPUT, usage.outputTokens);
    span.setAttribute(ATTR_MCP_TOOL_TOKENS_TOTAL, usage.totalTokens);

    // ADR 019 Part 2: usage.model is gated here, ONCE, before it reaches
    // anything below — a rejected value (usage.model was present but
    // isn't identifier-shaped) is treated identically to "no model
    // detected" for every downstream purpose (validModel stays
    // undefined), and warnRejectedModel() fires the one-time, shape-only
    // diagnostic. usage.model === undefined (no model detected at all —
    // the pre-existing, unrelated case) never calls warnRejectedModel:
    // there's nothing rejected, just nothing found.
    const modelIsValid = isValidModelId(usage.model);
    if (usage.model !== undefined && !modelIsValid) {
      warnRejectedModel(usage.model, costAttributionState);
    }
    const validModel = modelIsValid ? usage.model : undefined;

    if (validModel) {
      span.setAttribute(ATTR_MCP_TOOL_MODEL, validModel);
      span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, validModel);
    }

    let costUsd = null;
    if (validModel) {
      costUsd = calculateCost(usage.inputTokens, usage.outputTokens, validModel, costTracking.pricingTable);
    }

    // ADR 016 point 4: provenance-based, computed against the same
    // normalized key calculateCost() itself looked up — 'unknown' covers
    // "no model detected at all," "a rejected model field" (ADR 019 Part
    // 2 — validModel is undefined either way), and "model detected but
    // didn't resolve to a cost" (unrecognized, or a malformed override
    // entry).
    const pricingStatus =
      !validModel || costUsd === null
        ? MCP_TOOL_PRICING_STATUS_UNKNOWN
        : costTracking.pricingOverrideKeys.has(normalizeModelName(validModel))
          ? MCP_TOOL_PRICING_STATUS_USER_OVERRIDE
          : MCP_TOOL_PRICING_STATUS_KNOWN;
    span.setAttribute(ATTR_MCP_TOOL_PRICING_STATUS, pricingStatus);
    // validModel, not usage.model: mcp.tool.model is also a metric LABEL
    // here (metrics.js's recordTokens()/recordCost()), so a rejected
    // value must never reach it either — an unvalidated string becoming a
    // label is a cardinality hazard on top of the content-exposure one
    // ADR 019 Part 2 is about.
    metricsRecorder?.recordTokens(toolName, validModel, usage.totalTokens, pricingStatus);

    if (costUsd !== null) {
      span.setAttribute(ATTR_MCP_TOOL_COST_USD, costUsd);
      span.setAttribute(ATTR_MCP_TOOL_COST_CURRENCY, MCP_TOOL_COST_CURRENCY_USD);
      metricsRecorder?.recordCost(toolName, validModel, costUsd, pricingStatus);

      const budgetResult = budgetTracker.recordAndCheck(sessionId, toolName, costUsd);
      if (budgetResult.exceeded) {
        span.setAttribute(ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED, true);
        span.setAttribute(ATTR_MCP_TOOL_COST_BUDGET_SCOPE, budgetResult.scope);
      }
    } else {
      // v0.12.0, docs/known-gaps.md entry 9: the same condition that set
      // pricingStatus to "unknown" above — usage was extracted, but never
      // reached recordAndCheck() at all, so a configured budget silently
      // never saw it. recordUnpriced() no-ops unless a budget is actually
      // configured, and warns at most once per tracker instance — see its
      // own docblock (src/cost/budget.js).
      //
      // validModel, deliberately NOT usage.model: recordUnpriced()'s OWN
      // pre-existing warning (cost/budget.js) names whatever `model` it's
      // given verbatim (`isNonEmptyString(model) ? \`"${model}"\` : ...`)
      // — it was written for "a real, short model name that just has no
      // price," where that's safe. Passing the RAW rejected usage.model
      // through unchanged here would let THAT warning re-leak the exact
      // content warnRejectedModel() above was just careful not to —
      // relocating ADR 019 Part 2's problem into a different diag.warn()
      // call instead of closing it. validModel is undefined for a
      // rejected value, which recordUnpriced() already renders as
      // "(no model detected)" — an approximation ("rejected" collapses
      // into "not detected"), accepted deliberately: warnRejectedModel()
      // above is the one place that's supposed to say more, safely.
      budgetTracker.recordUnpriced(validModel);
    }

    return { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: costUsd ?? 0 };
  } catch (err) {
    diag.debug('opentel-mcp: cost attribution failed, skipping mcp.tool.tokens.*/mcp.tool.cost.* attributes', err);
    return null;
  }
}

// v1 and v2 both name their stdio transport class identically — confirmed
// live against both installed packages (@modelcontextprotocol/sdk's
// server/stdio.js and @modelcontextprotocol/server's stdio.js both export
// a class whose `.name` is exactly this string). Used only for the v2
// branch of isSingleConnectionTransport() below — v1's existing check
// needs no name at all, see that function's docblock for why.
const STDIO_TRANSPORT_CLASS_NAME = 'StdioServerTransport';

/**
 * True only when `server.transport` is connected and reliably indicates a
 * single-connection transport. The exact test differs by `kind`
 * (ADR 015 "Update 2026-08-11, continued", known-gaps entry 8 — see below
 * for why one check no longer works for both SDKs).
 *
 * **v1** (`kind === 'v1'`, or `kind` omitted for a caller that hasn't been
 * updated to pass it): unchanged from before this fix — no `sessionId`
 * property on the transport at all. Both session-oriented transports v1
 * ships, `StreamableHTTPServerTransport` and `SSEServerTransport`, expose
 * a public `sessionId` getter (see @modelcontextprotocol/sdk's
 * server/{streamableHttp,sse}.d.ts); `StdioServerTransport` does not (see
 * server/stdio.d.ts). This inference has never been shown wrong for any
 * v1 transport, including a custom `Transport` implementation with no
 * `sessionId` property — left exactly as it was, byte-for-byte, since
 * there is no confirmed v1 bug motivating a change and changing it would
 * be a real behavior change for that population (see ADR 015's Update for
 * the "why not flip this globally" argument).
 *
 * **v2** (`kind === 'v2'`): the same "no `sessionId` property" inference
 * is no longer sufficient evidence, and using it produces a confirmed,
 * live false positive — closing `docs/known-gaps.md` entry 8. v2's
 * `PerRequestHTTPServerTransport` (the transport `createMcpHandler`
 * builds internally, i.e. v2's recommended deployment path) *also* has no
 * `sessionId` property, for the opposite reason stdio doesn't: it's
 * request-scoped, not connection-scoped, and legitimately serves many
 * distinct, unrelated clients across separate requests — confirmed live
 * by constructing one and inspecting its own properties directly (no
 * session/client-identity concept anywhere, not even privately). There is
 * no positive signal on the object itself that distinguishes it from
 * stdio; both simply lack a `sessionId` property, for unrelated reasons.
 *
 * So for v2, this checks `transport.constructor.name === 'StdioServerTransport'`
 * instead — POSITIVE confirmation of "this is stdio," rather than
 * inferring single-connection from the mere absence of a property.
 * Everything else (specifically `PerRequestHTTPServerTransport`, and
 * `WebStandardStreamableHTTPServerTransport` — confirmed still correctly
 * excluded by its own `sessionId` property in both stateless and stateful
 * construction, unaffected by this change) falls through to `false` —
 * "undetermined" — the exact same safe branch this function already had
 * for any transport it couldn't determine, not a new code path.
 *
 * **Why `.constructor.name`, when ADR 001/015 elsewhere reject
 * name/`instanceof`-based checks:** those rejections are specifically
 * about importing a class to check `instanceof` against it, which (a)
 * requires resolving an optional peer dependency that might not be
 * installed, and (b) fails across two independently-resolved copies of
 * the same package (the dual-package-hazard class of bug this file's own
 * `detectServerKind()` docblock describes) — two different problems,
 * neither of which applies to `.constructor.name`. A class's `.name` is
 * fixed by its declaration (`class StdioServerTransport { ... }`) and
 * identical across every resolved copy of the package; reading it
 * requires no import of either SDK at all. ADR 015 Finding 8's original
 * "not by name/instanceof" phrasing conflated these two risks — this is
 * the correction, made deliberately, not an oversight.
 *
 * **Honest accounting of what `.constructor.name` does NOT protect
 * against:** a bundler or minifier that renames classes (uncommon for
 * server-side Node deployments, not impossible) would make this check
 * fail to recognize a genuine stdio transport. The failure mode if that
 * happens is the SAFE direction — `isSingleConnectionTransport()` returns
 * `false`, thrash detection falls back to "undetermined" and is skipped
 * unless `assumeSingleSession: true` is set, exactly like any other
 * transport this function can't confirm. It does not fabricate loops; it
 * loses detection. This asymmetry (fail toward under-detection, never
 * toward over-detection) is the same principle the pre-existing "return
 * false when `server.transport` is undefined" branch below already
 * embodies.
 *
 * Returns false whenever `server.transport` is undefined too — the SDK
 * only populates it after `server.connect(transport)` runs, which happens
 * *after* `instrumentMcpServer()` in normal startup order (see the
 * README's "Ordering constraint"), and this repo's own test harness
 * (`invokeToolCall()` in the test files) never calls `.connect()` at all.
 * A transport that can't be determined is never assumed to be
 * single-connection; see `thrashDetection.assumeSingleSession`
 * (config.js) for the explicit opt-in that covers this case.
 *
 * @param {*} server
 * @param {'v1' | 'v2' | undefined} kind
 * @returns {boolean}
 */
function isSingleConnectionTransport(server, kind) {
  const transport = server?.transport;
  if (!transport) return false;

  if (kind === 'v2') {
    return transport?.constructor?.name === STDIO_TRANSPORT_CLASS_NAME;
  }

  return !('sessionId' in transport);
}

/**
 * Identifies which of the three conditions let resolveThrashSessionId()
 * below fall back to the generated per-connection session id, for the
 * one-time diag.warn() it fires the first time that actually happens (see
 * thrashSessionState.hasWarnedFallbackUsed there). Each implies a
 * different amount of risk if the single-connection assumption turns out
 * to be wrong:
 *
 *   - Transport structurally detected as single-connection (v1: no
 *     `sessionId` property; v2: positively confirmed as
 *     `StdioServerTransport` — see isSingleConnectionTransport() above):
 *     the safest case, backed by evidence.
 *   - `assumeSingleSession: true` overriding a transport that IS connected
 *      and DOES expose its own `sessionId` (i.e. isSingleConnectionTransport()
 *      returned false because the transport looks session-oriented): the
 *      riskiest case — the operator is contradicting available evidence.
 *   - `assumeSingleSession: true` with the transport simply not yet
 *     connected/undeterminable: no contradicting evidence, just unproven.
 *
 * @param {*} server
 * @param {'v1' | 'v2' | undefined} kind
 * @returns {'single-connection transport detected' | 'assumeSingleSession: true' | 'transport undeterminable, opted in via assumeSingleSession: true'}
 */
function describeFallbackReason(server, kind) {
  if (isSingleConnectionTransport(server, kind)) {
    return 'single-connection transport detected';
  }
  if (server?.transport) {
    return 'assumeSingleSession: true';
  }
  return 'transport undeterminable, opted in via assumeSingleSession: true';
}

/**
 * Resolves the session id Agent Thrash Detection should use for one call,
 * or `null` when detection should be skipped entirely for this call.
 * Concurrent HTTP/SSE clients can otherwise collide into one shared
 * fallback "session," fabricating loops out of unrelated failures from
 * different clients — this exists specifically to prevent that. In
 * priority order:
 *
 *   1. A real `extra.sessionId` always wins, and permanently marks this
 *      server as session-aware (`thrashSessionState.hasSeenRealSessionId`).
 *   2. Once a server has been observed to be session-aware, a later call
 *      with no sessionId is skipped outright (returns null) — it is never
 *      merged into the shared fallback key, even if `assumeSingleSession`
 *      is set. A server that has proven it hands out real session ids
 *      does not get to fall back just because one particular call lacked
 *      one.
 *   2.5. (ADR 018, docs/adr/018-trace-id-as-thrash-fallback.md) Before any
 *      real sessionId has ever been observed, and before step 3's
 *      UUID/skip fallback runs: if this call's span has a validly
 *      extracted REMOTE parent — i.e. `request.params._meta` carried a
 *      valid W3C `traceparent` that `extractTraceContext()`
 *      (src/tracecontext/extract.js) turned into a remote `SpanContext` —
 *      use that parent's trace id as the session-id candidate. Gated on
 *      `trace.getSpanContext(parentContext)?.isRemote === true`, never on
 *      a span's own `traceId` in isolation: every span, root or child, has
 *      a `traceId`, and a ROOT span's (no valid `traceparent` extracted)
 *      is freshly, randomly generated on every single call — using it
 *      unconditionally would silently turn today's honest "skip,
 *      undetermined" into "always produce a session id that never matches
 *      the previous call's," which is worse than skipping (see the ADR's
 *      "THE TRAP"). Does NOT set `thrashSessionState.hasSeenRealSessionId`
 *      — that flag means "this transport hands out real session
 *      identity," a permanent per-server fact; a trace id being present
 *      on one call is a per-call fact about that one client's behavior,
 *      not proof about the transport (ADR 018's "Constraints accepted").
 *      No diag.warn(): unlike step 3 below, this isn't a guess about
 *      transport topology the operator can correct — it's real,
 *      client-supplied data, strictly finer-grained than the fallback it
 *      sits beside, with no operator action item to flag.
 *   3. Before any real sessionId has ever been observed, and step 2.5
 *      above didn't apply: the generated per-connection fallback
 *      (`thrashConnectionFallbackSessionId`) is used when
 *      `thrashConfig.assumeSingleSession` is true, or when
 *      `isSingleConnectionTransport(server)` reliably determines the
 *      transport is single-connection. Otherwise, skip — an undetermined
 *      transport is not assumed to be single-connection. The first time
 *      (and only the first time — per server instance, not per call) this
 *      branch actually fires, a diag.warn() fires too (see
 *      describeFallbackReason() above), since silently guessing a session
 *      boundary is worth a loud, one-time flag if it's wrong.
 *
 * @param {*} server
 * @param {string | undefined} sessionId - extra.sessionId for this call.
 * @param {{ hasSeenRealSessionId: boolean, hasWarnedFallbackUsed: boolean }} thrashSessionState - Mutated in place; see instrumentMcpServer().
 * @param {string} thrashConnectionFallbackSessionId
 * @param {import('./thrash/config.js').ThrashConfig} thrashConfig
 * @param {'v1' | 'v2' | undefined} kind - Threaded through to isSingleConnectionTransport()/describeFallbackReason() — see their docblocks (ADR 015).
 * @param {import('@opentelemetry/api').Context} parentContext - The span's parent context, as returned by extractTraceContext() (ADR 017) — checked here for a validly-extracted remote SpanContext (ADR 018, step 2.5).
 * @returns {string | null}
 */
function resolveThrashSessionId(server, sessionId, thrashSessionState, thrashConnectionFallbackSessionId, thrashConfig, kind, parentContext) {
  if (sessionId !== undefined) {
    thrashSessionState.hasSeenRealSessionId = true;
    return sessionId;
  }

  if (thrashSessionState.hasSeenRealSessionId) {
    return null;
  }

  const remoteParentSpanContext = trace.getSpanContext(parentContext);
  if (remoteParentSpanContext?.isRemote === true) {
    return remoteParentSpanContext.traceId;
  }

  if (thrashConfig.assumeSingleSession || isSingleConnectionTransport(server, kind)) {
    if (!thrashSessionState.hasWarnedFallbackUsed) {
      thrashSessionState.hasWarnedFallbackUsed = true;
      diag.warn(
        'opentel-mcp: Agent Thrash Detection is using a generated fallback session id ' +
          `(reason: ${describeFallbackReason(server, kind)}). If this transport is in fact serving multiple ` +
          'concurrent clients, loop detection will merge unrelated clients into false-positive loops. ' +
          'This warning fires once per instrumentMcpServer() call.',
      );
    }
    return thrashConnectionFallbackSessionId;
  }

  return null;
}

/**
 * Agent Thrash Detection (v0.6.0): runs on a tool-level failure (isError:
 * true) whose fingerprint has already been computed by computeFingerprint()
 * in the caller. No-op — with zero allocation, checked first — when
 * `thrashConfig.enabled` is false, or when `fingerprint` is undefined
 * (fingerprinting itself is disabled; there is nothing to key detection
 * off, see config.js's `thrashDetection` docblock).
 *
 * Composes v0.4's fingerprint with v0.5's per-call token/cost figures
 * (`usage`, reused from applyCostAttribution()'s return value above — not
 * recomputed) into one ThrashDetector.record() call. When that crosses a
 * detection threshold, the resulting ThrashDetectedEvent is handed to the
 * emitter (src/thrash/emitter.js), which turns it into the mcp.tool.loop.*
 * metrics and an mcp.loop.detected event on this same span.
 *
 * The whole body is one try/catch: ThrashDetector.record() and the
 * emitter's emit() already document themselves as never-throw, but this
 * call site's own glue (reading span.spanContext(), building the input
 * object) isn't proven never-throw, and a failure here must never affect
 * the tool call result — same defense-in-depth reasoning as
 * applyCostAttribution above.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {import('./thrash/config.js').ThrashConfig} thrashConfig
 * @param {ThrashDetector} thrashDetector
 * @param {ReturnType<typeof createThrashEmitter> | null} thrashEmitter
 * @param {string} sessionId - Transport session id, or the per-connection fallback — see instrumentMcpServer().
 * @param {string | undefined} toolName
 * @param {string | undefined} fingerprint - mcp.failure.fingerprint, or undefined when fingerprinting is disabled.
 * @param {{ tokensIn: number, tokensOut: number, costUsd: number } | null} usage - applyCostAttribution()'s return value.
 * @param {string | undefined} channel - classifyFailureChannel()'s result (ADR 007, Phase 3), threaded
 *   straight through to ThrashDetector.record() for its per-origin threshold (src/thrash/detector.js's
 *   resolveThreshold()). Callers must not invoke this function at all for a 'protocol.output' failure — see
 *   this function's call sites in wrapToolCallHandler() — but ThrashDetector.record() also refuses to track
 *   it as defense in depth.
 */
function applyThrashDetection(span, thrashConfig, thrashDetector, thrashEmitter, sessionId, toolName, fingerprint, usage, channel) {
  if (!thrashConfig.enabled || fingerprint === undefined) return;

  try {
    const event = thrashDetector.record({
      sessionId,
      toolName,
      fingerprint,
      channel,
      spanId: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      tokensIn: usage?.tokensIn ?? 0,
      tokensOut: usage?.tokensOut ?? 0,
      costUsd: usage?.costUsd ?? 0,
    });

    if (event) {
      thrashEmitter?.emit(event);
    }
  } catch (err) {
    diag.debug('opentel-mcp: thrash detection failed, skipping mcp.tool.loop.* telemetry for this call', err);
  }
}

/**
 * Agent Thrash Detection (v0.6.0): runs on every successful (non-error)
 * tool result — the loop broke, if there was one. Clears thrashDetector's
 * tracked entry for this (sessionId, toolName) pair; see
 * ThrashDetector.clearOnSuccess()'s own docblock for exactly what that
 * does and doesn't clear. No-op with zero allocation when
 * `thrashConfig.enabled` is false. Never throws, same defense-in-depth
 * reasoning as applyThrashDetection() above.
 *
 * @param {import('./thrash/config.js').ThrashConfig} thrashConfig
 * @param {ThrashDetector} thrashDetector
 * @param {string} sessionId
 * @param {string | undefined} toolName
 */
function applyThrashSuccessClear(thrashConfig, thrashDetector, sessionId, toolName) {
  if (!thrashConfig.enabled) return;

  try {
    thrashDetector.clearOnSuccess(sessionId, toolName);
  } catch (err) {
    diag.debug('opentel-mcp: thrash detection clearOnSuccess failed', err);
  }
}

/**
 * Records a resolved tool call's outcome for the ToolOutcome half of the
 * two-axis observation contract (ADR 008, docs/adr/008-observation-liveness.md,
 * "Update (2026-08-05)", Finding 3). No enabled-check here at all —
 * unlike applyThrashSuccessClear above, this must run unconditionally,
 * independent of fingerprinting/thrashDetection/costTracking/
 * enableMetrics (see ToolOutcomeCounter's own docblock). Covers both the
 * isError and success cases in one call: ToolOutcomeCounter.recordResult()
 * does its own isError check internally, so this is called once per
 * resolved call, not once per branch.
 *
 * The whole body is one try/catch: ToolOutcomeCounter's own methods
 * already document themselves as never-throw, but this call site's own
 * glue isn't proven never-throw, and a failure here must never affect
 * the tool call result — same defense-in-depth reasoning as
 * applyCostAttribution/applyThrashDetection above.
 *
 * @param {ToolOutcomeCounter} toolOutcomeCounter
 * @param {*} result
 */
function applyToolOutcomeResult(toolOutcomeCounter, result) {
  try {
    toolOutcomeCounter.recordResult(result);
  } catch (err) {
    diag.debug('opentel-mcp: tool outcome recording failed, skipping ToolOutcome bookkeeping for this call', err);
  }
}

/**
 * Records a thrown/rejected tool call's outcome — always FAILURE, since
 * a thrown/rejected call is unambiguous evidence of failure regardless
 * of what shape the thrown value has. Same unconditional, defense-in-
 * depth discipline as applyToolOutcomeResult above.
 *
 * @param {ToolOutcomeCounter} toolOutcomeCounter
 */
function applyToolOutcomeThrown(toolOutcomeCounter) {
  try {
    toolOutcomeCounter.recordThrown();
  } catch (err) {
    diag.debug('opentel-mcp: tool outcome recording failed, skipping ToolOutcome bookkeeping for this call', err);
  }
}

/**
 * Records a thrown exception onto `span` per `errorRecordingConfig.mode`
 * (ADR 019 Part 1, docs/adr/019-raw-content-on-spans.md, v0.13.0 Phase 1).
 * The only two call sites are the thrown-exception catch blocks in
 * wrapToolCallHandler()/wrapToolsListHandler() below — a tool-level
 * `isError: true` result never carries a JS Error at all and is
 * unaffected by this option (see its own `span.setStatus({ code:
 * SpanStatusCode.ERROR })` with no message, a few lines above in
 * wrapToolCallHandler — the exact pattern 'none' mode below reuses).
 *
 * - `'full'` (default): `span.recordException(err)` +
 *   `setStatus({ message: err?.message })` — byte-identical to every
 *   release before v0.13.0. This is the literal two-line call the
 *   catch blocks used inline before this function existed; taken
 *   unconditionally, with no new branching evaluated first, whenever
 *   mode is `'full'`.
 * - `'none'`: `setStatus({ code: ERROR })` only — no message, no
 *   `exception` event.
 * - `'normalized'`: a hand-built `exception` event carrying the same
 *   three keys `recordException()` itself would set
 *   (`exception.type`/`exception.message`/`exception.stacktrace`), built
 *   from `normalizeException()` (`fingerprint/normalize/exception.js`) —
 *   the SAME coercion + `normalizeMessage()`/`parseAndNormalizeStack()`
 *   step `computeFingerprint()` (`fingerprint/compose.js`) calls for the
 *   same `err` a few lines later, when fingerprinting is enabled. Before
 *   this consolidation, this branch re-derived message/stack from a raw
 *   `err?.message`/`err?.stack` read independently of
 *   `computeFingerprint()`'s own (richer) coercion — same inputs, two
 *   call sites, free to drift apart on the next edit to either one: a
 *   thrown string or a plain non-Error object got a real `mcp.failure.*`
 *   fingerprint but silently NO `exception.message` on the span, since
 *   the old inline read only handled real `Error` instances.
 *   `normalizeException()` closes that by construction — one
 *   computation, two consumers — not by keeping two implementations in
 *   sync by hand. `err` itself is still never mutated: both call sites
 *   rethrow the original object afterward.
 *
 * `error.type` (`ATTR_ERROR_TYPE`, set by each call site immediately
 * after this call returns) is capped at `MAX_ERROR_CLASS_LENGTH`
 * regardless of mode — see each call site's own comment. The native
 * `exception.type` a `'full'`-mode `span.recordException(err)` call sets
 * internally is deliberately NOT capped here: `'full'` mode is defined
 * as byte-identical to pre-v0.13.0 behavior, so the native OTel SDK call
 * is left completely untouched, uncapped exception.type included. Only
 * `'normalized'` mode's hand-built event applies the cap to
 * `exception.type` too (mirroring `recordException()`'s own
 * `err.code?.toString() ?? err.name` derivation for what goes in that
 * field), since that event is already being constructed by hand either
 * way — there is no "untouched native call" to preserve for that mode.
 *
 * Never throws — matches this library's fail-open discipline for
 * everything downstream of a real thrown error, the same guarantee
 * `fingerprint/compose.js`'s `computeFingerprint()` already makes for
 * the exact same `err`.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {unknown} err
 * @param {import('./error-recording/config.js').ErrorRecordingConfig} errorRecordingConfig
 */
function recordThrownException(span, err, errorRecordingConfig) {
  try {
    if (errorRecordingConfig.mode === 'none') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      return;
    }

    if (errorRecordingConfig.mode === 'normalized') {
      const exceptionType = String(err?.code ?? err?.name ?? 'Error').slice(0, MAX_ERROR_CLASS_LENGTH);
      const attrs = { 'exception.type': exceptionType };

      // err == null (a thrown `null`/`undefined`) has nothing for
      // normalizeException()/coerceError() to coerce a real message out
      // of — the same edge case computeFingerprint() guards against
      // before ever calling coerceError(). Skip straight to "type only,"
      // matching this branch's own pre-consolidation behavior for that
      // case.
      if (err !== null && err !== undefined) {
        const { normalizedMessage, frames } = normalizeException(err, { cwd: process.cwd() });
        attrs['exception.message'] = normalizedMessage;
        if (frames.length > 0) {
          attrs['exception.stacktrace'] = frames
            .map((frame) => `${frame.fn || '<anonymous>'}@${frame.file}:${frame.line ?? '?'}`)
            .join('\n');
        }
        span.addEvent('exception', attrs);
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalizedMessage });
        return;
      }

      span.addEvent('exception', attrs);
      span.setStatus({ code: SpanStatusCode.ERROR });
      return;
    }

    // 'full' (default) — byte-identical to pre-v0.13.0 behavior.
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
  } catch {
    // Never throw — see this function's own docblock.
  }
}

/**
 * Wraps a tools/call handler in a span covering its execution, plus the
 * mcp.tool.* metrics (see src/metrics.js). This sits as the innermost layer
 * relative to Server's own request/response validation wrapping (see ADR
 * 001), so both the span and the duration measurement time exactly the
 * real handler logic.
 *
 * Span shape follows the MCP semantic conventions' server span (ADR 004):
 * name `{mcp.method.name} {target}` (falling back to just the method name
 * when no tool name is available), kind SERVER, and status ERROR whenever
 * error.type is set — which happens either because the handler threw, or
 * because it resolved successfully but returned a CallToolResult with
 * isError: true (a JSON-RPC-level success carrying a tool-level failure;
 * the spec calls this error.type value "tool_error", see
 * isToolResultError() above). In the isError case the result is returned
 * unchanged and nothing is thrown — the JSON-RPC call itself succeeded.
 *
 * When `fingerprintingEnabled` is true (see config.js's `fingerprinting`
 * option), both failure branches below additionally run the result/error
 * through computeFingerprint() (src/fingerprint/compose.js), attaching
 * mcp.failure.* span attributes (src/fingerprint/attributes.js) and
 * threading the resulting failure category into the mcp.tool.errors /
 * mcp.tool.silent_failures / mcp.tool.duration metrics. The same block also
 * sets mcp.failure.channel (ADR 007, docs/adr/007-protocol-error-channel.md)
 * via classifyFailureChannel() (src/fingerprint/classify/channel.js) —
 * 'execution' for the isError branch (always, since isError: true already
 * means the call succeeded at the JSON-RPC level), or one of
 * 'protocol.not_found' / 'protocol.input' / 'protocol.output' /
 * 'protocol.other' / 'unknown' for the thrown/rejected branch, which is
 * where a genuine JSON-RPC protocol error surfaces. This is deliberately a
 * plain additive span attribute, not part of computeFingerprint()'s hash
 * input — see ADR 007's "Where the new dimension lives" for why fingerprint
 * values must not change as a result.
 *
 * Trace context propagation (v0.11.0, ADR 017,
 * docs/adr/017-trace-context-propagation.md): the span's parent context is
 * extractTraceContext(request.params._meta) (src/tracecontext/extract.js),
 * not context.active() directly — when the request carries a valid W3C
 * `traceparent` in `_meta`, this span becomes a child of the CALLING
 * agent's own span, joining what would otherwise be two disconnected
 * traces into one. Unconditional, no config flag: absent or malformed
 * `_meta` resolves to context.active() unchanged, making this
 * byte-identical to the pre-v0.11.0 behavior for every call that doesn't
 * carry one.
 *
 * Cost/token attribution (see applyCostAttribution above and config.js's
 * `costTracking` option) runs in both the isError and success branches,
 * independently of fingerprinting — a tool call can carry token usage
 * whether or not it ultimately succeeded.
 *
 * Agent Thrash Detection (v0.6.0 — see applyThrashDetection() and
 * applyThrashSuccessClear() above, and config.js's `thrashDetection`
 * option) runs record() in both failure branches — the isToolResultError
 * branch (channel usually 'execution', but can recover any of the
 * 'protocol.*' values too when McpServer has disguised a protocol failure
 * as isError: true — see classifyFailureChannel()'s docblock) and the
 * thrown/rejected branch (channel one of 'protocol.not_found' /
 * 'protocol.input' / 'protocol.other' / 'unknown') — with 'protocol.output'
 * deliberately excluded from thrash tracking in BOTH branches (see each
 * branch's own comment) — and clearOnSuccess() in the success branch. Each
 * channel gets its own
 * threshold (src/thrash/detector.js's resolveThreshold()): unchanged
 * `threshold` for 'execution', a higher `inputThreshold` for
 * 'protocol.input' (an agent retrying with different arguments may be
 * converging), a lower `notFoundThreshold` for 'protocol.not_found'
 * (retrying a nonexistent tool is never convergence).
 *
 * ToolOutcome bookkeeping (ADR 008 "Update" — see applyToolOutcomeResult()/
 * applyToolOutcomeThrown() below) runs unconditionally in every branch —
 * the resolved-result branch (covering both isError and success, since
 * ToolOutcomeCounter.recordResult() does its own isError check
 * internally) and the thrown/rejected branch — independent of
 * `fingerprintingEnabled`, `thrashConfig`, `costTracking`, or
 * `metricsRecorder` being null. This is deliberate: see
 * ToolOutcomeCounter's own docblock for why it must never be gated
 * behind any of those flags.
 *
 * @param {Function} handler
 * @param {import('@opentelemetry/api').Tracer} tracer
 * @param {ReturnType<import('./metrics.js').setupMeter> | null} metricsRecorder
 * @param {boolean} fingerprintingEnabled
 * @param {import('./config.js').CostTrackingOptions} costTracking
 * @param {ReturnType<import('./cost/budget.js').createBudgetTracker>} budgetTracker
 * @param {import('./thrash/config.js').ThrashConfig} thrashConfig
 * @param {ThrashDetector} thrashDetector
 * @param {ReturnType<typeof createThrashEmitter> | null} thrashEmitter
 * @param {string} thrashConnectionFallbackSessionId
 * @param {{ hasSeenRealSessionId: boolean, hasWarnedFallbackUsed: boolean }} thrashSessionState
 * @param {ToolOutcomeCounter} toolOutcomeCounter
 * @param {*} server - Passed through only for isSingleConnectionTransport()'s server.transport check.
 * @param {'v1' | 'v2'} kind - ADR 015 Phase 2: which SDK `server` came from, resolved once by
 *   detectServerKind() at instrument time — determines how `sessionId`/`requestId` are read off
 *   the handler's second argument (`extra` for v1, `ctx` for v2 — see extractSessionAndRequestId()).
 * @param {import('./error-recording/config.js').ErrorRecordingConfig} errorRecordingConfig - ADR 019 Part 1
 *   (v0.13.0): controls what the thrown-exception branch below puts on the span — see
 *   recordThrownException()'s own docblock.
 * @param {{ warnedRejectedModel: boolean }} costAttributionState - ADR 019 Part 2 (v0.13.0): threaded
 *   through to applyCostAttribution() — see that function's own docblock and warnRejectedModel()'s.
 */
function wrapToolCallHandler(
  handler,
  tracer,
  metricsRecorder,
  fingerprintingEnabled,
  costTracking,
  budgetTracker,
  thrashConfig,
  thrashDetector,
  thrashEmitter,
  thrashConnectionFallbackSessionId,
  thrashSessionState,
  toolOutcomeCounter,
  server,
  kind,
  errorRecordingConfig,
  costAttributionState,
) {
  return (request, extra) => {
    const toolName = request?.params?.name;
    const spanName = toolName ? `${TOOLS_CALL_METHOD} ${toolName}` : TOOLS_CALL_METHOD;
    // ADR 017 (docs/adr/017-trace-context-propagation.md): request.params._meta
    // is the same shape on both SDKs (unlike sessionId/requestId below, no
    // `kind` branching needed — confirmed against both installed SDKs'
    // schemas). Absent/malformed _meta resolves to context.active()
    // unchanged, making this call byte-identical to the pre-v0.11.0
    // 3-arg startActiveSpan() call it replaces.
    const parentContext = extractTraceContext(request?.params?._meta);

    return tracer.startActiveSpan(spanName, { kind: SpanKind.SERVER }, parentContext, async (span) => {
      const argumentCount = Object.keys(request?.params?.arguments ?? {}).length;
      // ADR 015 Finding 3/7: v2's ctx.sessionId is the direct equivalent of
      // v1's extra.sessionId — still optional, still undefined for
      // transports with no session concept (stdio in v1; the
      // PerRequestHTTPServerTransport createMcpHandler builds internally
      // for v2's default stateless HTTP deployment — the SAME "no session"
      // case this package's fallback logic below already handles, not a
      // new one). requestId comes from extra.requestId (v1) or
      // ctx.mcpReq.id (v2, ADR 015 Finding 7 — always present in v2, but
      // the presence guard below is kept unconditionally for both kinds
      // rather than special-cased away, since a defensive guard costs
      // nothing and a non-optional field trivially passes it anyway).
      const { sessionId, requestId } = extractSessionAndRequestId(kind, extra);
      // Thrash detection needs a session-shaped key even on transports
      // with no real session (stdio) — but unlike budget tracking above,
      // it must NOT silently merge concurrent, unidentified HTTP/SSE
      // clients into one shared key. See resolveThrashSessionId()'s
      // docblock for the exact rules; null means "skip detection for
      // this call entirely," checked at each call site below.
      const thrashSessionId = resolveThrashSessionId(
        server,
        sessionId,
        thrashSessionState,
        thrashConnectionFallbackSessionId,
        thrashConfig,
        kind,
        parentContext,
      );

      span.setAttribute(ATTR_MCP_METHOD_NAME, TOOLS_CALL_METHOD);
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_EXECUTE_TOOL);
      span.setAttribute(ATTR_GEN_AI_TOOL_NAME, toolName);
      span.setAttribute(ATTR_MCP_TOOL_ARGUMENT_COUNT, argumentCount);
      if (requestId !== undefined && requestId !== null) {
        span.setAttribute(ATTR_JSONRPC_REQUEST_ID, String(requestId));
      }

      metricsRecorder?.recordCall(toolName);
      const startTime = performance.now();
      const cwd = process.cwd();

      try {
        const result = await handler(request, extra);
        applyToolOutcomeResult(toolOutcomeCounter, result);
        if (isToolResultError(result)) {
          span.setAttribute(ATTR_ERROR_TYPE, ERROR_TYPE_TOOL_ERROR);
          span.setStatus({ code: SpanStatusCode.ERROR });

          let failureCategory = '';
          let failure = null;
          let channel;
          if (fingerprintingEnabled) {
            failure = computeFingerprint(result, { toolName, origin: 'tool_error', cwd });
            span.setAttributes(toSpanAttributes(failure));
            failureCategory = failure.category;
            // ADR 007's channel dimension, additive and independent of the
            // fingerprint hash (see fingerprint/attributes.js's
            // ATTRIBUTE_KEYS.CHANNEL docblock). NOT always 'execution'
            // here: McpServer (@modelcontextprotocol/sdk/server/mcp.js)
            // catches nearly every protocol-shaped failure itself (tool
            // not found, disabled, input/output validation) and converts
            // it to isError: true before this ever runs — but it preserves
            // the original McpError's message verbatim, so
            // classifyFailureChannel() recovers the real channel from that
            // text instead of collapsing every one of those cases into
            // 'execution' (see channel.js's docblock; confirmed against a
            // real McpServer during Phase 3 verification).
            channel = classifyFailureChannel(result);
            span.setAttribute(ATTRIBUTE_KEYS.CHANNEL, channel);
            // ADR 009's diagnostic attribute: which schema field(s) a
            // validation failure named, best-effort extracted from the
            // same message text. Omitted entirely (never set to `[]`)
            // when nothing confidently parseable was found — see
            // validation-paths.js's docblock.
            const validationPaths = extractValidationPaths(result);
            if (validationPaths.length > 0) {
              span.setAttribute(ATTRIBUTE_KEYS.VALIDATION_PATHS, validationPaths);
            }
          }
          const usage = applyCostAttribution(
            span,
            metricsRecorder,
            toolName,
            sessionId,
            result,
            costTracking,
            budgetTracker,
            costAttributionState,
          );
          // ADR 007: a 'protocol.output' failure recovered above (a
          // McpServer-disguised output-schema bug) must not be counted as
          // thrash here either, same as the thrown branch below —
          // ThrashDetector.record() also refuses it as defense in depth,
          // but skipping the call entirely keeps both branches' policy
          // visibly identical.
          if (thrashSessionId !== null && channel !== 'protocol.output') {
            applyThrashDetection(
              span,
              thrashConfig,
              thrashDetector,
              thrashEmitter,
              thrashSessionId,
              toolName,
              failure?.fingerprint,
              usage,
              channel,
            );
          }
          metricsRecorder?.recordSilentFailure(toolName, failureCategory);
          metricsRecorder?.recordDuration(
            toolName,
            performance.now() - startTime,
            MCP_TOOL_OUTCOME_SILENT_FAILURE,
            failureCategory,
          );
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
          applyCostAttribution(span, metricsRecorder, toolName, sessionId, result, costTracking, budgetTracker, costAttributionState);
          if (thrashSessionId !== null) {
            applyThrashSuccessClear(thrashConfig, thrashDetector, thrashSessionId, toolName);
          }
          metricsRecorder?.recordDuration(toolName, performance.now() - startTime, MCP_TOOL_OUTCOME_SUCCESS);
        }
        return result;
      } catch (err) {
        applyToolOutcomeThrown(toolOutcomeCounter);
        recordThrownException(span, err, errorRecordingConfig);
        // ADR 019 Part 1: capped at MAX_ERROR_CLASS_LENGTH unconditionally,
        // regardless of errorRecordingConfig.mode — a length cap on a
        // class-identifier field costs a well-behaved tool nothing, so
        // there's no default-behavior tension to gate it behind (contrast
        // recordThrownException()'s own mode branching, which does gate
        // message/stacktrace CONTENT). Same coercion compose.js's
        // errorClass applies (a non-string .name is stringified, not
        // thrown on) — see fingerprint/compose.js's rawErrorClass.
        const errorType = String(err?.name ?? 'Error').slice(0, MAX_ERROR_CLASS_LENGTH);
        span.setAttribute(ATTR_ERROR_TYPE, errorType);

        let failureCategory = '';
        let failure = null;
        let channel;
        if (fingerprintingEnabled) {
          failure = computeFingerprint(err, { toolName, origin: 'thrown', cwd });
          span.setAttributes(toSpanAttributes(failure));
          failureCategory = failure.category;
          // ADR 007's channel dimension — this is the protocol-error path:
          // a JSON-RPC error response (the thrown/rejected err reaching
          // this catch), sub-classified by classifyFailureChannel() into
          // 'protocol.not_found' / 'protocol.input' / 'protocol.output' /
          // 'protocol.other', or 'unknown' when err doesn't resemble a
          // JSON-RPC error shape at all (e.g. an unrelated handler bug).
          channel = classifyFailureChannel(err);
          span.setAttribute(ATTRIBUTE_KEYS.CHANNEL, channel);
          // ADR 009's diagnostic attribute — see the isError branch above
          // for the full comment; same best-effort extraction, same
          // omit-rather-than-guess behavior.
          const validationPaths = extractValidationPaths(err);
          if (validationPaths.length > 0) {
            span.setAttribute(ATTRIBUTE_KEYS.VALIDATION_PATHS, validationPaths);
          }
        }
        // ADR 007, Phase 3: this is the only place a genuine protocol-error
        // failure can reach thrash detection (the isError branch above is
        // always 'execution'). 'protocol.output' is deliberately excluded
        // here — a server-side output-schema bug is never agent thrash, no
        // matter how many times it repeats (see resolveThreshold()'s
        // docblock in src/thrash/detector.js). No token/cost usage exists
        // for a thrown error (there's no CallToolResult to extract it
        // from), so usage is always null here.
        if (thrashSessionId !== null && channel !== 'protocol.output') {
          applyThrashDetection(
            span,
            thrashConfig,
            thrashDetector,
            thrashEmitter,
            thrashSessionId,
            toolName,
            failure?.fingerprint,
            null,
            channel,
          );
        }
        metricsRecorder?.recordError(toolName, errorType, failureCategory);
        metricsRecorder?.recordDuration(toolName, performance.now() - startTime, MCP_TOOL_OUTCOME_ERROR, failureCategory);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Wraps a tools/list handler in a span covering its execution (ADR 010,
 * docs/adr/010-schema-drift.md — Phase 4: wiring). Same span-lifecycle
 * shape as wrapToolCallHandler above (tracer.startActiveSpan(), try/
 * finally around span.end()), but scoped to what ADR 010 actually decided
 * for tools/list: one span per call, named just TOOLS_LIST_METHOD — no
 * per-tool-name suffix, since one tools/list response covers every tool
 * at once, unlike one tools/call covering exactly one.
 *
 * After the original handler resolves, every tool in its response is run
 * through schemaDriftDetector.capture() (src/schema-drift/detector.js,
 * Phase 2); any returned SchemaDriftEvent is handed to
 * schemaDriftEmitter.emit() (src/schema-drift/emitter.js, Phase 3). No
 * detection or emission logic lives here — this function is purely the
 * wiring ADR 010's Q2 identified as a direct, unmodified extension of ADR
 * 001's patching strategy, the same conclusion this file's own tools/call
 * wrapping branch (`instrumentMcpServer()`'s `setRequestHandler` patch,
 * split by `kind` since ADR 015 Phase 2 — v1's schema-identity check or
 * v2's method-string check, same idea either way) already applies.
 *
 * The capture/detect/emit block is its own try/catch, entirely separate
 * from the outer try/catch guarding the underlying handler's own success/
 * failure: a bug in schema-drift's own code must never affect the real
 * tools/list response the client receives, but a genuine failure from the
 * underlying handler itself must still propagate normally, unmodified —
 * the same defense-in-depth split applyThrashDetection() already keeps
 * relative to wrapToolCallHandler's success/failure branches above.
 *
 * @param {Function} handler - Original tools/list handler.
 * @param {import('@opentelemetry/api').Tracer} tracer
 * @param {SchemaDriftDetector} schemaDriftDetector
 * @param {ReturnType<typeof createSchemaDriftEmitter> | null} schemaDriftEmitter
 * @param {string} schemaDriftScope - Fixed per instrumented server instance — see instrumentMcpServer().
 * @param {'v1' | 'v2'} kind - ADR 015 Phase 2: see wrapToolCallHandler's own `kind` param and
 *   extractSessionAndRequestId() — same requestId-only extraction, no sessionId use here.
 * @param {import('./error-recording/config.js').ErrorRecordingConfig} errorRecordingConfig - ADR 019 Part 1
 *   (v0.13.0): see wrapToolCallHandler's own param and recordThrownException()'s docblock. The thrown-
 *   exception branch below is the only place this handler's own JS Error content reaches a span; a
 *   schema-drift capture failure (caught separately just above) is diag.debug()-only and never reaches
 *   the span at all, so it's unaffected by this option.
 */
function wrapToolsListHandler(handler, tracer, schemaDriftDetector, schemaDriftEmitter, schemaDriftScope, kind, errorRecordingConfig) {
  return (request, extra) => {
    return tracer.startActiveSpan(TOOLS_LIST_METHOD, { kind: SpanKind.SERVER }, async (span) => {
      span.setAttribute(ATTR_MCP_METHOD_NAME, TOOLS_LIST_METHOD);
      const { requestId } = extractSessionAndRequestId(kind, extra);
      if (requestId !== undefined && requestId !== null) {
        span.setAttribute(ATTR_JSONRPC_REQUEST_ID, String(requestId));
      }

      try {
        const result = await handler(request, extra);

        try {
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          for (const tool of tools) {
            const event = schemaDriftDetector.capture(schemaDriftScope, tool);
            if (event) {
              schemaDriftEmitter?.emit(event);
            }
          }
        } catch (err) {
          diag.debug(
            'opentel-mcp: schema drift capture failed, skipping mcp.tool.schema_drift.* telemetry for this tools/list call',
            err,
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        recordThrownException(span, err, errorRecordingConfig);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
