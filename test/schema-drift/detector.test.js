import { describe, it, expect } from 'vitest';
import { SchemaDriftDetector } from '../../src/schema-drift/detector.js';
import { DRIFT_KIND } from '../../src/schema-drift/diff.js';

const SCOPE = 'server-1';

function tool(name, inputSchema) {
  return { name, inputSchema };
}

describe('SchemaDriftDetector', () => {
  it('emits nothing on cold start — the very first capture of a (scope, tool) pair', () => {
    const detector = new SchemaDriftDetector();
    const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));
    expect(event).toBeNull();
  });

  it('emits nothing across repeated captures of an unchanged schema', () => {
    const detector = new SchemaDriftDetector();
    const schema = { type: 'object', properties: { q: { type: 'string' } } };

    expect(detector.capture(SCOPE, tool('search', schema))).toBeNull(); // cold start
    for (let i = 0; i < 10; i++) {
      expect(detector.capture(SCOPE, tool('search', schema))).toBeNull();
    }
  });

  it('emits nothing across repeated captures even when the schema is rebuilt with shuffled key order each time', () => {
    const detector = new SchemaDriftDetector();
    detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } } }));

    const shuffled = { properties: { n: { type: 'number' }, q: { type: 'string' } }, type: 'object' };
    expect(detector.capture(SCOPE, tool('search', shuffled))).toBeNull();
  });

  describe('drift kinds', () => {
    it('detects field_added', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));

      const event = detector.capture(
        SCOPE,
        tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } }),
      );

      expect(event).not.toBeNull();
      expect(event.kind).toBe(DRIFT_KIND.FIELD_ADDED);
      expect(event.addedFields).toEqual(['limit']);
      expect(event.toolName).toBe('search');
      expect(event.scope).toBe(SCOPE);
      expect(event.previousHash).not.toBe(event.currentHash);
    });

    it('detects field_removed', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } }));

      const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));

      expect(event.kind).toBe(DRIFT_KIND.FIELD_REMOVED);
      expect(event.removedFields).toEqual(['limit']);
    });

    it('detects type_changed', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { limit: { type: 'string' } } }));

      const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: { limit: { type: 'number' } } }));

      expect(event.kind).toBe(DRIFT_KIND.TYPE_CHANGED);
      expect(event.changedFields).toEqual(['limit']);
    });

    it('detects required_changed', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } }, required: [] }));

      const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }));

      expect(event.kind).toBe(DRIFT_KIND.REQUIRED_CHANGED);
      expect(event.requiredChanged).toBe(true);
    });

    it('detects multiple when more than one dimension changes at once', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } }, required: [] }));

      const event = detector.capture(
        SCOPE,
        tool('search', {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
          required: ['q'],
        }),
      );

      expect(event.kind).toBe(DRIFT_KIND.MULTIPLE);
      expect(event.addedFields).toEqual(['limit']);
      expect(event.requiredChanged).toBe(true);
    });

    it('detects unknown when the hash differs but the diff can\'t confidently characterize it', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: {}, additionalProperties: true }));

      const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: {}, additionalProperties: false }));

      expect(event.kind).toBe(DRIFT_KIND.UNKNOWN);
    });

    it('still emits an event (not null) for a changed top-level oneOf/anyOf/allOf composition — kind unknown, not silently no drift', () => {
      // No `properties` key at all here — captureToolSchema/canonicalizeSchema
      // still hash the whole schema (so the hash differs, Phase 1), but
      // diffSchemas has no field-level structure to walk. The point of
      // this test: confirm the detector still fires an event carrying
      // kind: 'unknown' rather than returning null, since a hash change
      // with no classifiable kind is still drift, not "nothing happened."
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('pick', { oneOf: [{ type: 'string' }, { type: 'number' }] }));

      const event = detector.capture(SCOPE, tool('pick', { oneOf: [{ type: 'string' }, { type: 'boolean' }] }));

      expect(event).not.toBeNull();
      expect(event.kind).toBe(DRIFT_KIND.UNKNOWN);
      expect(event.previousHash).not.toBe(event.currentHash);
    });
  });

  describe('SchemaDriftEvent names which fields changed, not just the kind', () => {
    it('names the exact added field(s) — not just "field_added"', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));

      const event = detector.capture(
        SCOPE,
        tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } }),
      );

      expect(event.kind).toBe(DRIFT_KIND.FIELD_ADDED);
      // The whole point: an operator reading this at 3am sees exactly
      // which parameters showed up, not just that "some field" did.
      expect(event.addedFields).toEqual(['limit', 'offset']);
    });

    it('names the exact removed field(s)', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } }));

      const event = detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));

      expect(event.removedFields).toEqual(['limit']);
    });

    it('names the exact changed field(s), distinguishing them from fields that stayed the same', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(
        SCOPE,
        tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'number' } } }),
      );

      const event = detector.capture(
        SCOPE,
        tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } }),
      );

      // 'q' and 'offset' are untouched — only 'limit' actually changed
      // type, and only 'limit' should be named.
      expect(event.changedFields).toEqual(['limit']);
    });

    it('names fields across multiple simultaneous changes when kind is "multiple"', () => {
      const detector = new SchemaDriftDetector();
      detector.capture(
        SCOPE,
        tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'string' } }, required: [] }),
      );

      const event = detector.capture(
        SCOPE,
        tool('search', {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
          required: ['q'],
        }),
      );

      expect(event.kind).toBe(DRIFT_KIND.MULTIPLE);
      expect(event.addedFields).toEqual(['offset']);
      expect(event.changedFields).toEqual(['limit']);
      expect(event.requiredChanged).toBe(true);
    });
  });

  it('a tool removed (no longer captured) and later re-added with the same schema is not drift', () => {
    const detector = new SchemaDriftDetector();
    const schema = { type: 'object', properties: { q: { type: 'string' } } };

    detector.capture(SCOPE, tool('search', schema)); // cold start
    // Simulate other tools/list observations that don't include 'search'
    // at all — nothing calls capture(SCOPE, tool('search', ...)) here.
    detector.capture(SCOPE, tool('unrelated-tool', { type: 'object' }));
    detector.capture(SCOPE, tool('another-tool', { type: 'object' }));

    // 'search' reappears, unchanged.
    const event = detector.capture(SCOPE, tool('search', schema));
    expect(event).toBeNull();
  });

  it('a tool removed and re-added with a changed schema is detected as ordinary drift against its last-seen schema', () => {
    const detector = new SchemaDriftDetector();
    detector.capture(SCOPE, tool('search', { type: 'object', properties: { q: { type: 'string' } } }));
    detector.capture(SCOPE, tool('unrelated-tool', { type: 'object' }));

    const event = detector.capture(
      SCOPE,
      tool('search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } }),
    );

    expect(event).not.toBeNull();
    expect(event.kind).toBe(DRIFT_KIND.FIELD_ADDED);
  });

  it('tracks tools independently across different scopes', () => {
    const detector = new SchemaDriftDetector();
    const schemaA = { type: 'object', properties: { q: { type: 'string' } } };
    const schemaB = { type: 'object', properties: { q: { type: 'number' } } };

    expect(detector.capture('scope-a', tool('search', schemaA))).toBeNull(); // cold start in scope-a
    expect(detector.capture('scope-b', tool('search', schemaB))).toBeNull(); // cold start in scope-b — independent key

    // Unchanged within each scope:
    expect(detector.capture('scope-a', tool('search', schemaA))).toBeNull();
    expect(detector.capture('scope-b', tool('search', schemaB))).toBeNull();
  });

  it('stays bounded across many tools and many scopes, evicting least-recently-used entries', () => {
    const detector = new SchemaDriftDetector({ maxTrackedTools: 10 });

    for (let scopeIndex = 0; scopeIndex < 20; scopeIndex++) {
      for (let toolIndex = 0; toolIndex < 20; toolIndex++) {
        expect(() =>
          detector.capture(`scope-${scopeIndex}`, tool(`tool-${toolIndex}`, { type: 'object', properties: {} })),
        ).not.toThrow();
        expect(detector.size).toBeLessThanOrEqual(10);
      }
    }

    expect(detector.size).toBe(10);
  });

  it('an evicted (scope, tool) pair is treated as a fresh cold start if captured again', () => {
    const detector = new SchemaDriftDetector({ maxTrackedTools: 1 });

    detector.capture(SCOPE, tool('a', { type: 'object', properties: {} })); // cold start, tracked
    detector.capture(SCOPE, tool('b', { type: 'object', properties: {} })); // cold start, evicts 'a'

    // 'a' was evicted — capturing it again (even with a different schema)
    // is indistinguishable from never having seen it: cold start, not drift.
    const event = detector.capture(SCOPE, tool('a', { type: 'object', properties: { extra: { type: 'string' } } }));
    expect(event).toBeNull();
  });

  describe('malformed input degrades safely', () => {
    it('returns null, without throwing, for a null tool', () => {
      const detector = new SchemaDriftDetector();
      expect(() => detector.capture(SCOPE, null)).not.toThrow();
      expect(detector.capture(SCOPE, null)).toBeNull();
    });

    it('returns null, without throwing, for a tool with no name', () => {
      const detector = new SchemaDriftDetector();
      expect(detector.capture(SCOPE, { inputSchema: { type: 'object' } })).toBeNull();
    });

    it('returns null, without throwing, for a tool with a missing inputSchema', () => {
      const detector = new SchemaDriftDetector();
      expect(detector.capture(SCOPE, { name: 'no-args' })).toBeNull();
    });

    it('returns null, without throwing, for a tool whose inputSchema is circular', () => {
      const detector = new SchemaDriftDetector();
      const circular = { type: 'object' };
      circular.self = circular;
      expect(() => detector.capture(SCOPE, { name: 'broken', inputSchema: circular })).not.toThrow();
      expect(detector.capture(SCOPE, { name: 'broken', inputSchema: circular })).toBeNull();
    });

    it('returns null, without throwing, for a malformed scope', () => {
      const detector = new SchemaDriftDetector();
      expect(() => detector.capture(undefined, tool('x', { type: 'object' }))).not.toThrow();
      expect(() => detector.capture(null, tool('x', { type: 'object' }))).not.toThrow();
    });

    it('never throws across a mix of malformed and valid captures', () => {
      const detector = new SchemaDriftDetector();
      const inputs = [null, undefined, 42, 'nope', {}, { name: 123 }, { name: '' }, tool('ok', { type: 'object' })];
      for (const input of inputs) {
        expect(() => detector.capture(SCOPE, input)).not.toThrow();
      }
    });
  });
});
