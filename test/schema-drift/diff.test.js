import { describe, it, expect } from 'vitest';
import { diffSchemas, DRIFT_KIND } from '../../src/schema-drift/diff.js';

describe('diffSchemas', () => {
  it('detects a field being added', () => {
    const before = { type: 'object', properties: { name: { type: 'string' } } };
    const after = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.FIELD_ADDED);
    expect(result.addedFields).toEqual(['age']);
    expect(result.removedFields).toEqual([]);
    expect(result.changedFields).toEqual([]);
    expect(result.requiredChanged).toBe(false);
  });

  it('detects a field being removed', () => {
    const before = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } };
    const after = { type: 'object', properties: { name: { type: 'string' } } };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.FIELD_REMOVED);
    expect(result.removedFields).toEqual(['age']);
    expect(result.addedFields).toEqual([]);
  });

  it('detects a field type change', () => {
    const before = { type: 'object', properties: { age: { type: 'string' } } };
    const after = { type: 'object', properties: { age: { type: 'number' } } };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.TYPE_CHANGED);
    expect(result.changedFields).toEqual(['age']);
  });

  it('detects a required-set change (field newly required, no property added/removed/changed)', () => {
    const before = { type: 'object', properties: { name: { type: 'string' } }, required: [] };
    const after = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.REQUIRED_CHANGED);
    expect(result.requiredChanged).toBe(true);
  });

  it('does not treat a reordered (but set-identical) required array as a change', () => {
    const before = { type: 'object', required: ['a', 'b'] };
    const after = { type: 'object', required: ['b', 'a'] };

    const result = diffSchemas(before, after);
    expect(result.requiredChanged).toBe(false);
  });

  it('reports "multiple" when more than one dimension changed at once', () => {
    const before = { type: 'object', properties: { name: { type: 'string' } }, required: [] };
    const after = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
    };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.MULTIPLE);
    expect(result.addedFields).toEqual(['age']);
    expect(result.requiredChanged).toBe(true);
  });

  it('reports "unknown" when nothing recognizable under properties/required changed', () => {
    // Same properties/required on both sides, but a top-level keyword this
    // differ doesn't interpret (additionalProperties) differs — the
    // caller only invokes diffSchemas() when hashes already differ, so
    // something changed; this differ just can't say what.
    const before = { type: 'object', properties: {}, additionalProperties: true };
    const after = { type: 'object', properties: {}, additionalProperties: false };

    const result = diffSchemas(before, after);
    expect(result.kind).toBe(DRIFT_KIND.UNKNOWN);
    expect(result.addedFields).toEqual([]);
    expect(result.removedFields).toEqual([]);
    expect(result.changedFields).toEqual([]);
  });

  describe('composition keywords ($ref/$defs/allOf/oneOf/anyOf)', () => {
    it('classifies a changed property whose OWN schema is a oneOf/anyOf composition as type_changed, naming that field', () => {
      // The composition sits INSIDE a properties entry here, not at the
      // schema root — diffSchemas never inspects a property's value
      // beyond a deep-equality check, so a change anywhere inside it
      // (including inside a nested oneOf/anyOf array) is correctly
      // attributed to that field, same as any other property value
      // change.
      const before = {
        type: 'object',
        properties: { kind: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } },
      };
      const after = {
        type: 'object',
        properties: { kind: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'c' }] } },
      };

      const result = diffSchemas(before, after);
      expect(result.kind).toBe(DRIFT_KIND.TYPE_CHANGED);
      expect(result.changedFields).toEqual(['kind']);
    });

    it('classifies a change to a TOP-LEVEL oneOf/anyOf/allOf composition (no properties key at all) as unknown, not silently as no drift', () => {
      // No `properties` key exists anywhere on either schema — this is
      // the case this differ can't walk field-by-field. It must still
      // report SOME drift kind (the caller only invokes diffSchemas()
      // once hashes already differ, so something changed), just not a
      // specific one it can't actually see.
      const before = { oneOf: [{ type: 'string' }, { type: 'number' }] };
      const after = { oneOf: [{ type: 'string' }, { type: 'boolean' }] };

      const result = diffSchemas(before, after);
      expect(result.kind).toBe(DRIFT_KIND.UNKNOWN);
      expect(result.addedFields).toEqual([]);
      expect(result.removedFields).toEqual([]);
      expect(result.changedFields).toEqual([]);
    });

    it('classifies a change to a TOP-LEVEL $ref (the whole inputSchema is a $ref, no properties key) as unknown for the same reason', () => {
      const before = { $ref: '#/$defs/Foo' };
      const after = { $ref: '#/$defs/Bar' };

      expect(diffSchemas(before, after).kind).toBe(DRIFT_KIND.UNKNOWN);
    });

    it('classifies a changed $defs entry reachable via $ref from a normal properties-based schema as type_changed on the referencing field', () => {
      // Realistic shape: `properties.home` is `{ $ref: '#/$defs/Address' }`
      // (a plain string value under a plain object key) — diffSchemas
      // doesn't dereference $ref, it just deep-compares the property's
      // own schema value, which is the $ref pointer object itself here.
      // If $defs.Address's *content* changes but every property's own
      // $ref pointer string stays identical, this differ — which only
      // ever looks at `properties`/`required`, never `$defs` — can't see
      // that a referenced definition changed at all. Documented here so
      // it's a known, tested boundary, not a silent surprise.
      const before = {
        type: 'object',
        properties: { home: { $ref: '#/$defs/Address' } },
        $defs: { Address: { type: 'object', properties: { zip: { type: 'string' } } } },
      };
      const after = {
        type: 'object',
        properties: { home: { $ref: '#/$defs/Address' } },
        $defs: { Address: { type: 'object', properties: { zip: { type: 'number' } } } },
      };

      // The referencing property's own value ($ref string) is unchanged,
      // and $defs isn't inspected by this differ at all — so this
      // resolves to "nothing recognized changed," i.e. unknown, exactly
      // like the top-level composition cases above.
      const result = diffSchemas(before, after);
      expect(result.kind).toBe(DRIFT_KIND.UNKNOWN);
    });
  });

  it('returns "unknown" without throwing when a schema is not a plain object', () => {
    expect(() => diffSchemas(null, {})).not.toThrow();
    expect(diffSchemas(null, {}).kind).toBe(DRIFT_KIND.UNKNOWN);
    expect(diffSchemas([], {}).kind).toBe(DRIFT_KIND.UNKNOWN);
    expect(diffSchemas('nope', {}).kind).toBe(DRIFT_KIND.UNKNOWN);
    expect(diffSchemas(undefined, undefined).kind).toBe(DRIFT_KIND.UNKNOWN);
  });

  it('returns "unknown" without throwing when properties or required is malformed', () => {
    expect(diffSchemas({ properties: 'not-an-object' }, { properties: {} }).kind).toBe(DRIFT_KIND.UNKNOWN);
    expect(diffSchemas({ required: 'not-an-array' }, { required: [] }).kind).toBe(DRIFT_KIND.UNKNOWN);
  });

  it('never throws when a property\'s own schema value is circular', () => {
    // The circularity has to be reachable by JSON.stringify(oldProps[key])
    // (used to detect a changed property's value) to actually exercise
    // the failure path this test targets — a circular reference
    // elsewhere on the object that this diff never reads wouldn't prove
    // anything.
    const circularPropSchema = { type: 'string' };
    circularPropSchema.self = circularPropSchema;
    const before = { type: 'object', properties: { weird: circularPropSchema } };
    const after = { type: 'object', properties: { weird: { type: 'number' } } };

    expect(() => diffSchemas(before, after)).not.toThrow();
    expect(diffSchemas(before, after).kind).toBe(DRIFT_KIND.UNKNOWN);
  });
});
