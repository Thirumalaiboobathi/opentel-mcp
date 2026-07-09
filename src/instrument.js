/**
 * @module instrument
 */

import { createRequire } from 'node:module';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { resolveOptions } from './config.js';
import { StderrSpanExporter } from './exporters/stderr.js';
import {
  ATTR_MCP_TOOL_NAME,
  ATTR_MCP_REQUEST_ID,
  ATTR_MCP_TOOL_ARGUMENT_COUNT,
  ATTR_MCP_TOOL_STATUS,
  ATTR_MCP_TOOL_ERROR_TYPE,
  ATTR_MCP_TOOL_ERROR_MESSAGE,
  MCP_TOOL_STATUS,
  MCP_TOOL_CALL_SPAN_NAME,
} from './attributes.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');

// Protocol-level JSON-RPC method name. Deliberately hardcoded rather than
// derived from CallToolRequestSchema's zod internals — see ADR 001.
const TOOLS_CALL_METHOD = 'tools/call';

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
  if (outer && server.shutdown) {
    outer.shutdown = server.shutdown;
  }

  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) => {
    if (schema === CallToolRequestSchema) {
      handler = wrapToolCallHandler(handler, tracer);
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
 * Wraps a tools/call handler in a span covering its execution. This sits as
 * the innermost layer relative to Server's own request/response validation
 * wrapping (see ADR 001), so the span times exactly the real handler logic.
 *
 * @param {Function} handler
 * @param {import('@opentelemetry/api').Tracer} tracer
 */
function wrapToolCallHandler(handler, tracer) {
  return (request, extra) =>
    tracer.startActiveSpan(MCP_TOOL_CALL_SPAN_NAME, async (span) => {
      const toolName = request?.params?.name;
      const argumentCount = Object.keys(request?.params?.arguments ?? {}).length;

      span.setAttribute(ATTR_MCP_TOOL_NAME, toolName);
      span.setAttribute(ATTR_MCP_TOOL_ARGUMENT_COUNT, argumentCount);
      if (extra?.requestId !== undefined) {
        span.setAttribute(ATTR_MCP_REQUEST_ID, String(extra.requestId));
      }

      try {
        const result = await handler(request, extra);
        span.setAttribute(ATTR_MCP_TOOL_STATUS, MCP_TOOL_STATUS.OK);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        span.setAttribute(ATTR_MCP_TOOL_STATUS, MCP_TOOL_STATUS.ERROR);
        span.setAttribute(ATTR_MCP_TOOL_ERROR_TYPE, err?.name ?? 'Error');
        span.setAttribute(ATTR_MCP_TOOL_ERROR_MESSAGE, err?.message ?? String(err));
        throw err;
      } finally {
        span.end();
      }
    });
}
