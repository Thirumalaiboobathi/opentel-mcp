/**
 * @module config
 * Options parsing and defaults for instrumentMcpServer().
 */

import { diag } from '@opentelemetry/api';

/**
 * @typedef {object} InstrumentOptions
 * @property {string} [serviceName] - Names the resource of the NodeTracerProvider this library creates.
 *   Required (and must be a non-empty string) when `setupNodeSdk` is true. Has no effect when `setupNodeSdk`
 *   is false or omitted — in that mode, resource attributes (including `service.name`) come from whatever
 *   TracerProvider the host application has already registered; passing `serviceName` anyway is harmless but
 *   logs a one-time `diag.warn`.
 * @property {string} [exporterUrl] - OTLP/HTTP traces endpoint (e.g. 'http://localhost:4318/v1/traces').
 *   Only takes effect when `setupNodeSdk` is true.
 * @property {boolean} [enabled=true] - Set to false to disable instrumentation entirely; instrumentMcpServer()
 *   becomes a no-op.
 * @property {boolean} [setupNodeSdk=false] - When true, instrumentMcpServer() creates and registers its own
 *   NodeTracerProvider (always exporting to stderr — safe alongside stdio-transport MCP servers, see ADR 003;
 *   additionally to `exporterUrl` via OTLP/HTTP if set). When false (the default), spans are emitted via
 *   whatever OpenTelemetry TracerProvider the host application
 *   has already registered globally — or dropped silently if none has been registered. This default keeps
 *   instrumentMcpServer() from ever overriding a host application's own OpenTelemetry setup.
 */

// Guards the "serviceName has no effect" diagnostic below so it fires once
// per process rather than once per instrumented server.
let warnedServiceNameIgnored = false;

// Test-only: lets test/instrument.test.js get a clean slate for the
// once-per-process warning above regardless of what earlier tests in the
// same file already triggered. Not part of the public API.
export function __resetServiceNameWarnedForTests() {
  warnedServiceNameIgnored = false;
}

/**
 * Validates and applies defaults to raw instrumentMcpServer() options.
 *
 * @param {InstrumentOptions} [options]
 * @returns {Required<InstrumentOptions>}
 */
export function resolveOptions(options) {
  const opts = options ?? {};
  const setupNodeSdk = opts.setupNodeSdk ?? false;
  const hasServiceName = typeof opts.serviceName === 'string' && opts.serviceName.trim() !== '';

  if (setupNodeSdk && !hasServiceName) {
    throw new Error(
      'opentel-mcp: options.serviceName is required when setupNodeSdk is true ' +
        '(it names the resource of the tracer provider this library creates). ' +
        "It is not needed otherwise — the host application's registered provider owns the resource.",
    );
  }

  if (!setupNodeSdk && hasServiceName && !warnedServiceNameIgnored) {
    warnedServiceNameIgnored = true;
    diag.warn(
      'opentel-mcp: serviceName was provided but setupNodeSdk is false, so it has no effect. ' +
        'Resource attributes (including service.name) come from the TracerProvider the host application registered.',
    );
  }

  return {
    serviceName: opts.serviceName,
    exporterUrl: opts.exporterUrl,
    enabled: opts.enabled ?? true,
    setupNodeSdk,
  };
}
