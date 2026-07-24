/**
 * @module instrument
 */

import { createRequire } from 'node:module';
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { resolveOptions } from './config.js';
import { StderrSpanExporter } from './exporters/stderr.js';
import { setupMeter } from './metrics.js';
import { computeFingerprint } from './fingerprint/compose.js';
import { toSpanAttributes } from './fingerprint/attributes.js';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_MCP_TOOL_ARGUMENT_COUNT,
  ATTR_ERROR_TYPE,
  ERROR_TYPE_TOOL_ERROR,
  GEN_AI_OPERATION_NAME_EXECUTE_TOOL,
  MCP_METHOD_NAME_TOOLS_CALL,
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
 *   registered it.
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

  assertInstrumentFirst(server);

  const tracer = setupTracer(server, resolved);
  const metricsRecorder = resolved.enableMetrics ? setupMeter(PACKAGE_VERSION) : null;
  if (outer && server.shutdown) {
    outer.shutdown = server.shutdown;
  }

  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) => {
    if (schema === CallToolRequestSchema) {
      handler = wrapToolCallHandler(handler, tracer, metricsRecorder, resolved.fingerprinting);
    }
    return originalSetRequestHandler(schema, handler);
  };

  server[kInstrumented] = true;
  if (outer) outer[kInstrumented] = true;
  return input;
}

/**
 * Throws INSTRUMENT_FIRST_ERROR if a tools/call handler is already
 * registered on `server`. Uses the SDK's own public
 * assertCanSetRequestHandler(method) — the same check McpServer uses
 * internally — rather than reaching into the private _requestHandlers Map.
 * Feature-detected so a future SDK version that removes this method
 * degrades to relying on docs + the idempotency guard alone (see ADR 002).
 * Works identically whether `server` came from a low-level Server or was
 * unwrapped from an McpServer, since McpServer's .tool()/.registerTool()
 * lazily call this same server's setRequestHandler(CallToolRequestSchema)
 * on first registration.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server
 */
function assertInstrumentFirst(server) {
  if (typeof server.assertCanSetRequestHandler !== 'function') {
    return;
  }
  try {
    server.assertCanSetRequestHandler(TOOLS_CALL_METHOD);
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
 * mcp.tool.silent_failures / mcp.tool.duration metrics.
 *
 * @param {Function} handler
 * @param {import('@opentelemetry/api').Tracer} tracer
 * @param {ReturnType<import('./metrics.js').setupMeter> | null} metricsRecorder
 * @param {boolean} fingerprintingEnabled
 */
function wrapToolCallHandler(handler, tracer, metricsRecorder, fingerprintingEnabled) {
  return (request, extra) => {
    const toolName = request?.params?.name;
    const spanName = toolName ? `${TOOLS_CALL_METHOD} ${toolName}` : TOOLS_CALL_METHOD;

    return tracer.startActiveSpan(spanName, { kind: SpanKind.SERVER }, async (span) => {
      const argumentCount = Object.keys(request?.params?.arguments ?? {}).length;

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
          if (fingerprintingEnabled) {
            const failure = computeFingerprint(result, { toolName, origin: 'tool_error', cwd });
            span.setAttributes(toSpanAttributes(failure));
            failureCategory = failure.category;
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
          metricsRecorder?.recordDuration(toolName, performance.now() - startTime, MCP_TOOL_OUTCOME_SUCCESS);
        }
        return result;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        const errorType = err?.name ?? 'Error';
        span.setAttribute(ATTR_ERROR_TYPE, errorType);

        let failureCategory = '';
        if (fingerprintingEnabled) {
          const failure = computeFingerprint(err, { toolName, origin: 'thrown', cwd });
          span.setAttributes(toSpanAttributes(failure));
          failureCategory = failure.category;
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
