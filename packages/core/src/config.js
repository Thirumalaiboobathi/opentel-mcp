/**
 * @module config
 * Options parsing and defaults for instrumentMcpServer().
 */

import { diag } from '@opentelemetry/api';
import { DEFAULT_PRICING, DEFAULT_PRICING_LAST_VERIFIED, isDefaultPricingStale } from './cost/pricing.js';
import { defaultExtractor } from './cost/extractor.js';
import { normalizeModelName } from './cost/calculator.js';
import { resolveThrashConfig } from './thrash/config.js';
import { resolveSchemaDriftConfig } from './schema-drift/config.js';
import { resolveErrorRecordingConfig } from './error-recording/config.js';
import { resolveFlushTimeout } from './flush-on-exit.js';
import { resolveUnactionableErrorsConfig } from './unactionable.js';

/**
 * @typedef {object} CostTrackingOptions
 * @property {boolean} [enabled=true] - Set to false to disable cost/token span attributes and the
 *   mcp.tool.tokens.total / mcp.tool.cost.total metrics entirely.
 * @property {import('./cost/pricing.js').PricingTable} [pricingTable] - Fully replaces DEFAULT_PRICING (or,
 *   if `pricing` below is also set, replaces the base table `pricing` is merged over). Supply your own table
 *   when you want an effective table containing ONLY your own models. For correcting/adding a few models
 *   while keeping the rest of DEFAULT_PRICING, prefer `pricing` instead — see ADR 016
 *   (docs/adr/016-pricing-override-and-staleness.md) point 2.
 * @property {Partial<import('./cost/pricing.js').PricingTable>} [pricing] - Partial pricing table, merged
 *   per-model OVER `pricingTable ?? DEFAULT_PRICING` — each key you supply replaces that model's entire
 *   ModelPricing entry; every model you don't name is untouched. The recommended way to correct stale
 *   pricing or add a model DEFAULT_PRICING doesn't know about. A model priced via this option (or via
 *   `pricingTable`) reports `pricing_status: 'user_override'` — see ADR 016 point 2.
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
 * @property {Partial<import('./schema-drift/config.js').SchemaDriftConfig>} [schemaDrift] - Controls tool
 *   schema drift detection (ADR 010, v0.8.0): capturing each tool's inputSchema on every tools/list call
 *   and flagging when it differs from what was last observed for that tool (see instrument.js's
 *   wrapToolsListHandler(), src/schema-drift/detector.js, and src/schema-drift/emitter.js). Resolved via
 *   resolveSchemaDriftConfig() (src/schema-drift/config.js) — same partial-overrides-individual-defaults
 *   behavior as costTracking/thrashDetection above. Independent of `fingerprinting`/`thrashDetection` —
 *   schema drift has its own, unconditional, OTel-independent bookkeeping and is never gated behind either.
 *   `enabled: false` (or the default when this option is omitted) is a true no-op: tools/list is not
 *   wrapped at all, unlike thrashDetection/costTracking whose disabled state still wraps tools/call for
 *   other reasons and merely skips inner logic.
 * @property {Partial<import('./error-recording/config.js').ErrorRecordingConfig>} [errorRecording] - Controls
 *   what a THROWN exception (not a tool-level `isError: true` result, which never carries a JS Error and is
 *   unaffected) puts on the mcp.tool.call / tools/list span (ADR 019, docs/adr/019-raw-content-on-spans.md
 *   Part 1, v0.13.0): `{ mode: 'full' | 'normalized' | 'none' }`. Defaults to `{ mode: 'full' }` —
 *   byte-identical to every release before v0.13.0 (span.recordException(err) plus setStatus({ message:
 *   err.message }), uncapped). `'normalized'` reuses fingerprint/normalize/message.js's normalizeMessage()
 *   for the exception message and fingerprint/normalize/stack.js's parseAndNormalizeStack() for the
 *   stacktrace (cwd-stripped, node_modules-version-collapsed) — no new scrubbing pipeline. `'none'` sets
 *   only the ERROR status code, no message, no exception event — the same pattern already used for a
 *   tool-level isError: true failure. Also settable via the `OTEL_MCP_ERROR_RECORDING_MODE` environment
 *   variable (lower precedence than this option), same OTEL_MCP_<FEATURE>_ prefix pattern as
 *   OTEL_MCP_THRASH_ and OTEL_MCP_SCHEMA_DRIFT_; an unrecognized value from either source falls back to
 *   'full' silently, never a throw.
 * @property {boolean | { timeoutMs?: number }} [flushOnExit] - ADR 024 (docs/adr/024-flush-on-exit.md):
 *   flush the providers this library created when the process stops — on `beforeExit`, `SIGTERM` and `SIGINT`
 *   — so spans and dev-mode metrics still buffered aren't lost. Only meaningful with `setupNodeSdk: true`,
 *   where it defaults to ON; pass `false` to opt out. With `setupNodeSdk: false` (the default) it never has
 *   any effect: the host owns its providers and its shutdown, and passing it logs a one-time `diag.warn`.
 *   A signal is re-raised after the flush when the host has no listener of its own for it, so the process
 *   still dies by that signal; with a host listener, the host decides. The flush waits at most `timeoutMs`
 *   (default and maximum 1000 ms). Not covered: `process.exit()` (call `await server.shutdown()` first) and
 *   `SIGKILL`.
 * @property {Partial<import('./unactionable.js').UnactionableErrorsConfig>} [unactionableErrors] - ADR 025
 *   (docs/adr/025-unactionable-errors.md): on every `isError: true` result, sets the span attributes
 *   `mcp.failure.unactionable` (boolean) and `mcp.failure.content_length_bucket` (`empty` | `tiny` | `short` |
 *   `medium` | `long`), computed only from the whitespace-trimmed length of the text items and the count of
 *   non-text items — never from the text itself. Unactionable = no content, or under `minTextLength`
 *   (default 10) characters of text with no image/audio/resource item. `{ enabled: true, minTextLength: 10 }`
 *   by default; independent of `fingerprinting`. Span-only: never a metric label. Also settable via
 *   `OTEL_MCP_UNACTIONABLE_ERRORS_ENABLED` / `OTEL_MCP_UNACTIONABLE_ERRORS_MIN_TEXT_LENGTH` (lower precedence).
 * @property {{ resources?: boolean, prompts?: boolean }} [coverage] - ADR 026 (docs/adr/026-resources-prompts-coverage.md),
 *   opt-in, both off by default: also trace `resources/read`, `resources/list`, `resources/templates/list`
 *   (`resources: true`) and `prompts/get`, `prompts/list` (`prompts: true`). Spans are named by method
 *   (`prompts/get <name>` for prompts/get), carry `mcp.method.name` and never `gen_ai.tool.name`; resource
 *   URIs and prompt arguments are never captured. A handler for one of these methods that's already
 *   registered when instrumentMcpServer() runs is skipped (not wrapped) with a single `diag.warn` — never a
 *   throw. Durations go to the `mcp.server.operation.duration` histogram (labels: `mcp.method.name`,
 *   `error.type`).
 * @property {string} [instanceKey] - Host-supplied stable identifier for one logical service (ADR 012,
 *   docs/adr/012-tracker-lifecycle-and-shared-state.md, Option C — Phase 2: this option and its wiring).
 *   When provided, the four in-memory trackers this library keeps per instrumented server — budget
 *   (src/cost/budget.js), Agent Thrash Detection (src/thrash/detector.js), the ToolOutcome counter
 *   (src/observation/tool-outcome-counter.js), and schema drift (src/schema-drift/detector.js) — are looked
 *   up from an internal, bounded, TTL-evicting registry (src/registry/instance-registry.js) keyed by this
 *   string, instead of being constructed fresh on every instrumentMcpServer() call. Repeated calls that pass
 *   the SAME instanceKey therefore share accumulated tracker state — fixing the gap ADR 012 documents under
 *   a "fresh Server per request" deployment shape, where every tracker previously reset to empty before ever
 *   accumulating anything.
 *
 *   Omit (the default, `undefined`) for behavior byte-identical to pre-v0.9.0: trackers are constructed
 *   fresh on every call exactly as before, the registry is never looked up or written to, and no extra
 *   allocation happens beyond the trackers themselves.
 *
 *   Also settable via the `OTEL_MCP_INSTANCE_KEY` environment variable (lower precedence than this option;
 *   an empty or whitespace-only value from either source is treated as omitted, matching this codebase's
 *   `serviceName` validation). Distinct instanceKey values never share state with each other or with calls
 *   that omit the option — each is its own independent registry entry.
 *
 *   Passing an unstable value (e.g. a per-request id) silently defeats the whole point while looking
 *   configured — see ADR 012's Option C "Against" for why this is a real footgun, not a hypothetical one.
 *   Registry bounds (cap, TTL) and known limitations (single-process only — no cross-instance/serverless
 *   sharing) are documented in ADR 012, not repeated here.
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

// Guards the "flushOnExit has no effect without setupNodeSdk" diagnostic
// (ADR 024), same once-per-process pattern.
let warnedFlushOnExitIgnored = false;

// Test-only, same purpose as __resetServiceNameWarnedForTests above.
export function __resetFlushOnExitWarnedForTests() {
  warnedFlushOnExitIgnored = false;
}

/**
 * ADR 024: `false` turns it off; an object supplies `timeoutMs`; anything
 * else (true, undefined, null, junk) means "on, defaults". Only consulted
 * when setupNodeSdk is true.
 *
 * @param {unknown} value
 * @returns {{ timeoutMs: number } | null}
 */
function resolveFlushOnExit(value) {
  if (value === false) return null;
  const timeoutMs = value !== null && typeof value === 'object' ? /** @type {any} */ (value).timeoutMs : undefined;
  return { timeoutMs: resolveFlushTimeout(timeoutMs) };
}

/**
 * ADR 026: opt-in resources/* and prompts/* coverage. Only a literal `true`
 * turns a family on; anything else (including the default) is off.
 *
 * @param {unknown} value
 * @returns {{ resources: boolean, prompts: boolean }}
 */
function resolveCoverage(value) {
  const v = value !== null && typeof value === 'object' ? /** @type {any} */ (value) : {};
  return { resources: v.resources === true, prompts: v.prompts === true };
}

// Guards the DEFAULT_PRICING staleness diagnostic below (ADR 016 point 3),
// same one-per-process pattern as warnedServiceNameIgnored above.
let warnedPricingStale = false;

// Test-only, same purpose as __resetServiceNameWarnedForTests above. Not
// part of the public API.
export function __resetPricingStaleWarnedForTests() {
  warnedPricingStale = false;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ADR 012, Phase 2: the first env var this codebase reads for a bare
// top-level InstrumentOptions field, not one nested inside a feature's own
// sub-config (contrast OTEL_MCP_THRASH_*/OTEL_MCP_SCHEMA_DRIFT_*, both
// scoped to their feature's own resolve*Config() module — thrash/config.js's
// own docblock: "No precedent for env-var-driven config exists elsewhere in
// this codebase [outside thrash/schema-drift]"). instanceKey has no feature
// namespace of its own to nest under, so it takes the bare OTEL_MCP_ prefix
// directly, the same base namespace those two already share.
const ENV_INSTANCE_KEY = 'OTEL_MCP_INSTANCE_KEY';

/**
 * Resolves `instanceKey`: the explicit option wins if it's a non-empty
 * (post-trim) string, else the env var if IT is, else `undefined` — no
 * fallback default beyond that, per ADR 012 ("omit for behavior
 * byte-identical to pre-v0.9.0"). An invalid value from either source
 * (non-string, empty, or whitespace-only) is silently treated as absent,
 * matching this file's own `hasServiceName` validation and this codebase's
 * general "invalid input degrades to the next source, never throws" env-var
 * discipline (thrash/config.js, schema-drift/config.js).
 *
 * @param {unknown} optionValue
 * @param {string | undefined} envValue
 * @returns {string | undefined}
 */
function resolveInstanceKey(optionValue, envValue) {
  if (typeof optionValue === 'string' && optionValue.trim() !== '') return optionValue;
  if (typeof envValue === 'string' && envValue.trim() !== '') return envValue;
  return undefined;
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

  const flushOnExitRequested = opts.flushOnExit !== undefined && opts.flushOnExit !== false;
  if (!setupNodeSdk && flushOnExitRequested && !warnedFlushOnExitIgnored) {
    warnedFlushOnExitIgnored = true;
    diag.warn(
      'opentel-mcp: flushOnExit was provided but setupNodeSdk is false, so it has no effect. ' +
        'The host application owns its TracerProvider/MeterProvider and their shutdown — flush them in your ' +
        "own shutdown sequence. See ADR 024, docs/adr/024-flush-on-exit.md.",
    );
  }

  const rawCostTracking = opts.costTracking ?? {};
  const costTrackingEnabled = rawCostTracking.enabled ?? true;

  // ADR 016 point 2: pricingTable (when supplied) is the BASE table,
  // fully replacing DEFAULT_PRICING; pricing (when supplied) is then
  // merged per-model OVER that base — a plain object spread is exactly
  // "per-model, not top-level replacement" here, since each spread key is
  // one model. Non-object pricingTable/pricing values (a caller's typo,
  // e.g. a string or null) are silently ignored rather than spread, same
  // "malformed config degrades, never crashes" discipline calculateCost()
  // itself follows for a malformed individual entry.
  const hasCustomPricingTable = isPlainObject(rawCostTracking.pricingTable);
  const hasPricingOverride = isPlainObject(rawCostTracking.pricing);
  const basePricingTable = hasCustomPricingTable ? rawCostTracking.pricingTable : DEFAULT_PRICING;
  const pricingTable = hasPricingOverride ? { ...basePricingTable, ...rawCostTracking.pricing } : basePricingTable;

  // ADR 016 point 4: which normalized model keys came from the caller's
  // own config surface (pricingTable and/or pricing), for the
  // mcp.tool.pricing_status 'known' vs 'user_override' distinction —
  // computed once here, not per call. Provenance-based: a key counts as
  // an override because the caller named it, regardless of whether the
  // value they supplied happens to match DEFAULT_PRICING's own entry.
  const pricingOverrideKeys = new Set();
  if (hasCustomPricingTable) {
    for (const key of Object.keys(rawCostTracking.pricingTable)) pricingOverrideKeys.add(normalizeModelName(key));
  }
  if (hasPricingOverride) {
    for (const key of Object.keys(rawCostTracking.pricing)) pricingOverrideKeys.add(normalizeModelName(key));
  }

  // ADR 016 point 3: only warn when DEFAULT_PRICING is actually
  // contributing to the effective table — a caller who fully replaced it
  // via pricingTable isn't using our defaults at all, so a staleness
  // warning about them would be misleading. Gated on costTrackingEnabled
  // too: no cost tracking happens at all otherwise, so DEFAULT_PRICING's
  // age is moot.
  if (costTrackingEnabled && !hasCustomPricingTable && !warnedPricingStale && isDefaultPricingStale()) {
    warnedPricingStale = true;
    diag.warn(
      `opentel-mcp: DEFAULT_PRICING was last verified ${DEFAULT_PRICING_LAST_VERIFIED}, more than 90 days ago. ` +
        'Provider list pricing may have changed since. Override costTracking.pricing (merged per-model over ' +
        'DEFAULT_PRICING) for models whose pricing you need to keep current — see ADR 016, ' +
        'docs/adr/016-pricing-override-and-staleness.md.',
    );
  }

  return {
    serviceName: opts.serviceName,
    exporterUrl: opts.exporterUrl,
    enabled: opts.enabled ?? true,
    enableMetrics: opts.enableMetrics ?? true,
    setupNodeSdk,
    fingerprinting: opts.fingerprinting ?? true,
    costTracking: {
      enabled: costTrackingEnabled,
      pricingTable,
      pricingOverrideKeys,
      usingDefaultPricing: !hasCustomPricingTable,
      extractor: rawCostTracking.extractor ?? defaultExtractor,
      budget: rawCostTracking.budget,
    },
    thrashDetection: resolveThrashConfig(opts.thrashDetection),
    schemaDrift: resolveSchemaDriftConfig(opts.schemaDrift),
    errorRecording: resolveErrorRecordingConfig(opts.errorRecording),
    instanceKey: resolveInstanceKey(opts.instanceKey, process.env[ENV_INSTANCE_KEY]),
    flushOnExit: setupNodeSdk ? resolveFlushOnExit(opts.flushOnExit) : null,
    unactionableErrors: resolveUnactionableErrorsConfig(opts.unactionableErrors),
    coverage: resolveCoverage(opts.coverage),
  };
}
