/**
 * @module instrument
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { trace, diag, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { resolveOptions } from './config.js';
import { StderrSpanExporter } from './exporters/stderr.js';
import { setupMeter } from './metrics.js';
import { computeFingerprint } from './fingerprint/compose.js';
import { toSpanAttributes, ATTRIBUTE_KEYS } from './fingerprint/attributes.js';
import { classifyFailureChannel } from './fingerprint/classify/channel.js';
import { extractValidationPaths } from './fingerprint/classify/validation-paths.js';
import { calculateCost } from './cost/calculator.js';
import { createBudgetTracker } from './cost/budget.js';
import { ThrashDetector } from './thrash/detector.js';
import { createThrashEmitter } from './thrash/emitter.js';
import { SchemaDriftDetector } from './schema-drift/detector.js';
import { createSchemaDriftEmitter } from './schema-drift/emitter.js';
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

const UNSUPPORTED_INPUT_ERROR =
  'opentel-mcp: instrumentMcpServer() expects either a low-level Server ' +
  'instance (from @modelcontextprotocol/sdk/server/index.js) or a ' +
  'high-level McpServer instance (from @modelcontextprotocol/sdk/server/mcp.js).';

const INSTRUMENT_FIRST_ERROR =
  'opentel-mcp: instrumentMcpServer() must be called BEFORE registering ' +
  'tool handlers. Move instrumentMcpServer(server, options) to immediately ' +
  'after `new Server(...)`, before any ' +
  'server.setRequestHandler(CallToolRequestSchema, ...) calls (low-level ' +
  'Server) or .tool()/.registerTool() calls (McpServer).';

/**
 * Detects whether `input` is a low-level Server or a high-level McpServer,
 * without importing McpServer directly. Importing it would risk the same
 * dual-package-hazard class of bug the hello-server example hit (two
 * independently-installed copies of @modelcontextprotocol/sdk producing
 * two distinct classes, so `instanceof` silently fails) — duck-typing
 * sidesteps that and stays tolerant of SDK versions that shuffle McpServer's
 * internals, since only its public, documented shape is checked: a `.server`
 * object that itself looks like a low-level Server (has a `setRequestHandler`
 * function), plus a `.tool` or `.registerTool` function on the outer object.
 * The low-level Server case still uses `instanceof` since Server is already
 * imported directly for other purposes (ADR 001).
 *
 * @param {unknown} input
 * @returns {{ server: object, outer?: object } | null}
 */
function detectServerKind(input) {
  if (input instanceof Server) {
    return { server: input };
  }
  if (
    input &&
    typeof input === 'object' &&
    input.server &&
    typeof input.server.setRequestHandler === 'function' &&
    (typeof input.tool === 'function' || typeof input.registerTool === 'function')
  ) {
    return { server: input.server, outer: input };
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
 *   `ThrashDetector.getSummary()`'s in-process summary; both are omitted
 *   when `options.enabled` is `false`, since nothing is instrumented at
 *   all in that case.
 */
export function instrumentMcpServer(input, options) {
  const detected = detectServerKind(input);
  if (!detected) {
    throw new Error(UNSUPPORTED_INPUT_ERROR);
  }

  const { server, outer } = detected;

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
  const budgetTracker = createBudgetTracker(resolved.costTracking.budget);
  // Same one-per-server lifetime as budgetTracker above — thrash episodes
  // accumulate across calls, not within one (see src/thrash/detector.js).
  // Constructed unconditionally, same as budgetTracker: resolved.thrashDetection.enabled
  // gates per-call work (applyThrashDetection/applyThrashSuccessClear
  // below), not this one-time setup.
  const thrashDetector = new ThrashDetector(resolved.thrashDetection);
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
  const thrashConnectionFallbackSessionId = randomUUID();
  // Mutable per-server flag, not a `let` closed over directly: wrapToolCallHandler
  // is a top-level function taking all its state as parameters (see its
  // existing params), not a closure over instrumentMcpServer()'s locals —
  // this holder preserves that pattern while still letting
  // resolveThrashSessionId() persist state across calls. See that
  // function's docblock for why this flag exists at all.
  const thrashSessionState = { hasSeenRealSessionId: false, hasWarnedFallbackUsed: false };
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
  // independent of metrics on/off, only emission is gated.
  const schemaDriftDetector = resolved.schemaDrift.enabled
    ? new SchemaDriftDetector({ maxTrackedTools: resolved.schemaDrift.maxTrackedTools })
    : null;
  const schemaDriftEmitter =
    resolved.schemaDrift.enabled && resolved.enableMetrics ? createSchemaDriftEmitter(PACKAGE_VERSION) : null;

  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) => {
    if (schema === CallToolRequestSchema) {
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
        server,
      );
    } else if (schema === ListToolsRequestSchema && schemaDriftDetector) {
      handler = wrapToolsListHandler(handler, tracer, schemaDriftDetector, schemaDriftEmitter, SCHEMA_DRIFT_SCOPE);
    }
    return originalSetRequestHandler(schema, handler);
  };

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

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': resolved.serviceName }),
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
 * *and* budget attribution — the token attributes still land.
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
 * @param {import('@opentelemetry/api').Span} span
 * @param {ReturnType<import('./metrics.js').setupMeter> | null} metricsRecorder
 * @param {string | undefined} toolName
 * @param {string | undefined} sessionId
 * @param {*} result
 * @param {import('./config.js').CostTrackingOptions} costTracking
 * @param {ReturnType<import('./cost/budget.js').createBudgetTracker>} budgetTracker
 * @returns {{ tokensIn: number, tokensOut: number, costUsd: number } | null}
 */
function applyCostAttribution(span, metricsRecorder, toolName, sessionId, result, costTracking, budgetTracker) {
  if (!costTracking.enabled) return null;

  try {
    const usage = costTracking.extractor(result);
    if (!usage) return null;

    span.setAttribute(ATTR_MCP_TOOL_TOKENS_INPUT, usage.inputTokens);
    span.setAttribute(ATTR_MCP_TOOL_TOKENS_OUTPUT, usage.outputTokens);
    span.setAttribute(ATTR_MCP_TOOL_TOKENS_TOTAL, usage.totalTokens);
    if (usage.model) {
      span.setAttribute(ATTR_MCP_TOOL_MODEL, usage.model);
      span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, usage.model);
    }
    metricsRecorder?.recordTokens(toolName, usage.model, usage.totalTokens);

    let costUsd = null;
    if (usage.model) {
      costUsd = calculateCost(usage.inputTokens, usage.outputTokens, usage.model, costTracking.pricingTable);
      if (costUsd !== null) {
        span.setAttribute(ATTR_MCP_TOOL_COST_USD, costUsd);
        span.setAttribute(ATTR_MCP_TOOL_COST_CURRENCY, MCP_TOOL_COST_CURRENCY_USD);
        metricsRecorder?.recordCost(toolName, usage.model, costUsd);

        const budgetResult = budgetTracker.recordAndCheck(sessionId, toolName, costUsd);
        if (budgetResult.exceeded) {
          span.setAttribute(ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED, true);
          span.setAttribute(ATTR_MCP_TOOL_COST_BUDGET_SCOPE, budgetResult.scope);
        }
      }
    }

    return { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: costUsd ?? 0 };
  } catch (err) {
    diag.debug('opentel-mcp: cost attribution failed, skipping mcp.tool.tokens.*/mcp.tool.cost.* attributes', err);
    return null;
  }
}

/**
 * True only when `server.transport` is connected and its shape reliably
 * indicates a single-connection transport — i.e. it has no `sessionId`
 * property at all. Both session-oriented transports the SDK ships,
 * StreamableHTTPServerTransport and SSEServerTransport, expose a public
 * `sessionId` getter (see @modelcontextprotocol/sdk's
 * server/{streamableHttp,sse}.d.ts); StdioServerTransport does not (see
 * server/stdio.d.ts). Checked structurally rather than `instanceof
 * StdioServerTransport` for the same dual-package-hazard reason
 * detectServerKind() above avoids importing McpServer directly (ADR 001).
 *
 * Returns false — "not reliably single-connection" — whenever
 * `server.transport` is undefined too. That's the common case here: the
 * SDK only populates it after `server.connect(transport)` runs, which
 * happens *after* `instrumentMcpServer()` in normal startup order (see
 * the README's "Ordering constraint"), and this repo's own test harness
 * (`invokeToolCall()` in the test files) never calls `.connect()` at all —
 * it always invokes the registered handler directly. A transport that
 * can't be determined is never assumed to be single-connection; see
 * `thrashDetection.assumeSingleSession` (config.js) for the explicit
 * opt-in that covers this case.
 *
 * @param {*} server
 * @returns {boolean}
 */
function isSingleConnectionTransport(server) {
  const transport = server?.transport;
  return Boolean(transport) && !('sessionId' in transport);
}

/**
 * Identifies which of the three conditions let resolveThrashSessionId()
 * below fall back to the generated per-connection session id, for the
 * one-time diag.warn() it fires the first time that actually happens (see
 * thrashSessionState.hasWarnedFallbackUsed there). Each implies a
 * different amount of risk if the single-connection assumption turns out
 * to be wrong:
 *
 *   - Transport structurally detected as single-connection (no `sessionId`
 *     property — e.g. stdio): the safest case, backed by evidence.
 *   - `assumeSingleSession: true` overriding a transport that IS connected
 *      and DOES expose its own `sessionId` (i.e. isSingleConnectionTransport()
 *      returned false because the transport looks session-oriented): the
 *      riskiest case — the operator is contradicting available evidence.
 *   - `assumeSingleSession: true` with the transport simply not yet
 *     connected/undeterminable: no contradicting evidence, just unproven.
 *
 * @param {*} server
 * @returns {'single-connection transport detected' | 'assumeSingleSession: true' | 'transport undeterminable, opted in via assumeSingleSession: true'}
 */
function describeFallbackReason(server) {
  if (isSingleConnectionTransport(server)) {
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
 *   3. Before any real sessionId has ever been observed: the generated
 *      per-connection fallback (`thrashConnectionFallbackSessionId`) is
 *      used when `thrashConfig.assumeSingleSession` is true, or when
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
 * @returns {string | null}
 */
function resolveThrashSessionId(server, sessionId, thrashSessionState, thrashConnectionFallbackSessionId, thrashConfig) {
  if (sessionId !== undefined) {
    thrashSessionState.hasSeenRealSessionId = true;
    return sessionId;
  }

  if (thrashSessionState.hasSeenRealSessionId) {
    return null;
  }

  if (thrashConfig.assumeSingleSession || isSingleConnectionTransport(server)) {
    if (!thrashSessionState.hasWarnedFallbackUsed) {
      thrashSessionState.hasWarnedFallbackUsed = true;
      diag.warn(
        'opentel-mcp: Agent Thrash Detection is using a generated fallback session id ' +
          `(reason: ${describeFallbackReason(server)}). If this transport is in fact serving multiple ` +
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
 * @param {*} server - Passed through only for isSingleConnectionTransport()'s server.transport check.
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
  server,
) {
  return (request, extra) => {
    const toolName = request?.params?.name;
    const spanName = toolName ? `${TOOLS_CALL_METHOD} ${toolName}` : TOOLS_CALL_METHOD;

    return tracer.startActiveSpan(spanName, { kind: SpanKind.SERVER }, async (span) => {
      const argumentCount = Object.keys(request?.params?.arguments ?? {}).length;
      // Transport-provided session id (undefined for stdio, which has no
      // notion of a session) — see the sessionId param on the SDK's
      // RequestHandlerExtra type. Only consumed by applyCostAttribution's
      // per-session budget tracking (src/cost/budget.js); everything else
      // in this function already worked without it.
      const sessionId = extra?.sessionId;
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
      );

      span.setAttribute(ATTR_MCP_METHOD_NAME, TOOLS_CALL_METHOD);
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_EXECUTE_TOOL);
      span.setAttribute(ATTR_GEN_AI_TOOL_NAME, toolName);
      span.setAttribute(ATTR_MCP_TOOL_ARGUMENT_COUNT, argumentCount);
      if (extra?.requestId !== undefined && extra?.requestId !== null) {
        span.setAttribute(ATTR_JSONRPC_REQUEST_ID, String(extra.requestId));
      }

      metricsRecorder?.recordCall(toolName);
      const startTime = performance.now();
      const cwd = process.cwd();

      try {
        const result = await handler(request, extra);
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
          const usage = applyCostAttribution(span, metricsRecorder, toolName, sessionId, result, costTracking, budgetTracker);
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
          applyCostAttribution(span, metricsRecorder, toolName, sessionId, result, costTracking, budgetTracker);
          if (thrashSessionId !== null) {
            applyThrashSuccessClear(thrashConfig, thrashDetector, thrashSessionId, toolName);
          }
          metricsRecorder?.recordDuration(toolName, performance.now() - startTime, MCP_TOOL_OUTCOME_SUCCESS);
        }
        return result;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        const errorType = err?.name ?? 'Error';
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
 * 001's patching strategy, the same conclusion this file's own
 * `if (schema === CallToolRequestSchema)` branch already applies.
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
 */
function wrapToolsListHandler(handler, tracer, schemaDriftDetector, schemaDriftEmitter, schemaDriftScope) {
  return (request, extra) => {
    return tracer.startActiveSpan(TOOLS_LIST_METHOD, { kind: SpanKind.SERVER }, async (span) => {
      span.setAttribute(ATTR_MCP_METHOD_NAME, TOOLS_LIST_METHOD);
      if (extra?.requestId !== undefined && extra?.requestId !== null) {
        span.setAttribute(ATTR_JSONRPC_REQUEST_ID, String(extra.requestId));
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
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
