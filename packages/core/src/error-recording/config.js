/**
 * @module error-recording/config
 * Options parsing and defaults for exception-recording mode (ADR 019,
 * docs/adr/019-raw-content-on-spans.md — Part 1, v0.13.0 Phase 1) and the
 * `redactor` hook (ADR 020, docs/adr/020-redactor-hook.md, v0.14.0 Phase 1).
 *
 * Mirrors src/thrash/config.js's and src/schema-drift/config.js's pattern
 * exactly: precedence, highest to lowest, is an explicit field on the
 * `partial` argument, then the field's `OTEL_MCP_ERROR_RECORDING_*` env
 * var, then the hardcoded default. An invalid or unparseable value from
 * either source is treated exactly like an absent one — silent fallback
 * to the next source, never a throw. `mode` is this module's only
 * env-var-backed field (unlike thrash/schema-drift's several), so
 * `pick()`'s multi-type dispatch (see those two modules' `BOOLEAN_FIELDS`
 * Set) has nothing to dispatch between here — this module reads the one
 * env var directly. `redactor` (ADR 020) has **no** env var equivalent —
 * a function can't be expressed as an `OTEL_MCP_*` string, per that ADR's
 * own Constraints section — so it's resolved from `partial` alone.
 *
 * The small `resolveMode()` helper below is not imported from either
 * sibling config module — those don't export it, and this project's own
 * convention (see schema-drift/config.js's own docblock, and
 * fingerprint/hash.js's FALLBACK_FINGERPRINT duplication precedent it
 * cites) is to duplicate a small, self-contained primitive rather than
 * couple otherwise-unrelated feature config modules together.
 */

import { diag } from '@opentelemetry/api';

/**
 * @typedef {import('./types.d.ts').ErrorRecordingConfig} ErrorRecordingConfig
 */

const ENV_PREFIX = 'OTEL_MCP_ERROR_RECORDING_';
const ENV_MODE = `${ENV_PREFIX}MODE`;

const VALID_MODES = new Set(['full', 'normalized', 'none']);

/** @type {Pick<ErrorRecordingConfig, 'mode'>} */
const DEFAULTS = {
  mode: 'full',
};

// ADR 020 Decision 6: guards the "redactor configured but mode isn't
// 'normalized'" diagnostic below so it fires once per process, same
// pattern (and same rationale — see that variable's own comment) as
// src/config.js's warnedServiceNameIgnored/warnedPricingStale.
let warnedRedactorNoOp = false;

// Test-only: lets test/error-recording/config.test.js get a clean slate
// for the once-per-process warning above regardless of what earlier tests
// in the same file already triggered. Not part of the public API.
export function __resetRedactorNoOpWarnedForTests() {
  warnedRedactorNoOp = false;
}

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
 * ADR 020: resolves `redactor` to a real function, or `undefined` if
 * `partial.redactor` isn't one. Same "invalid input degrades silently,
 * never throws" discipline `resolveMode()` above follows for `mode` — a
 * non-function value (a typo like a string, `null`, an object) is treated
 * exactly like an absent one, with no warning of its own (distinct from
 * the mode-mismatch warning below, which only fires for an actually-valid
 * redactor).
 *
 * @param {Partial<ErrorRecordingConfig> | undefined} partial
 * @returns {ErrorRecordingConfig['redactor']}
 */
function resolveRedactor(partial) {
  return typeof partial?.redactor === 'function' ? partial.redactor : undefined;
}

/**
 * ADR 020 Decision 6: a redactor is only ever consulted under
 * `mode: 'normalized'` — configuring one alongside `'full'` or `'none'`
 * is accepted (never a throw, per this module's general discipline) but
 * silently does nothing, which is exactly the kind of easy-to-hit,
 * easy-to-miss misconfiguration (forgetting to also flip `mode` away from
 * its `'full'` default) this one-time, once-per-process `diag.warn()`
 * exists to surface. Mirrors src/config.js's
 * warnedServiceNameIgnored/warnedPricingStale in both shape and
 * granularity.
 *
 * @param {ErrorRecordingConfig['mode']} mode - The RESOLVED mode (after
 *   defaults/env vars), not the raw input — what actually determines
 *   whether the redactor is invoked.
 * @param {ErrorRecordingConfig['redactor']} redactor - The RESOLVED
 *   redactor — already `undefined` here if the raw input wasn't a
 *   function, so this never warns about a redactor that was invalid
 *   anyway.
 */
function warnIfRedactorIsNoOp(mode, redactor) {
  if (!redactor || mode === 'normalized' || warnedRedactorNoOp) return;
  warnedRedactorNoOp = true;

  try {
    diag.warn(
      `opentel-mcp: errorRecording.redactor is configured but errorRecording.mode is '${mode}', not 'normalized' — ` +
        'the redactor is accepted but never invoked in this mode. This warning fires once per process — see ' +
        'docs/adr/020-redactor-hook.md Decision 6.',
    );
  } catch {
    // Never throw — matches every other diagnostic in this codebase.
  }
}

/**
 * Validates and applies defaults to raw error-recording options. Never
 * throws — each field independently falls back to its default/absence on
 * anything other than a valid input (a recognized mode string; a real
 * function for `redactor`).
 *
 * @param {Partial<ErrorRecordingConfig>} [partial]
 * @returns {ErrorRecordingConfig}
 */
export function resolveErrorRecordingConfig(partial) {
  const mode = resolveMode(pickMode(partial), DEFAULTS.mode);
  const redactor = resolveRedactor(partial);

  warnIfRedactorIsNoOp(mode, redactor);

  return { mode, redactor };
}
