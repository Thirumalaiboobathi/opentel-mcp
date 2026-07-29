/**
 * @module cost/extractor
 * Best-effort token-usage extraction from MCP tool call results.
 *
 * MCP has no standard field for token usage — providers and tool authors
 * report it differently, or not at all. This module recognizes several
 * conventions seen in the wild and never throws: any result shape it
 * doesn't recognize resolves to `null`, matching this library's
 * instrumentation-must-never-break-the-host-app philosophy (see
 * instrument.js and src/fingerprint/compose.js's computeFingerprint()).
 */

import { diag } from '@opentelemetry/api';

/**
 * @typedef {Object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {string} [model]
 */

/**
 * @typedef {(toolResult: unknown) => TokenUsage | null} UsageExtractor
 */

/**
 * Field-name pairs tried, in order, against a "usage-shaped" object:
 * Anthropic (input_tokens/output_tokens), OpenAI (prompt_tokens/
 * completion_tokens), then Bedrock (inputTokens/outputTokens).
 */
const TOKEN_FIELD_PAIRS = [
  ['input_tokens', 'output_tokens'],
  ['prompt_tokens', 'completion_tokens'],
  ['inputTokens', 'outputTokens'],
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads `{inputTokens, outputTokens}` off a usage-shaped object, trying
 * each known provider's field names in turn. Returns null if none match or
 * the matched fields aren't finite numbers.
 *
 * @param {unknown} usage
 * @returns {{ inputTokens: number, outputTokens: number } | null}
 */
function readTokenCounts(usage) {
  if (!isPlainObject(usage)) return null;

  for (const [inputKey, outputKey] of TOKEN_FIELD_PAIRS) {
    const inputTokens = usage[inputKey];
    const outputTokens = usage[outputKey];
    if (isFiniteNumber(inputTokens) && isFiniteNumber(outputTokens)) {
      return { inputTokens, outputTokens };
    }
  }

  return null;
}

/**
 * Picks the first string `model` found across the three conventional
 * locations: `root.model`, `root.usage.model`, `root._meta.model`.
 *
 * @param {Record<string, unknown>} root
 * @returns {string | undefined}
 */
function readModel(root) {
  const candidates = [
    root.model,
    isPlainObject(root.usage) ? root.usage.model : undefined,
    isPlainObject(root._meta) ? root._meta.model : undefined,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Builds a {@link TokenUsage} from a usage-shaped object plus the broader
 * result it was found on (used only for model lookup). Returns null when
 * `usage` doesn't contain a recognized token-count pair.
 *
 * @param {unknown} usage
 * @param {Record<string, unknown>} modelRoot
 * @returns {TokenUsage | null}
 */
function buildUsage(usage, modelRoot) {
  const counts = readTokenCounts(usage);
  if (!counts) return null;

  const model = readModel(modelRoot);
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    totalTokens: counts.inputTokens + counts.outputTokens,
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Safely parses the first text content block's `text` field as JSON.
 * Returns null on any failure — missing/empty content array, non-text
 * block, non-string text, or invalid JSON — rather than throwing.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown> | null}
 */
function parseTextContent(result) {
  try {
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) return null;

    const first = content[0];
    if (!isPlainObject(first) || typeof first.text !== 'string') return null;

    const parsed = JSON.parse(first.text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Default {@link UsageExtractor}. Recognizes, in priority order:
 *
 *   1. `result.usage` in Anthropic, OpenAI, or Bedrock field-naming
 *      conventions.
 *   2. JSON-in-text: `result.content[0].text` parsed as JSON, then read
 *      the same way — either a nested `usage` object, or the parsed
 *      object itself treated as the usage object.
 *   3. `result._meta.usage` — the MCP spec's `_meta` extension point.
 *
 * Model name is read from `result.model`, `result.usage.model`, or
 * `result._meta.model` (first one found wins), resolved against whichever
 * root produced the matched usage.
 *
 * Never throws: any unexpected shape — including one that throws on
 * property access — is caught and logged at debug level, returning null.
 *
 * @type {UsageExtractor}
 */
export function defaultExtractor(toolResult) {
  try {
    if (!isPlainObject(toolResult)) return null;

    const direct = buildUsage(toolResult.usage, toolResult);
    if (direct) return direct;

    const parsed = parseTextContent(toolResult);
    if (parsed) {
      const fromParsedUsage = buildUsage(parsed.usage, parsed);
      if (fromParsedUsage) return fromParsedUsage;

      const fromParsedRoot = buildUsage(parsed, parsed);
      if (fromParsedRoot) return fromParsedRoot;
    }

    if (isPlainObject(toolResult._meta)) {
      const fromMeta = buildUsage(toolResult._meta.usage, toolResult);
      if (fromMeta) return fromMeta;
    }

    return null;
  } catch (error) {
    diag.debug('opentel-mcp: defaultExtractor failed to extract token usage, returning null', error);
    return null;
  }
}
