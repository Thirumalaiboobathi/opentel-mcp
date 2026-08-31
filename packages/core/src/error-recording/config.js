/**
 * @module error-recording/config
 * Options parsing and defaults for exception-recording mode (ADR 019,
 * docs/adr/019-raw-content-on-spans.md — Part 1, v0.13.0 Phase 1).
 *
 * Mirrors src/thrash/config.js's and src/schema-drift/config.js's pattern
 * exactly: precedence, highest to lowest, is an explicit field on the
 * `partial` argument, then the field's `OTEL_MCP_ERROR_RECORDING_*` env
 * var, then the hardcoded default. An invalid or unparseable value from
 * either source is treated exactly like an absent one — silent fallback
 * to the next source, never a throw. `mode` is this module's only field
 * (unlike thrash/schema-drift's several), so `pick()`'s multi-type
 * dispatch (see those two modules' `BOOLEAN_FIELDS` Set) has nothing to
 * dispatch between here — this module reads the one env var directly.
 *
 * The small `resolveMode()` helper below is not imported from either
 * sibling config module — those don't export it, and this project's own
 * convention (see schema-drift/config.js's own docblock, and
 * fingerprint/hash.js's FALLBACK_FINGERPRINT duplication precedent it
 * cites) is to duplicate a small, self-contained primitive rather than
 * couple otherwise-unrelated feature config modules together.
 */

/**
 * @typedef {import('./types.d.ts').ErrorRecordingConfig} ErrorRecordingConfig
 */

const ENV_PREFIX = 'OTEL_MCP_ERROR_RECORDING_';
const ENV_MODE = `${ENV_PREFIX}MODE`;

const VALID_MODES = new Set(['full', 'normalized', 'none']);

/** @type {ErrorRecordingConfig} */
const DEFAULTS = {
  mode: 'full',
};

/**
 * Resolves `mode` to one of `VALID_MODES`, or `fallback` if `value` isn't
 * one — an unrecognized string (a typo, e.g. `'normalised'`) degrades to
 * the default exactly like a missing value, never a throw, matching this
 * codebase's general "invalid config degrades to the next source" env-var
 * discipline (thrash/config.js, schema-drift/config.js).
 *
 * @param {unknown} value
 * @param {ErrorRecordingConfig['mode']} fallback
 * @returns {ErrorRecordingConfig['mode']}
 */
function resolveMode(value, fallback) {
  return typeof value === 'string' && VALID_MODES.has(value) ? /** @type {ErrorRecordingConfig['mode']} */ (value) : fallback;
}

/**
 * @param {Partial<ErrorRecordingConfig> | undefined} partial
 * @returns {unknown} `partial.mode` if present, else the env var's raw string, else undefined (caller applies the default).
 */
function pickMode(partial) {
  if (partial && partial.mode !== undefined) return partial.mode;
  return process.env[ENV_MODE];
}

/**
 * Validates and applies defaults to raw error-recording options. Never
 * throws — the one field independently falls back to its default on
 * anything other than a valid, recognized mode string.
 *
 * @param {Partial<ErrorRecordingConfig>} [partial]
 * @returns {ErrorRecordingConfig}
 */
export function resolveErrorRecordingConfig(partial) {
  return {
    mode: resolveMode(pickMode(partial), DEFAULTS.mode),
  };
}
