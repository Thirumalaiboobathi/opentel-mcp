/**
 * @module config
 * Options parsing and defaults for instrumentMcpServer().
 */

/**
 * @typedef {object} InstrumentOptions
 * @property {string} serviceName - Required. Identifies this server in emitted telemetry.
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

/**
 * Validates and applies defaults to raw instrumentMcpServer() options.
 *
 * @param {InstrumentOptions} [options]
 * @returns {Required<InstrumentOptions>}
 */
export function resolveOptions(options) {
  const opts = options ?? {};

  if (typeof opts.serviceName !== 'string' || opts.serviceName.trim() === '') {
    throw new Error('opentel-mcp: options.serviceName is required and must be a non-empty string.');
  }

  return {
    serviceName: opts.serviceName,
    exporterUrl: opts.exporterUrl,
    enabled: opts.enabled ?? true,
    setupNodeSdk: opts.setupNodeSdk ?? false,
  };
}
