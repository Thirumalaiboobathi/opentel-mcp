/**
 * @module schema-drift/config
 * Options parsing and defaults for tool schema drift detection (ADR 010,
 * docs/adr/010-schema-drift.md — Phase 4: wiring).
 *
 * Mirrors src/thrash/config.js's pattern exactly: precedence, highest to
 * lowest, is an explicit field on the `partial` argument, then the
 * field's `OTEL_MCP_SCHEMA_DRIFT_*` env var, then the hardcoded default.
 * An invalid or unparseable env value is treated exactly like an absent
 * one — silent fallback to the next source, never a throw.
 *
 * The small helper functions below are duplicated from thrash/config.js
 * rather than imported — that module doesn't export them, and this
 * project's own convention (see fingerprint/hash.js's FALLBACK_FINGERPRINT
 * docblock, thrash/detector.js's identical duplication of that same
 * constant) is to duplicate a small, self-contained primitive rather than
 * couple two otherwise-unrelated feature config modules together.
 */

/**
 * @typedef {object} SchemaDriftConfig
 * @property {boolean} enabled - false disables schema drift detection entirely: tools/list is not wrapped
 *   at all (no span, no capture, no detector/emitter construction) — a true no-op, not merely a per-call
 *   skip. Unlike thrashDetection/costTracking, whose sub-feature flags only gate inner logic inside a span
 *   that always gets created for other reasons, the tools/list span this feature introduces exists purely
 *   for schema drift — there is no other reason to wrap tools/list at all, so disabling this skips the
 *   wrapping decision itself (see instrument.js's instrumentMcpServer()).
 * @property {number} maxTrackedTools - Hard cap on distinct (scope, toolName) pairs tracked at once
 *   (src/schema-drift/store.js's BoundedMap) — defense-in-depth, not a response to an expected failure
 *   mode; see that module's docblock.
 */

const ENV_PREFIX = 'OTEL_MCP_SCHEMA_DRIFT_';

/** @type {SchemaDriftConfig} */
const DEFAULTS = {
  enabled: true,
  maxTrackedTools: 1000,
};

/**
 * @param {string} name
 * @returns {boolean | undefined} undefined when the env var is unset or its value isn't recognized.
 */
function readEnvBoolean(name) {
  const raw = process.env[name];
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

/**
 * @param {string} name
 * @returns {number | undefined} undefined when the env var is unset or doesn't parse to a finite integer.
 */
function readEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function resolveBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Resolves a numeric field to a positive integer, or `fallback` if
 * `value` isn't one — see thrash/config.js's identical helper for why
 * "invalid" and "out-of-range" collapse to the same handling.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function resolvePositiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

const BOOLEAN_FIELDS = new Set(['enabled']);

/**
 * @param {Partial<SchemaDriftConfig> | undefined} partial
 * @param {keyof SchemaDriftConfig} field
 * @param {string} envSuffix
 * @returns {unknown} `partial[field]` if present, else the parsed env var, else undefined (caller applies the default).
 */
function pick(partial, field, envSuffix) {
  if (partial && partial[field] !== undefined) return partial[field];
  return BOOLEAN_FIELDS.has(field) ? readEnvBoolean(ENV_PREFIX + envSuffix) : readEnvInt(ENV_PREFIX + envSuffix);
}

/**
 * Validates and applies defaults to raw schema-drift options. Never
 * throws — every field independently falls back to its default on
 * anything other than a valid, in-range value.
 *
 * @param {Partial<SchemaDriftConfig>} [partial]
 * @returns {SchemaDriftConfig}
 */
export function resolveSchemaDriftConfig(partial) {
  return {
    enabled: resolveBoolean(pick(partial, 'enabled', 'ENABLED'), DEFAULTS.enabled),
    maxTrackedTools: resolvePositiveInt(pick(partial, 'maxTrackedTools', 'MAX_TRACKED_TOOLS'), DEFAULTS.maxTrackedTools),
  };
}
