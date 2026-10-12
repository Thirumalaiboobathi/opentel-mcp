/**
 * @module staleness
 *
 * ADR 027 (docs/adr/027-staleness-detection.md): flag successful tool
 * responses whose data is older than the freshness the tool itself
 * reported. The tool is the source of truth; `staleness.tools[name].maxAgeMs`
 * in config is only an override.
 *
 * PRIVACY: reads `result._meta[FRESHNESS_META_KEY]` through the shared
 * accessor (src/result-meta.js) and then only its `asOf`, `maxAgeMs` and
 * `freshUntil` properties. Never enumerates `_meta`, never reads content,
 * never emits a raw input value: only the derived age and window (numbers)
 * and fixed enum strings reach the span.
 *
 * Staleness is not an error: nothing here touches span status, error.type
 * or the silent-failure counter.
 */

import { diag } from '@opentelemetry/api';
import { isPlainObject, readResultMetaField } from './result-meta.js';

/**
 * The `result._meta` key a tool reports freshness under. Reverse-DNS
 * prefix per the MCP spec's `_meta` key rules (ADR 027, Step 0).
 */
export const FRESHNESS_META_KEY = 'io.github.thirumalaiboobathi.opentel-mcp/freshness';

/** `fresh` | `stale` | `unknown`. Set only when the tool sent the freshness key. */
export const ATTR_MCP_TOOL_FRESHNESS_VERDICT = 'mcp.tool.freshness.verdict';
/** Integer ms: response time minus `asOf`. Span-only, never a metric. */
export const ATTR_MCP_TOOL_FRESHNESS_DATA_AGE_MS = 'mcp.tool.freshness.data_age_ms';
/** Integer ms: the effective window, deadline minus `asOf`. */
export const ATTR_MCP_TOOL_FRESHNESS_MAX_AGE_MS = 'mcp.tool.freshness.max_age_ms';
/** `max_age_ms` | `fresh_until` | `config`: which input set the deadline. */
export const ATTR_MCP_TOOL_FRESHNESS_LIMIT_SOURCE = 'mcp.tool.freshness.limit_source';
/** Why the verdict is `unknown`; one of UNKNOWN_REASONS. */
export const ATTR_MCP_TOOL_FRESHNESS_UNKNOWN_REASON = 'mcp.tool.freshness.unknown_reason';

export const VERDICTS = Object.freeze(['fresh', 'stale', 'unknown']);
export const LIMIT_SOURCES = Object.freeze(['max_age_ms', 'fresh_until', 'config']);
export const UNKNOWN_REASONS = Object.freeze(['invalid_as_of', 'future_as_of', 'missing_window', 'invalid_window']);

/** `asOf` up to this far in the future is clock skew: age clamps to 0. */
export const FUTURE_SKEW_TOLERANCE_MS = 5_000;

/** A numeric timestamp below this (March 1973 as ms) is almost certainly epoch seconds. */
const MIN_EPOCH_MS = 1e11;
/** ECMAScript's Date range limit, in ms either side of the epoch. */
const MAX_EPOCH_MS = 8.64e15;
/** Longer strings aren't parsed at all. */
const MAX_TIMESTAMP_LENGTH = 64;
/** ISO 8601 date-time with a mandatory `Z` or `±hh:mm` offset. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Cap on the per-server set of tool names already warned about. */
const MAX_WARNED_TOOLS = 256;

/**
 * @typedef {object} StalenessConfig
 * @property {boolean} enabled
 * @property {Map<string, number>} overrides - tool name -> maxAgeMs override.
 */

/**
 * Resolves the `staleness` option. Invalid override entries are dropped
 * with one `diag.warn` each; never throws.
 *
 * @param {unknown} partial
 * @returns {StalenessConfig}
 */
export function resolveStalenessConfig(partial) {
  const overrides = new Map();
  let enabled = true;
  try {
    const p = isPlainObject(partial) ? partial : {};
    enabled = p.enabled !== false;
    const tools = isPlainObject(p.tools) ? p.tools : {};
    for (const toolName of Object.keys(tools)) {
      const entry = tools[toolName];
      const maxAgeMs = isPlainObject(entry) ? entry.maxAgeMs : undefined;
      if (isValidMaxAge(maxAgeMs)) {
        overrides.set(toolName, maxAgeMs);
      } else {
        diag.warn(
          `opentel-mcp: staleness.tools[${JSON.stringify(toolName)}].maxAgeMs must be a finite number >= 0; ` +
            "ignoring this override, so the tool's own freshness window applies. See ADR 027.",
        );
      }
    }
  } catch (err) {
    diag.warn('opentel-mcp: could not read the staleness option; ignoring its overrides. See ADR 027.', err);
  }
  return { enabled, overrides };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isValidMaxAge(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Epoch ms from an ISO 8601 string with a zone, or an epoch-ms number.
 * `null` for anything else.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < MIN_EPOCH_MS || value > MAX_EPOCH_MS) return null;
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TIMESTAMP_LENGTH || !ISO_WITH_ZONE.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * @typedef {object} FreshnessAssessment
 * @property {'fresh' | 'stale' | 'unknown'} verdict
 * @property {number} [dataAgeMs]
 * @property {number} [maxAgeMs]
 * @property {'max_age_ms' | 'fresh_until' | 'config'} [limitSource]
 * @property {'invalid_as_of' | 'future_as_of' | 'missing_window' | 'invalid_window'} [unknownReason]
 * @property {string} [warning] - Set for a malformed input worth one diag.warn.
 */

/**
 * The verdict for one freshness value. Pure; reads only `asOf`,
 * `maxAgeMs` and `freshUntil` off `freshness`. Can throw only if one of
 * those properties is a throwing getter; the caller catches.
 *
 * @param {unknown} freshness - `result._meta[FRESHNESS_META_KEY]`, known to be present.
 * @param {number | undefined} overrideMaxAgeMs - From config; replaces the tool's window.
 * @param {number} now - Epoch ms.
 * @returns {FreshnessAssessment}
 */
export function assessFreshness(freshness, overrideMaxAgeMs, now) {
  if (!isPlainObject(freshness)) {
    return { verdict: 'unknown', unknownReason: 'invalid_as_of', warning: 'the freshness value is not an object' };
  }

  const rawAsOf = freshness.asOf;
  const asOf = parseTimestamp(rawAsOf);
  if (asOf === null) {
    const looksLikeSeconds = typeof rawAsOf === 'number' && Number.isFinite(rawAsOf) && rawAsOf > 0 && rawAsOf < MIN_EPOCH_MS;
    return {
      verdict: 'unknown',
      unknownReason: 'invalid_as_of',
      warning: looksLikeSeconds
        ? 'asOf looks like epoch seconds; it must be epoch milliseconds or an ISO 8601 string with a timezone'
        : 'asOf is missing or unparseable; use epoch milliseconds or an ISO 8601 string with a timezone (Z or +hh:mm)',
    };
  }

  const rawAge = now - asOf;
  if (rawAge < -FUTURE_SKEW_TOLERANCE_MS) {
    return { verdict: 'unknown', unknownReason: 'future_as_of', warning: 'asOf is more than 5 s in the future' };
  }
  const dataAgeMs = Math.max(0, Math.round(rawAge));

  let deadline;
  /** @type {FreshnessAssessment['limitSource']} */
  let limitSource;
  if (overrideMaxAgeMs !== undefined) {
    deadline = asOf + overrideMaxAgeMs;
    limitSource = 'config';
  } else {
    const rawMaxAge = freshness.maxAgeMs;
    const rawFreshUntil = freshness.freshUntil;
    const hasMaxAge = rawMaxAge !== undefined;
    const hasFreshUntil = rawFreshUntil !== undefined;
    if (!hasMaxAge && !hasFreshUntil) {
      return {
        verdict: 'unknown',
        dataAgeMs,
        unknownReason: 'missing_window',
        warning: 'asOf was given without maxAgeMs or freshUntil',
      };
    }
    const freshUntil = hasFreshUntil ? parseTimestamp(rawFreshUntil) : null;
    if ((hasMaxAge && !isValidMaxAge(rawMaxAge)) || (hasFreshUntil && (freshUntil === null || freshUntil < asOf))) {
      return {
        verdict: 'unknown',
        dataAgeMs,
        unknownReason: 'invalid_window',
        warning: 'maxAgeMs must be a finite number >= 0, and freshUntil a timestamp no earlier than asOf',
      };
    }
    // Both given: the earlier deadline wins (ADR 027 §1).
    const fromMaxAge = hasMaxAge ? asOf + /** @type {number} */ (rawMaxAge) : Infinity;
    const fromFreshUntil = freshUntil ?? Infinity;
    if (fromFreshUntil < fromMaxAge) {
      deadline = fromFreshUntil;
      limitSource = 'fresh_until';
    } else {
      deadline = fromMaxAge;
      limitSource = 'max_age_ms';
    }
  }

  // Cap so a huge window never overflows or reports a non-finite number.
  const maxAgeMs = Math.round(Math.min(deadline, MAX_EPOCH_MS) - asOf);
  // Skew within tolerance counts as "now == asOf".
  const verdict = Math.max(now, asOf) > deadline ? 'stale' : 'fresh';
  return { verdict, dataAgeMs, maxAgeMs, limitSource };
}

/**
 * Per-instrumented-server state for the once-per-tool warning.
 *
 * @returns {{ warnedTools: Set<string> }}
 */
export function createStalenessState() {
  return { warnedTools: new Set() };
}

/**
 * Reads the freshness key off a successful result and, if present, sets
 * the ADR 027 span attributes and counts a stale response. Never throws.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {{ recordStaleResponse: (toolName: string | undefined) => void } | null | undefined} metricsRecorder
 * @param {string | undefined} toolName
 * @param {unknown} result
 * @param {StalenessConfig} config
 * @param {{ warnedTools: Set<string> }} state
 * @param {number} [now]
 */
export function applyStaleness(span, metricsRecorder, toolName, result, config, state, now = Date.now()) {
  try {
    if (!config?.enabled) return;
    const freshness = readResultMetaField(result, FRESHNESS_META_KEY);
    if (freshness === undefined) return;

    const override = typeof toolName === 'string' ? config.overrides.get(toolName) : undefined;
    const assessment = assessFreshness(freshness, override, now);

    span.setAttribute(ATTR_MCP_TOOL_FRESHNESS_VERDICT, assessment.verdict);
    if (assessment.dataAgeMs !== undefined) span.setAttribute(ATTR_MCP_TOOL_FRESHNESS_DATA_AGE_MS, assessment.dataAgeMs);
    if (assessment.maxAgeMs !== undefined) span.setAttribute(ATTR_MCP_TOOL_FRESHNESS_MAX_AGE_MS, assessment.maxAgeMs);
    if (assessment.limitSource) span.setAttribute(ATTR_MCP_TOOL_FRESHNESS_LIMIT_SOURCE, assessment.limitSource);
    if (assessment.unknownReason) span.setAttribute(ATTR_MCP_TOOL_FRESHNESS_UNKNOWN_REASON, assessment.unknownReason);

    if (assessment.verdict === 'stale') metricsRecorder?.recordStaleResponse(toolName);
    if (assessment.warning) warnOnce(state, toolName, assessment.warning);
  } catch {
    // The thrown value isn't logged: it came from the tool's own object.
    warnOnce(state, toolName, 'reading its freshness _meta threw');
  }
}

/**
 * At most one diag.warn per tool name per server; the set is capped so a
 * flood of distinct names can't grow it. Never throws.
 *
 * @param {{ warnedTools: Set<string> } | undefined} state
 * @param {string | undefined} toolName
 * @param {string} problem
 */
function warnOnce(state, toolName, problem) {
  try {
    const key = typeof toolName === 'string' ? toolName : '';
    if (!state || state.warnedTools.has(key) || state.warnedTools.size >= MAX_WARNED_TOOLS) return;
    state.warnedTools.add(key);
    diag.warn(
      `opentel-mcp: tool ${JSON.stringify(key.slice(0, 128))} reported malformed freshness _meta (${problem}), ` +
        'so its responses get no staleness verdict. Further problems with this tool are not logged. See ADR 027.',
    );
  } catch {
    // Never throw into the tool-call path.
  }
}
