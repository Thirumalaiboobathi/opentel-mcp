/**
 * @module tool-integrity/hash
 *
 * The tool definition hash (ADR 029, v0.18.0). SHA-256 over a canonical JSON serialization of exactly the text
 * and structure a model reads to decide what a tool does: name, title, description, inputSchema, outputSchema,
 * annotations (each only when present). Same definition, same hash, on every platform.
 *
 * Not the ADR 010 drift hash, which covers `inputSchema` only, is 64 bits, and deliberately ignores descriptions.
 * Nothing here is ever logged or exported except the resulting hash.
 */

import { createHash } from 'node:crypto';

/** Prefix of every hash; a change to what is covered ships as a new prefix, never a silent reinterpretation. */
export const TOOL_HASH_PREFIX = 'sha256:';
/** `sha256:` followed by 64 lowercase hex digits. */
export const TOOL_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The definition fields that are hashed, in the order they are serialized (the object itself is key-sorted). */
export const HASHED_DEFINITION_FIELDS = Object.freeze(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']);

/** Nesting deeper than this is treated as unhashable (also stops cyclic structures). */
const MAX_DEPTH = 256;

/**
 * Canonical JSON text of `value`: object keys sorted at every depth (UTF-16 code-unit order), array order kept, no
 * insignificant whitespace, `JSON.stringify` rules for scalars, `toJSON`, `undefined`/functions/symbols (dropped in
 * objects, `null` in arrays). Built as text, not by copying into a new object, so a key named `__proto__` is
 * hashed like any other. Throws on cycles, excessive depth and BigInt; callers catch.
 *
 * @param {unknown} value
 * @param {number} depth
 * @returns {string | undefined} `undefined` for values JSON omits.
 */
function canonical(value, depth) {
  if (depth > MAX_DEPTH) throw new RangeError('too deep');
  let v = value;
  if (v !== null && typeof v === 'object' && typeof (/** @type {any} */ (v).toJSON) === 'function') {
    v = /** @type {any} */ (v).toJSON();
  }
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'bigint':
      throw new TypeError('bigint');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (Array.isArray(v)) {
    const items = [];
    for (let i = 0; i < v.length; i++) items.push(canonical(v[i], depth + 1) ?? 'null');
    return `[${items.join(',')}]`;
  }
  const parts = [];
  for (const key of Object.keys(v).sort()) {
    const text = canonical(/** @type {any} */ (v)[key], depth + 1);
    if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The canonical JSON text that is hashed for a tool definition, or `null` when it cannot be produced (not an
 * object, cyclic, too deep, BigInt, a throwing getter). Exposed for tests; never log or export it.
 *
 * @param {unknown} definition - One entry of a `tools/list` response's `tools` array.
 * @returns {string | null}
 */
export function canonicalToolDefinition(definition) {
  try {
    if (definition === null || typeof definition !== 'object') return null;
    /** @type {Record<string, unknown>} */
    const picked = {};
    for (const field of HASHED_DEFINITION_FIELDS) {
      const value = /** @type {any} */ (definition)[field];
      if (value !== undefined) picked[field] = value;
    }
    return canonical(picked, 0) ?? null;
  } catch {
    return null;
  }
}

/**
 * `"sha256:" + <64 hex>` over the canonical JSON of the tool definition's name, title, description, inputSchema,
 * outputSchema and annotations (those present). Use it to compute the values for `toolIntegrity.pins`. Never
 * throws; returns `null` for something that is not a hashable object.
 *
 * @param {unknown} definition
 * @returns {string | null}
 */
export function computeToolDefinitionHash(definition) {
  const json = canonicalToolDefinition(definition);
  if (json === null) return null;
  return TOOL_HASH_PREFIX + createHash('sha256').update(json, 'utf8').digest('hex');
}
