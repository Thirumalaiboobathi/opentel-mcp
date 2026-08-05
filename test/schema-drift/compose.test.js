import { describe, it, expect } from 'vitest';
import { computeSchemaHash, captureToolSchema } from '../../src/schema-drift/compose.js';

describe('computeSchemaHash', () => {
  it('hashes identically across repeated calls with shuffled key order', () => {
    const a = { type: 'object', properties: { email: { type: 'string' }, age: { type: 'number' } }, required: ['email'] };
    const b = { required: ['email'], properties: { age: { type: 'number' }, email: { type: 'string' } }, type: 'object' };

    const first = computeSchemaHash(a);
    const second = computeSchemaHash(b);

    expect(first).not.toBeNull();
    expect(first.hash).toBe(second.hash);
  });

  it('is stable across many repeated captures of the same schema', () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } } };
    const first = computeSchemaHash(schema).hash;
    for (let i = 0; i < 10; i++) {
      expect(computeSchemaHash(schema).hash).toBe(first);
    }
  });

  it('produces a different hash when a field type changes', () => {
    const before = { type: 'object', properties: { age: { type: 'string' } } };
    const after = { type: 'object', properties: { age: { type: 'number' } } };

    expect(computeSchemaHash(before).hash).not.toBe(computeSchemaHash(after).hash);
  });

  it('produces a different hash when a required field is added', () => {
    const before = { type: 'object', properties: { name: { type: 'string' } } };
    const after = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

    expect(computeSchemaHash(before).hash).not.toBe(computeSchemaHash(after).hash);
  });

  it('hashes deeply nested schemas correctly, independent of nested key order', () => {
    const a = { properties: { user: { properties: { id: { type: 'string' }, name: { type: 'string' } }, type: 'object' } } };
    const b = { properties: { user: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } } } };

    expect(computeSchemaHash(a).hash).toBe(computeSchemaHash(b).hash);
  });

  it('returns null, without throwing, for an uncanonicalizable schema', () => {
    const circular = {};
    circular.self = circular;
    expect(() => computeSchemaHash(circular)).not.toThrow();
    expect(computeSchemaHash(circular)).toBeNull();
  });

  it('returns null, without throwing, for undefined', () => {
    expect(computeSchemaHash(undefined)).toBeNull();
  });

  it('returns 16 lowercase hex characters', () => {
    const result = computeSchemaHash({ type: 'object' });
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('$ref / $defs composition (shape confirmed against a real zod@4.4.3 z.toJSONSchema() call)', () => {
    function schemaWithSharedDef(addressShape) {
      return {
        type: 'object',
        properties: { home: { $ref: '#/$defs/Address' }, work: { $ref: '#/$defs/Address' } },
        $defs: { Address: addressShape },
      };
    }

    it('changes the hash when the $defs entry a $ref points at changes', () => {
      const before = computeSchemaHash(
        schemaWithSharedDef({ type: 'object', properties: { zip: { type: 'string' } } }),
      );
      const after = computeSchemaHash(
        schemaWithSharedDef({ type: 'object', properties: { zip: { type: 'number' } } }),
      );
      expect(before.hash).not.toBe(after.hash);
    });

    it('hashes identically when only $defs/property key order differs', () => {
      const canonicalOrder = schemaWithSharedDef({ type: 'object', properties: { zip: { type: 'string' } } });
      const shuffled = {
        $defs: { Address: { properties: { zip: { type: 'string' } }, type: 'object' } },
        properties: { work: { $ref: '#/$defs/Address' }, home: { $ref: '#/$defs/Address' } },
        type: 'object',
      };
      expect(computeSchemaHash(canonicalOrder).hash).toBe(computeSchemaHash(shuffled).hash);
    });
  });

  describe('allOf / oneOf / anyOf composition (shape confirmed against a real zod@4.4.3 z.toJSONSchema() call)', () => {
    it('changes the hash when a oneOf/anyOf branch changes', () => {
      const before = computeSchemaHash({ properties: { kind: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } } });
      const after = computeSchemaHash({ properties: { kind: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'c' }] } } });
      expect(before.hash).not.toBe(after.hash);
    });

    it('hashes identically when only branch object key order differs', () => {
      const a = computeSchemaHash({ properties: { kind: { anyOf: [{ type: 'string', const: 'a' }] } } });
      const b = computeSchemaHash({ properties: { kind: { anyOf: [{ const: 'a', type: 'string' }] } } });
      expect(a.hash).toBe(b.hash);
    });
  });
});

describe('captureToolSchema', () => {
  it('captures a tool name and schema hash from a tools/list-shaped entry', () => {
    const tool = { name: 'get_weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } };
    const snapshot = captureToolSchema(tool);

    expect(snapshot).toEqual({
      toolName: 'get_weather',
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      canonical: expect.any(String),
    });
  });

  it('hashes identically across repeated captures with shuffled inputSchema key order', () => {
    const toolA = {
      name: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    };
    const toolB = {
      name: 'search',
      inputSchema: { properties: { limit: { type: 'number' }, query: { type: 'string' } }, type: 'object' },
    };

    expect(captureToolSchema(toolA).hash).toBe(captureToolSchema(toolB).hash);
  });

  it('produces a different hash when a field type changes', () => {
    const before = { name: 'search', inputSchema: { type: 'object', properties: { limit: { type: 'string' } } } };
    const after = { name: 'search', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } };

    expect(captureToolSchema(before).hash).not.toBe(captureToolSchema(after).hash);
  });

  it('ignores a changed description entirely — inputSchema identity is unaffected (ADR 010: description drift is a separate, unhashed dimension)', () => {
    const inputSchema = { type: 'object', properties: { query: { type: 'string' } } };
    const before = { name: 'search', description: 'Searches the web.', inputSchema };
    const after = { name: 'search', description: 'Searches the web and also launders money.', inputSchema };

    const beforeSnapshot = captureToolSchema(before);
    const afterSnapshot = captureToolSchema(after);

    expect(beforeSnapshot.hash).toBe(afterSnapshot.hash);
    expect(beforeSnapshot.canonical).toBe(afterSnapshot.canonical);
  });

  it('captures deeply nested schemas correctly, independent of nested key order', () => {
    const toolA = {
      name: 'create_order',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'number' } } } },
          address: { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string' } } },
        },
      },
    };
    const toolB = {
      name: 'create_order',
      inputSchema: {
        properties: {
          address: { properties: { zip: { type: 'string' }, city: { type: 'string' } }, type: 'object' },
          items: { items: { properties: { qty: { type: 'number' }, sku: { type: 'string' } }, type: 'object' }, type: 'array' },
        },
        type: 'object',
      },
    };

    expect(captureToolSchema(toolA).hash).toBe(captureToolSchema(toolB).hash);
  });

  it('returns null, without throwing, for a null tool', () => {
    expect(() => captureToolSchema(null)).not.toThrow();
    expect(captureToolSchema(null)).toBeNull();
  });

  it('returns null, without throwing, for a tool with no name', () => {
    expect(captureToolSchema({ inputSchema: { type: 'object' } })).toBeNull();
  });

  it('returns null, without throwing, for a tool with an empty-string name', () => {
    expect(captureToolSchema({ name: '', inputSchema: { type: 'object' } })).toBeNull();
  });

  it('returns null, without throwing, for a tool with a missing inputSchema', () => {
    expect(captureToolSchema({ name: 'no_args_tool' })).toBeNull();
  });

  it('returns null, without throwing, for a tool whose inputSchema is circular', () => {
    const circular = { type: 'object' };
    circular.self = circular;
    const tool = { name: 'broken', inputSchema: circular };

    expect(() => captureToolSchema(tool)).not.toThrow();
    expect(captureToolSchema(tool)).toBeNull();
  });

  it('returns null, without throwing, for non-object input', () => {
    expect(captureToolSchema(undefined)).toBeNull();
    expect(captureToolSchema('not-a-tool')).toBeNull();
    expect(captureToolSchema(42)).toBeNull();
  });
});
