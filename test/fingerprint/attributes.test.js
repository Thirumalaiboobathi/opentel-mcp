import { describe, it, expect } from 'vitest';
import { toSpanAttributes, METRIC_SAFE_ATTRIBUTES, ATTRIBUTE_KEYS } from '../../src/fingerprint/attributes.js';

const RESULT = {
  fingerprint: 'a3f4c8e2b1d09f77',
  signature: 'TypeError@doThing:12',
  category: 'timeout',
  origin: 'thrown',
  inputs: {
    errorClass: 'TypeError',
    category: 'timeout',
    origin: 'thrown',
    toolName: null,
    normalizedMessage: 'took too long',
    stackSignature: 'doThing@src/x.js:12',
  },
};

describe('ATTRIBUTE_KEYS', () => {
  it('matches the exact documented string literals', () => {
    expect(ATTRIBUTE_KEYS.FINGERPRINT).toBe('mcp.failure.fingerprint');
    expect(ATTRIBUTE_KEYS.SIGNATURE).toBe('mcp.failure.signature');
    expect(ATTRIBUTE_KEYS.CATEGORY).toBe('mcp.failure.category');
    expect(ATTRIBUTE_KEYS.ORIGIN).toBe('mcp.failure.origin');
    expect(ATTRIBUTE_KEYS.ERROR_CLASS).toBe('mcp.failure.error_class');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ATTRIBUTE_KEYS)).toBe(true);
  });
});

describe('toSpanAttributes', () => {
  it('returns all 5 keys with correct values', () => {
    expect(toSpanAttributes(RESULT)).toEqual({
      'mcp.failure.fingerprint': 'a3f4c8e2b1d09f77',
      'mcp.failure.signature': 'TypeError@doThing:12',
      'mcp.failure.category': 'timeout',
      'mcp.failure.origin': 'thrown',
      'mcp.failure.error_class': 'TypeError',
    });
  });

  it('still includes the error_class key with value "" when errorClass is empty', () => {
    const result = { ...RESULT, inputs: { ...RESULT.inputs, errorClass: '' } };

    const attrs = toSpanAttributes(result);

    expect(attrs).toHaveProperty(ATTRIBUTE_KEYS.ERROR_CLASS, '');
    expect(Object.keys(attrs)).toHaveLength(5);
  });

  it('never throws and returns {} for a malformed result missing inputs', () => {
    let attrs;
    expect(() => {
      attrs = toSpanAttributes({ fingerprint: 'x', signature: 'y', category: 'z', origin: 'thrown' });
    }).not.toThrow();
    expect(attrs).toEqual({});
  });

  it('never throws and returns {} for null/undefined/primitive input', () => {
    for (const bad of [null, undefined, 'not a result', 42]) {
      let attrs;
      expect(() => {
        attrs = toSpanAttributes(bad);
      }).not.toThrow();
      expect(attrs).toEqual({});
    }
  });
});

describe('METRIC_SAFE_ATTRIBUTES', () => {
  it('contains exactly category and origin', () => {
    expect(METRIC_SAFE_ATTRIBUTES).toHaveLength(2);
    expect(METRIC_SAFE_ATTRIBUTES).toEqual(['mcp.failure.category', 'mcp.failure.origin']);
  });

  it('does not contain fingerprint', () => {
    expect(METRIC_SAFE_ATTRIBUTES).not.toContain(ATTRIBUTE_KEYS.FINGERPRINT);
  });

  it('does not contain signature', () => {
    expect(METRIC_SAFE_ATTRIBUTES).not.toContain(ATTRIBUTE_KEYS.SIGNATURE);
  });

  it('does not contain error_class', () => {
    expect(METRIC_SAFE_ATTRIBUTES).not.toContain(ATTRIBUTE_KEYS.ERROR_CLASS);
  });

  it('is frozen, so pushing to it throws in strict mode', () => {
    expect(Object.isFrozen(METRIC_SAFE_ATTRIBUTES)).toBe(true);
    expect(() => METRIC_SAFE_ATTRIBUTES.push('mcp.failure.fingerprint')).toThrow(TypeError);
  });
});
