/**
 * @module schema-drift/diff
 *
 * Classifies what changed between two canonicalized `inputSchema` forms
 * (ADR 010, docs/adr/010-schema-drift.md — "What 'drift' means"), by
 * structurally comparing the parsed schemas, not by comparing hashes —
 * a hash mismatch only says *that* something changed; this says *what*.
 *
 * Only the structural categories ADR 010 defined from `inputSchema`
 * itself are reachable here: `field_added`, `field_removed`,
 * `type_changed`, `required_changed`, `multiple` (more than one at once,
 * never guessed down to a single answer), and `unknown` (the diff
 * couldn't confidently interpret one or both schemas — never a wrong
 * confident answer). ADR 010's `description_changed` dimension is
 * deliberately NOT part of this enum: `description` was never captured
 * by `compose.js`'s `captureToolSchema()` (Phase 1) in the first place —
 * ADR 010 decided it's an independent dimension, computed and reported
 * separately, and this module only ever receives `inputSchema` data.
 * Including a value this code can never produce would be exactly the
 * "unreachable enum value" problem this project's own ADR 008 work
 * already flagged and corrected — description drift needs its own
 * separate capture-and-diff pipeline in a later phase, not a slot here
 * that never fires.
 */

/**
 * @typedef {'field_added' | 'field_removed' | 'type_changed' | 'required_changed' | 'multiple' | 'unknown'} SchemaDriftKind
 */

/** @type {Readonly<Record<string, SchemaDriftKind>>} */
export const DRIFT_KIND = Object.freeze({
  FIELD_ADDED: 'field_added',
  FIELD_REMOVED: 'field_removed',
  TYPE_CHANGED: 'type_changed',
  REQUIRED_CHANGED: 'required_changed',
  MULTIPLE: 'multiple',
  UNKNOWN: 'unknown',
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** @returns {{kind: 'unknown', addedFields: [], removedFields: [], changedFields: [], requiredChanged: false}} */
function unknownResult() {
  return { kind: DRIFT_KIND.UNKNOWN, addedFields: [], removedFields: [], changedFields: [], requiredChanged: false };
}

/**
 * Structurally diffs two parsed (already-canonicalized) `inputSchema`
 * objects. Never throws — any shape this can't confidently interpret
 * (not a plain object, a `properties`/`required` keyword present but not
 * the expected object/array shape) resolves to `unknown` rather than a
 * guessed answer, the same never-guess discipline
 * `classifyFailureChannel()` (fingerprint/classify/channel.js) already
 * established for this codebase.
 *
 * Only `properties` and `required` are inspected — the two keywords
 * every MCP tool `inputSchema` actually uses (see ADR 010's Q1/Q4
 * findings on the SDK's own `tools/list` handler shape). A schema built
 * from less common JSON Schema constructs this differ doesn't interpret
 * (`oneOf`/`anyOf`/`allOf` composition, `$ref` indirection) degrades to
 * `unknown` rather than a wrong specific answer — see ADR 010's
 * Constraints section. Two distinct shapes of this, both confirmed by
 * test (test/schema-drift/diff.test.js):
 *
 *   - Composition at the schema ROOT (no `properties` key present at
 *     all, e.g. a bare `{ oneOf: [...] }` inputSchema) — nothing under
 *     `properties`/`required` differs because there IS no
 *     `properties`/`required`, so this resolves to `unknown`. The event
 *     still fires (the caller only invokes this once a hash difference
 *     is already confirmed), it just can't say what changed.
 *   - A `$ref` INSIDE a normal `properties`-based schema, pointing at a
 *     `$defs` entry whose own content changes while the referencing
 *     property's `$ref` string stays identical (e.g.
 *     `properties.home = { $ref: '#/$defs/Address' }` unchanged,
 *     `$defs.Address` itself edited): this differ only ever compares
 *     each property's own value by deep equality and never inspects
 *     `$defs` at all, so it can't attribute the change to `home` (or any
 *     field) — also `unknown`, for the same "don't guess" reason, not a
 *     bug specific to this case.
 *
 * @param {unknown} oldSchema - Parsed (not JSON-stringified) canonical form.
 * @param {unknown} newSchema - Parsed (not JSON-stringified) canonical form.
 * @returns {{
 *   kind: SchemaDriftKind,
 *   addedFields: string[],
 *   removedFields: string[],
 *   changedFields: string[],
 *   requiredChanged: boolean,
 * }}
 */
export function diffSchemas(oldSchema, newSchema) {
  try {
    if (!isPlainObject(oldSchema) || !isPlainObject(newSchema)) {
      return unknownResult();
    }

    const oldPropsRaw = oldSchema.properties;
    const newPropsRaw = newSchema.properties;
    if ((oldPropsRaw !== undefined && !isPlainObject(oldPropsRaw)) || (newPropsRaw !== undefined && !isPlainObject(newPropsRaw))) {
      return unknownResult();
    }
    const oldProps = oldPropsRaw ?? {};
    const newProps = newPropsRaw ?? {};

    const oldKeys = new Set(Object.keys(oldProps));
    const newKeys = new Set(Object.keys(newProps));

    const addedFields = [...newKeys].filter((key) => !oldKeys.has(key)).sort();
    const removedFields = [...oldKeys].filter((key) => !newKeys.has(key)).sort();
    const changedFields = [...oldKeys]
      .filter((key) => newKeys.has(key))
      .filter((key) => JSON.stringify(oldProps[key]) !== JSON.stringify(newProps[key]))
      .sort();

    const oldRequiredRaw = oldSchema.required;
    const newRequiredRaw = newSchema.required;
    if (
      (oldRequiredRaw !== undefined && !Array.isArray(oldRequiredRaw)) ||
      (newRequiredRaw !== undefined && !Array.isArray(newRequiredRaw))
    ) {
      return unknownResult();
    }
    // `required` is a set of property names — order carries no meaning in
    // JSON Schema, so this compares as sets, not sequences (unlike
    // canonicalize.js, which deliberately leaves array element order
    // alone; this is a semantic diff, not a serialization concern).
    const requiredChanged = !setsEqual(new Set(oldRequiredRaw ?? []), new Set(newRequiredRaw ?? []));

    const changedDimensions = [addedFields.length > 0, removedFields.length > 0, changedFields.length > 0, requiredChanged].filter(
      Boolean,
    ).length;

    let kind;
    if (changedDimensions === 0) {
      // The caller only invokes this when the two schemas' hashes
      // differ, so something changed — just nothing this differ
      // recognizes under properties/required (e.g. a top-level `type`
      // change, or a composition keyword it doesn't interpret). Never
      // guess a specific kind for what it can't see.
      kind = DRIFT_KIND.UNKNOWN;
    } else if (changedDimensions > 1) {
      kind = DRIFT_KIND.MULTIPLE;
    } else if (addedFields.length > 0) {
      kind = DRIFT_KIND.FIELD_ADDED;
    } else if (removedFields.length > 0) {
      kind = DRIFT_KIND.FIELD_REMOVED;
    } else if (changedFields.length > 0) {
      kind = DRIFT_KIND.TYPE_CHANGED;
    } else {
      kind = DRIFT_KIND.REQUIRED_CHANGED;
    }

    return { kind, addedFields, removedFields, changedFields, requiredChanged };
  } catch {
    return unknownResult();
  }
}
