import { describe, it, expect } from 'vitest';
import { canonicalizeSchema } from '../../src/schema-drift/canonicalize.js';

describe('canonicalizeSchema', () => {
  it('produces identical output for the same schema regardless of key order', () => {
    const a = {
      type: 'object',
      properties: { email: { type: 'string' }, age: { type: 'number' } },
      required: ['email', 'age'],
    };
    const b = {
      required: ['email', 'age'],
      properties: { age: { type: 'number' }, email: { type: 'string' } },
      type: 'object',
    };

    expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b));
  });

  it('is stable across many random shufflings of a schema with many top-level keys', () => {
    const base = {
      type: 'object',
      title: 'Example',
      description: 'unrelated to schema identity',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      required: ['a'],
      additionalProperties: false,
    };
    const expected = canonicalizeSchema(base);

    for (let i = 0; i < 20; i++) {
      const keys = Object.keys(base).sort(() => Math.random() - 0.5);
      const shuffled = {};
      for (const key of keys) shuffled[key] = base[key];
      expect(canonicalizeSchema(shuffled)).toBe(expected);
    }
  });

  it('canonicalizes deeply nested schemas correctly, independent of nested key order', () => {
    const nestedA = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            geo: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
          },
        },
        tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'number' } } } },
      },
    };
    const nestedB = {
      properties: {
        tags: { items: { properties: { id: { type: 'number' }, name: { type: 'string' } }, type: 'object' }, type: 'array' },
        address: {
          properties: {
            geo: { properties: { lng: { type: 'number' }, lat: { type: 'number' } }, type: 'object' },
            street: { type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    };

    expect(canonicalizeSchema(nestedA)).toBe(canonicalizeSchema(nestedB));
  });

  it('does not reorder array elements, only object keys', () => {
    const schema = { type: 'object', required: ['b', 'a'] };
    const canonical = canonicalizeSchema(schema);
    expect(canonical).toContain('"required":["b","a"]');
  });

  it('sorts keys inside array elements independently, without touching element order', () => {
    const a = { items: [{ b: 1, a: 2 }, { d: 3, c: 4 }] };
    const b = { items: [{ a: 2, b: 1 }, { c: 4, d: 3 }] };
    expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b));
    // Element order itself is preserved, not sorted:
    expect(canonicalizeSchema(a)).toBe('{"items":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it('produces a different result when a field type changes', () => {
    const stringSchema = { type: 'object', properties: { age: { type: 'string' } } };
    const numberSchema = { type: 'object', properties: { age: { type: 'number' } } };
    expect(canonicalizeSchema(stringSchema)).not.toBe(canonicalizeSchema(numberSchema));
  });

  it('returns null, without throwing, for undefined', () => {
    expect(canonicalizeSchema(undefined)).toBeNull();
  });

  it('returns null, without throwing, for a circular reference', () => {
    const circular = { type: 'object' };
    circular.self = circular;
    expect(() => canonicalizeSchema(circular)).not.toThrow();
    expect(canonicalizeSchema(circular)).toBeNull();
  });

  it('returns null, without throwing, for a bare function', () => {
    expect(() => canonicalizeSchema(function weird() {})).not.toThrow();
    expect(canonicalizeSchema(function weird() {})).toBeNull();
  });

  it('handles null and primitive schemas without throwing', () => {
    expect(canonicalizeSchema(null)).toBe('null');
    expect(canonicalizeSchema('not-a-schema')).toBe('"not-a-schema"');
    expect(canonicalizeSchema(42)).toBe('42');
    expect(canonicalizeSchema(true)).toBe('true');
  });

  it('handles an empty object schema (a valid "no params" tool)', () => {
    expect(canonicalizeSchema({})).toBe('{}');
    expect(canonicalizeSchema({ type: 'object', properties: {} })).toBe('{"properties":{},"type":"object"}');
  });

  describe('$ref / $defs composition', () => {
    // Shape confirmed against a real zod@4.4.3 z.toJSONSchema() call (a
    // schema with a reused, registered sub-schema): $ref is a plain
    // string, $defs a plain nested object keyed by definition name. Not
    // hand-guessed — see this file's sibling PR discussion.
    function schemaWithSharedDef(addressShape) {
      return {
        type: 'object',
        properties: { home: { $ref: '#/$defs/Address' }, work: { $ref: '#/$defs/Address' } },
        required: ['home', 'work'],
        $defs: { Address: addressShape },
      };
    }

    const addressV1 = { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string' } }, required: ['city', 'zip'] };
    const addressV2 = { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'number' } }, required: ['city', 'zip'] };

    it('changes the canonical form when a $defs entry a $ref points at changes shape', () => {
      const before = canonicalizeSchema(schemaWithSharedDef(addressV1));
      const after = canonicalizeSchema(schemaWithSharedDef(addressV2));
      expect(before).not.toBe(after);
    });

    it('is unaffected by key order within $defs, or by $defs entry order, or by $ref key position', () => {
      const canonicalForm = canonicalizeSchema(schemaWithSharedDef(addressV1));

      const reordered = {
        $defs: { Address: { required: ['city', 'zip'], properties: { zip: { type: 'string' }, city: { type: 'string' } }, type: 'object' } },
        required: ['home', 'work'],
        properties: { work: { $ref: '#/$defs/Address' }, home: { $ref: '#/$defs/Address' } },
        type: 'object',
      };

      expect(canonicalizeSchema(reordered)).toBe(canonicalForm);
    });

    it('does not falsely change when a second, unrelated $defs entry is merely reordered ahead of the first', () => {
      const withTwoDefs = (order) => {
        const defs =
          order === 'a-then-b'
            ? { Address: addressV1, Contact: { type: 'object', properties: { email: { type: 'string' } } } }
            : { Contact: { type: 'object', properties: { email: { type: 'string' } } }, Address: addressV1 };
        return { type: 'object', properties: { home: { $ref: '#/$defs/Address' } }, $defs: defs };
      };

      expect(canonicalizeSchema(withTwoDefs('a-then-b'))).toBe(canonicalizeSchema(withTwoDefs('b-then-a')));
    });
  });

  describe('allOf / oneOf / anyOf composition', () => {
    // Shape confirmed against a real zod@4.4.3 z.toJSONSchema() call for
    // z.union([z.literal('a'), z.literal('b')]): a plain array of plain
    // branch objects under `anyOf`.
    function schemaWithAnyOf(branches) {
      return { type: 'object', properties: { kind: { anyOf: branches } } };
    }

    it('is unaffected by key order within each branch object', () => {
      const a = schemaWithAnyOf([
        { type: 'string', const: 'a' },
        { type: 'string', const: 'b' },
      ]);
      const b = schemaWithAnyOf([
        { const: 'a', type: 'string' },
        { const: 'b', type: 'string' },
      ]);
      expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b));
    });

    it('changes the canonical form when a branch\'s content changes', () => {
      const before = schemaWithAnyOf([{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }]);
      const after = schemaWithAnyOf([{ type: 'string', const: 'a' }, { type: 'string', const: 'c' }]);
      expect(canonicalizeSchema(before)).not.toBe(canonicalizeSchema(after));
    });

    it('treats reordering the anyOf array itself as a change (documented scope boundary: array order is preserved, not sorted)', () => {
      const forward = schemaWithAnyOf([{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }]);
      const reversed = schemaWithAnyOf([{ type: 'string', const: 'b' }, { type: 'string', const: 'a' }]);
      // Documents current, intentional behavior per canonicalize.js's
      // docblock — not asserting this is semantically ideal, only that
      // it's the known, accepted boundary of what ADR 010 decided to
      // canonicalize (object keys only, never array contents).
      expect(canonicalizeSchema(forward)).not.toBe(canonicalizeSchema(reversed));
    });

    it('allOf behaves the same way as anyOf/oneOf (all three are plain arrays of plain objects)', () => {
      const a = { type: 'object', allOf: [{ minimum: 1 }, { type: 'number' }] };
      const b = { allOf: [{ minimum: 1 }, { type: 'number' }], type: 'object' };
      expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b));

      const changed = { type: 'object', allOf: [{ minimum: 2 }, { type: 'number' }] };
      expect(canonicalizeSchema(a)).not.toBe(canonicalizeSchema(changed));
    });
  });
});
