/**
 * @module sensitive-tools
 *
 * Sensitive tool auditing (ADR 032, v0.18.0). A list of tool names (exact, or with `*` wildcards) the operator
 * wants a reviewable record of. A matching call gets the boolean span attribute `mcp.tool.sensitive` and one
 * `mcp.audit.sensitive_call` span event carrying the outcome and duration. Never arguments, never results.
 *
 * Matching is a linear glob (split on `*`), not a regex built from user text, so a hostile pattern or tool name
 * cannot cause catastrophic backtracking.
 */

import { diag } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_MCP_TOOL_OUTCOME,
  ATTR_MCP_TOOL_SENSITIVE,
  SPAN_EVENT_NAME_AUDIT_SENSITIVE_CALL,
  ATTR_MCP_TOOL_DURATION_MS,
} from './attributes.js';
import { ATTRIBUTE_KEYS } from './fingerprint/attributes.js';

/** More entries than this are ignored (with one warning). */
export const MAX_SENSITIVE_PATTERNS = 1000;
/** Longer entries are skipped (with one warning). */
export const MAX_SENSITIVE_PATTERN_LENGTH = 256;
/** Tool names longer than this never match a wildcard pattern (bounds work on hostile names). */
const MAX_MATCHED_NAME_LENGTH = 1024;

/**
 * @typedef {object} SensitiveToolMatcher
 * @property {(toolName: unknown) => boolean} matches
 * @property {number} size - Number of compiled patterns (exact + wildcard).
 */

/**
 * Linear-time glob match: `*` matches any run of characters (including none); everything else is literal.
 *
 * @param {string[]} segments - The pattern split on `*` (so `segments.length - 1` wildcards).
 * @param {string} name
 * @returns {boolean}
 */
function globMatches(segments, name) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!name.startsWith(first)) return false;
  if (name.length < first.length + last.length || !name.endsWith(last)) return false;
  let position = first.length;
  const end = name.length - last.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const found = name.indexOf(segments[i], position);
    if (found === -1 || found + segments[i].length > end) return false;
    position = found + segments[i].length;
  }
  return position <= end;
}

/**
 * Compiles the `sensitiveTools` option once. Never throws: invalid entries and shapes warn once and are skipped.
 *
 * @param {unknown} value
 * @returns {SensitiveToolMatcher | null} `null` when nothing valid was configured (the feature is off).
 */
export function compileSensitiveTools(value) {
  try {
    if (value === undefined) return null;
    if (!Array.isArray(value)) {
      diag.warn('opentel-mcp: sensitiveTools must be an array of tool names; ignoring it. See ADR 032.');
      return null;
    }
    const exact = new Set();
    /** @type {string[][]} */
    const globs = [];
    let skipped = 0;
    const entries = value.length > MAX_SENSITIVE_PATTERNS ? value.slice(0, MAX_SENSITIVE_PATTERNS) : value;
    if (value.length > MAX_SENSITIVE_PATTERNS) skipped += value.length - MAX_SENSITIVE_PATTERNS;
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_SENSITIVE_PATTERN_LENGTH) {
        skipped++;
        continue;
      }
      if (entry.includes('*')) globs.push(entry.split('*'));
      else exact.add(entry);
    }
    if (skipped > 0) {
      diag.warn(
        `opentel-mcp: sensitiveTools: ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} skipped (each must be a ` +
          `non-empty string of at most ${MAX_SENSITIVE_PATTERN_LENGTH} characters, and at most ${MAX_SENSITIVE_PATTERNS} ` +
          'entries are used). See ADR 032.',
      );
    }
    const size = exact.size + globs.length;
    if (size === 0) return null;
    return {
      size,
      matches(toolName) {
        if (typeof toolName !== 'string') return false;
        if (exact.has(toolName)) return true;
        if (globs.length === 0 || toolName.length > MAX_MATCHED_NAME_LENGTH) return false;
        for (const segments of globs) if (globMatches(segments, toolName)) return true;
        return false;
      },
    };
  } catch {
    // A throwing getter/proxy on the option: treat as not configured.
    try {
      diag.warn('opentel-mcp: could not read the sensitiveTools option; ignoring it. See ADR 032.');
    } catch {
      // never throw
    }
    return null;
  }
}

/** Sets the boolean marker attribute. Never throws. @param {import('@opentelemetry/api').Span} span */
export function markSensitive(span) {
  try {
    span.setAttribute(ATTR_MCP_TOOL_SENSITIVE, true);
  } catch {
    // never throw into the tool-call path
  }
}

/**
 * Adds the audit event. Attributes: tool name, outcome, duration, and (on failure, when computed) the failure
 * category. Never arguments or results. Never throws.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {string} toolName
 * @param {string} outcome - success | silent_failure | error
 * @param {number} durationMs
 * @param {string} [failureCategory]
 */
export function recordSensitiveAudit(span, toolName, outcome, durationMs, failureCategory) {
  try {
    /** @type {Record<string, string | number>} */
    const attributes = {
      [ATTR_GEN_AI_TOOL_NAME]: toolName,
      [ATTR_MCP_TOOL_OUTCOME]: outcome,
      [ATTR_MCP_TOOL_DURATION_MS]: Math.round(durationMs * 1000) / 1000,
    };
    if (failureCategory) attributes[ATTRIBUTE_KEYS.CATEGORY] = failureCategory;
    span.addEvent(SPAN_EVENT_NAME_AUDIT_SENSITIVE_CALL, attributes);
  } catch {
    // never throw into the tool-call path
  }
}
