import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.js';

describe('package root exports', () => {
  const REQUIRED_RUNTIME_EXPORTS = [
    'instrumentMcpServer', // existing
    'computeFingerprint',
    'toSpanAttributes',
    'ATTRIBUTE_KEYS',
    'METRIC_SAFE_ATTRIBUTES',
    'DEFAULT_CLASSIFIERS',
  ];

  it.each(REQUIRED_RUNTIME_EXPORTS)('exports %s', (name) => {
    expect(pkg[name]).toBeDefined();
  });

  it('computeFingerprint is callable and returns a valid result', () => {
    const result = pkg.computeFingerprint(new Error('smoke test'), {
      origin: 'thrown',
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.category).toBeDefined();
  });

  it('ATTRIBUTE_KEYS is frozen', () => {
    expect(Object.isFrozen(pkg.ATTRIBUTE_KEYS)).toBe(true);
  });

  it('METRIC_SAFE_ATTRIBUTES contains exactly category and origin', () => {
    expect([...pkg.METRIC_SAFE_ATTRIBUTES].sort()).toEqual(
      ['mcp.failure.category', 'mcp.failure.origin'].sort(),
    );
  });
});
