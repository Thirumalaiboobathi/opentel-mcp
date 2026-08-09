/**
 * @module thrash/config
 * Options parsing and defaults for Agent Thrash Detection (v0.6.0).
 *
 * This module introduced env-var-driven config to this codebase first —
 * at the time, src/config.js's resolveOptions() read only from its
 * `options` argument, with no env var fallback anywhere. That's since
 * changed: ADR 012 Phase 2 (docs/adr/012-tracker-lifecycle-and-shared-state.md)
 * added `OTEL_MCP_INSTANCE_KEY`, resolved directly in src/config.js's
 * resolveOptions() itself rather than a nested feature config module,
 * since `instanceKey` is a bare top-level option with no feature-specific
 * sub-config to belong to the way `thrashDetection`/`schemaDrift` do. The
 * pattern this module established is otherwise unchanged and still the
 * one every feature-scoped config follows: explicit field on the
 * `partial` argument, then the field's `OTEL_MCP_THRASH_*` env var, then
 * the hardcoded default. An invalid or unparseable env value is treated
 * exactly like an absent one — silent fallback to the next source, never
 * a throw.
 */

/**
 * @typedef {object} ThrashConfig
 * @property {boolean} enabled - false disables thrash detection entirely.
 * @property {number} threshold - Consecutive same-fingerprint failures required to trigger detection.
 * @property {number} windowMs - Failures must fall inside this rolling window to count toward the same loop.
 * @property {number} maxTrackedKeys - LRU cap on the bounded store (src/thrash/store.ts).
 * @property {number} entryTtlMs - How long an idle tracked key survives before lazy/swept expiry.
 * @property {number} reEmitAfter - Re-emit every N further failures past `threshold` (e.g. threshold 3,
 *   reEmitAfter 3 -> emits at 3, 6, 9, ...) instead of once per failure.
 * @property {boolean} assumeSingleSession - false (the default) means the generated per-connection
 *   fallback session id (see instrument.js's resolveThrashSessionId()) is only used when the transport is
 *   reliably determined to be single-connection (e.g. stdio). Set to true to force-permit the fallback even
 *   when the transport can't be determined — an explicit opt-in for deployments the auto-detection can't
 *   see (e.g. a custom Transport implementation), where you already know every connection is 1:1.
 * @property {number} inputThreshold - Per-origin threshold (ADR 007, Phase 3) for failures on the
 *   'protocol.input' channel (classifyFailureChannel(), src/fingerprint/classify/channel.js): a JSON-RPC
 *   InvalidParams error whose message indicates the AGENT supplied bad arguments. Deliberately higher than
 *   `threshold` — an agent retrying with adjusted arguments after an input-validation failure may be
 *   genuinely converging on a correct call, not thrashing. Independent of `threshold`, which continues to
 *   govern the 'execution' channel (isError: true results) unchanged.
 * @property {number} notFoundThreshold - Per-origin threshold (ADR 007, Phase 3) for failures on the
 *   'protocol.not_found' channel: a JSON-RPC error for a tool that doesn't exist or is disabled.
 *   Deliberately lower than `threshold` (defaults to 1, an immediate flag) — retrying a nonexistent tool
 *   name is never convergence; there is no "getting closer" to a tool that isn't there.
 */

const ENV_PREFIX = 'OTEL_MCP_THRASH_';

/** @type {ThrashConfig} */
const DEFAULTS = {
  enabled: true,
  threshold: 3,
  windowMs: 60_000,
  maxTrackedKeys: 1000,
  entryTtlMs: 900_000,
  reEmitAfter: 3,
  assumeSingleSession: false,
  inputThreshold: 5,
  notFoundThreshold: 1,
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
 * Resolves a numeric field to a positive integer, or `fallback` if `value`
 * isn't one — this is where "invalid input" and "out-of-range" (zero,
 * negative, non-integer) collapse to the same handling: both just aren't a
 * positive integer.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function resolvePositiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {Partial<ThrashConfig> | undefined} partial
 * @param {keyof ThrashConfig} field
 * @param {string} envSuffix
 * @returns {unknown} `partial[field]` if present, else the parsed env var, else undefined (caller applies the default).
 */
const BOOLEAN_FIELDS = new Set(['enabled', 'assumeSingleSession']);

function pick(partial, field, envSuffix) {
  if (partial && partial[field] !== undefined) return partial[field];
  return BOOLEAN_FIELDS.has(field) ? readEnvBoolean(ENV_PREFIX + envSuffix) : readEnvInt(ENV_PREFIX + envSuffix);
}

/**
 * Validates and applies defaults to raw thrash-detection options. Never
 * throws — every field independently falls back to its default on
 * anything other than a valid, in-range value.
 *
 * @param {Partial<ThrashConfig>} [partial]
 * @returns {ThrashConfig}
 */
export function resolveThrashConfig(partial) {
  return {
    enabled: resolveBoolean(pick(partial, 'enabled', 'ENABLED'), DEFAULTS.enabled),
    threshold: resolvePositiveInt(pick(partial, 'threshold', 'THRESHOLD'), DEFAULTS.threshold),
    windowMs: resolvePositiveInt(pick(partial, 'windowMs', 'WINDOW_MS'), DEFAULTS.windowMs),
    maxTrackedKeys: resolvePositiveInt(pick(partial, 'maxTrackedKeys', 'MAX_TRACKED_KEYS'), DEFAULTS.maxTrackedKeys),
    entryTtlMs: resolvePositiveInt(pick(partial, 'entryTtlMs', 'ENTRY_TTL_MS'), DEFAULTS.entryTtlMs),
    reEmitAfter: resolvePositiveInt(pick(partial, 'reEmitAfter', 'RE_EMIT_AFTER'), DEFAULTS.reEmitAfter),
    assumeSingleSession: resolveBoolean(
      pick(partial, 'assumeSingleSession', 'ASSUME_SINGLE_SESSION'),
      DEFAULTS.assumeSingleSession,
    ),
    inputThreshold: resolvePositiveInt(pick(partial, 'inputThreshold', 'INPUT_THRESHOLD'), DEFAULTS.inputThreshold),
    notFoundThreshold: resolvePositiveInt(
      pick(partial, 'notFoundThreshold', 'NOT_FOUND_THRESHOLD'),
      DEFAULTS.notFoundThreshold,
    ),
  };
}
