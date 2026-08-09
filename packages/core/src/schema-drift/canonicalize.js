/**
 * @module schema-drift/canonicalize
 *
 * Deterministic canonicalization for a tool's `inputSchema` (ADR 010,
 * docs/adr/010-schema-drift.md, Q3): the JSON Schema `tools/list` hands
 * back is regenerated fresh on every call (McpServer's `zod-to-json-schema`
 * dependency for the high-level API, or whatever a low-level `Server`
 * author's own code produces), and neither is a documented, versioned
 * contract about object-key ordering. Hashing the raw, un-canonicalized
 * JSON would make key reordering alone — a dependency bump, a refactor of
 * how a host builds its schema object — look like a schema change, which
 * is exactly the false-drift failure mode ADR 010 rejected naive hashing
 * over (mirroring ADR 006's identical reasoning for raw error messages).
 *
 * Only object KEY order is normalized here, not array element order:
 * object keys have no meaning in JSON Schema (a schema author's or
 * library's incidental construction order), but array contents (e.g.
 * `required`, `enum`) are ADR-010-out-of-scope to reorder — ADR 010's
 * canonicalization decision was "recursively sort object keys," not a
 * semantic JSON-Schema diff, and this module follows that literally
 * rather than inventing additional normalization ADR 010 didn't decide.
 */

/**
 * Recursively sorts every plain object's keys (lexicographic, via
 * `Object.keys().sort()`); array elements are canonicalized in place but
 * never reordered; primitives pass through unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Produces a canonical, deterministic JSON string for a tool's
 * `inputSchema`: every object's keys sorted at every nesting depth, so two
 * structurally identical schemas canonicalize to byte-identical strings
 * regardless of the key order either was originally constructed in.
 *
 * Never throws — schema.js/config.js's own established discipline for
 * anything on the instrumentation hot path (see e.g.
 * fingerprint/compose.js's computeFingerprint()). A schema this can't
 * safely canonicalize (missing entirely, not an object/array/JSON
 * primitive, or containing a circular reference `JSON.stringify` itself
 * would throw on) degrades to `null` rather than propagating an error or
 * guessing a value.
 *
 * @param {unknown} schema
 * @returns {string | null} Canonical JSON string, or `null` when `schema`
 *   is `undefined` or isn't safely serializable.
 */
export function canonicalizeSchema(schema) {
  if (schema === undefined) return null;

  try {
    const sorted = sortKeysDeep(schema);
    const json = JSON.stringify(sorted);
    // JSON.stringify returns `undefined` (not a string) for a handful of
    // inputs it silently can't represent at the top level — a bare
    // `function`, `symbol`, or `undefined` itself (already guarded above,
    // but a nested-only occurrence of one of the others could still
    // surface here if `sorted` unwraps to one of these unusual top-level
    // shapes). Treat that the same as any other unparseable case.
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}
