/**
 * @module config
 * Options parsing and defaults for instrumentMcpServer().
 */

import { diag } from '@opentelemetry/api';
import { DEFAULT_PRICING } from './cost/pricing.js';
import { defaultExtractor } from './cost/extractor.js';
import { resolveThrashConfig } from './thrash/config.js';

/**
 * @typedef {object} CostTrackingOptions
 * @property {boolean} [enabled=true] - Set to false to disable cost/token span attributes and the
 *   mcp.tool.tokens.total / mcp.tool.cost.total metrics entirely.
 * @property {import('./cost/pricing.js').PricingTable} [pricingTable] - Overrides DEFAULT_PRICING
 *   (src/cost/pricing.js). Supply your own table to price models DEFAULT_PRICING doesn't know about, or to
 *   correct stale pricing — see that module's docblock.
 * @property {import('./cost/extractor.js').UsageExtractor} [extractor] - Overrides defaultExtractor
 *   (src/cost/extractor.js). Supply your own to recognize a tool result shape defaultExtractor doesn't.
 * @property {import('./cost/budget.js').BudgetConfig} [budget] - Per-session and per-tool cumulative-cost
 *   guardrails (src/cost/budget.js). Observability only — crossing a limit adds
 *   mcp.tool.cost.budget_exceeded / mcp.tool.cost.budget_scope span attributes; it never blocks or throws.
 *   Omit to disable budget tracking (the default).
 */

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
 * @property {boolean} [enableMetrics=true] - Set to false to disable the mcp.tool.* metrics (tracing is
 *   unaffected). Metrics are already a zero-overhead no-op when no MeterProvider is registered — the default
 *   @opentelemetry/api behavior — so this flag exists for opting out even when one *is* registered, not as a
 *   substitute for that default.
 * @property {boolean} [setupNodeSdk=false] - When true, instrumentMcpServer() creates and registers its own
 *   NodeTracerProvider (always exporting to stderr — safe alongside stdio-transport MCP servers, see ADR 003;
 *   additionally to `exporterUrl` via OTLP/HTTP if set). When false (the default), spans are emitted via
 *   whatever OpenTelemetry TracerProvider the host application
 *   has already registered globally — or dropped silently if none has been registered. This default keeps
 *   instrumentMcpServer() from ever overriding a host application's own OpenTelemetry setup.
 * @property {boolean} [fingerprinting=true] - Set to false to disable deep-failure fingerprinting. When enabled
 *   (the default), every thrown error and tool-level failure (isError: true) is run through
 *   src/fingerprint/compose.js's computeFingerprint(), adding mcp.failure.* span attributes and an
 *   mcp.failure.category attribute on the mcp.tool.errors / mcp.tool.silent_failures / mcp.tool.duration
 *   metrics (see src/fingerprint/attributes.js). computeFingerprint() never throws, so this only trades a
 *   small amount of per-failure CPU (see the p99 < 200µs budget in test/fingerprint/benchmark.test.js) for
 *   fingerprinting.
 * @property {CostTrackingOptions} [costTracking] - Controls the mcp.tool.tokens.* / mcp.tool.model /
 *   mcp.tool.cost.* span attributes, the mcp.tool.tokens.total / mcp.tool.cost.total metrics, and the
 *   optional per-session/per-tool budget guardrail (see instrument.js's applyCostAttribution(),
 *   src/metrics.js, and src/cost/budget.js). Defaults to `{ enabled: true, pricingTable: DEFAULT_PRICING,
 *   extractor: defaultExtractor }` with budget tracking off; any fields you omit from a partial object fall
 *   back to those defaults individually, so `{ enabled: false }` alone works.
 * @property {Partial<import('./thrash/config.js').ThrashConfig>} [thrashDetection] - Controls Agent Thrash
 *   Detection (v0.6.0): detecting when a tool is retried repeatedly with the same failure fingerprint, and
 *   attributing the wasted tokens/cost to that loop (see instrument.js's applyThrashDetection() /
 *   applyThrashSuccessClear(), src/thrash/detector.js, and src/thrash/emitter.js). Resolved via
 *   resolveThrashConfig() (src/thrash/config.js) — same partial-overrides-individual-defaults behavior as
 *   costTracking above. Requires `fingerprinting` to also be enabled (the default): thrash detection keys
 *   off the same mcp.failure.fingerprint fingerprinting computes, so with fingerprinting off there is
 *   nothing to key off and detection silently never fires, regardless of this option.
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

  const rawCostTracking = opts.costTracking ?? {};

  return {
    serviceName: opts.serviceName,
    exporterUrl: opts.exporterUrl,
    enabled: opts.enabled ?? true,
    enableMetrics: opts.enableMetrics ?? true,
    setupNodeSdk,
    fingerprinting: opts.fingerprinting ?? true,
    costTracking: {
      enabled: rawCostTracking.enabled ?? true,
      pricingTable: rawCostTracking.pricingTable ?? DEFAULT_PRICING,
      extractor: rawCostTracking.extractor ?? defaultExtractor,
      budget: rawCostTracking.budget,
    },
    thrashDetection: resolveThrashConfig(opts.thrashDetection),
  };
}
