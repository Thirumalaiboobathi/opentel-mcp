/**
 * @module unactionable
 *
 * ADR 025 (docs/adr/025-unactionable-errors.md): flag tool errors that give
 * the agent nothing to act on — `isError: true` with empty or near-empty
 * content.
 *
 * PRIVACY: computed only from the SHAPE of `result.content` — how many
 * items are text vs. non-text, and the whitespace-trimmed LENGTH of the
 * text items. Strings are read only to be measured; no text is stored,
 * hashed, compared, or emitted. The two attributes produced have fixed,
 * tiny value domains (a boolean, and one of five bucket names).
 *
 * Span-only. Neither attribute is a metric label (ADR 025 "Metric"); they
 * are deliberately NOT in any METRIC_SAFE_ATTRIBUTES list.
 */

/** Boolean: the tool error gave the agent nothing to act on. */
export const ATTR_MCP_FAILURE_UNACTIONABLE = 'mcp.failure.unactionable';

/** One of CONTENT_LENGTH_BUCKETS: the trimmed text length of the error, bucketed. */
export const ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET = 'mcp.failure.content_length_bucket';

/** The only values `mcp.failure.content_length_bucket` ever takes. */
export const CONTENT_LENGTH_BUCKETS = Object.freeze(['empty', 'tiny', 'short', 'medium', 'long']);

const SHORT_LIMIT = 80;
const MEDIUM_LIMIT = 500;

const ENV_PREFIX = 'OTEL_MCP_UNACTIONABLE_ERRORS_';
const DEFAULTS = Object.freeze({ enabled: true, minTextLength: 10 });
const MAX_MIN_TEXT_LENGTH = 200;

/**
 * @typedef {object} UnactionableErrorsConfig
 * @property {boolean} enabled
 * @property {number} minTextLength
 */

function readEnvBoolean(name) {
  const raw = process.env[name];
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function readEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Same partial-overrides-individual-defaults behavior, and the same
 * OTEL_MCP_<FEATURE>_ env-var fallback, as resolveSchemaDriftConfig().
 * Invalid values fall back to the defaults; never throws.
 *
 * @param {Partial<UnactionableErrorsConfig> | undefined} partial
 * @returns {UnactionableErrorsConfig}
 */
export function resolveUnactionableErrorsConfig(partial) {
  const p = partial !== null && typeof partial === 'object' ? partial : {};
  const enabled = p.enabled !== undefined ? p.enabled : readEnvBoolean(`${ENV_PREFIX}ENABLED`);
  const minTextLength = p.minTextLength !== undefined ? p.minTextLength : readEnvInt(`${ENV_PREFIX}MIN_TEXT_LENGTH`);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULTS.enabled,
    minTextLength:
      typeof minTextLength === 'number' &&
      Number.isInteger(minTextLength) &&
      minTextLength >= 0 &&
      minTextLength <= MAX_MIN_TEXT_LENGTH
        ? minTextLength
        : DEFAULTS.minTextLength,
  };
}

/**
 * @param {unknown} result a CallToolResult with isError: true
 * @param {number} minTextLength
 * @returns {{ unactionable: boolean, bucket: string }}
 */
export function assessToolErrorContent(result, minTextLength) {
  const content = /** @type {any} */ (result)?.content;
  let textLength = 0;
  let nonText = 0;

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue;
      if (item.type === 'text') {
        if (typeof item.text === 'string') textLength += item.text.trim().length;
      } else {
        // image, audio, resource, resource_link, or anything else typed:
        // the agent was handed something other than prose.
        nonText++;
      }
    }
  }

  let bucket;
  if (textLength === 0) bucket = 'empty';
  else if (textLength < minTextLength) bucket = 'tiny';
  else if (textLength < SHORT_LIMIT) bucket = 'short';
  else if (textLength < MEDIUM_LIMIT) bucket = 'medium';
  else bucket = 'long';

  const unactionable = nonText === 0 && (textLength === 0 || textLength < minTextLength);
  return { unactionable, bucket };
}

/**
 * Sets both attributes on `span` for an isError: true result. Never throws:
 * on any failure both attributes are omitted rather than guessed.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {unknown} result
 * @param {UnactionableErrorsConfig} config
 */
export function applyUnactionableAttributes(span, result, config) {
  try {
    if (!config?.enabled) return;
    const { unactionable, bucket } = assessToolErrorContent(result, config.minTextLength);
    span.setAttribute(ATTR_MCP_FAILURE_UNACTIONABLE, unactionable);
    span.setAttribute(ATTR_MCP_FAILURE_CONTENT_LENGTH_BUCKET, bucket);
  } catch {
    // Never throw into the tool-call path (ADR 025 "Order").
  }
}
