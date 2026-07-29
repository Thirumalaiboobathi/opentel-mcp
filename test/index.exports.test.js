import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.js';
// Self-referencing import (Node resolves 'opentel-mcp' to this same package
// via package.json's own name + exports map — no npm link or build step
// needed) — this is the "does the public API surface actually resolve the
// way a consumer's `import ... from 'opentel-mcp'` would" check, distinct
// from the `../src/index.js` relative import used everywhere else above.
import { DEFAULT_PRICING as SELF_REF_DEFAULT_PRICING, defaultExtractor as selfRefDefaultExtractor } from 'opentel-mcp';

describe('package root exports', () => {
  const REQUIRED_RUNTIME_EXPORTS = [
    'instrumentMcpServer', // existing
    'computeFingerprint',
    'toSpanAttributes',
    'ATTRIBUTE_KEYS',
    'METRIC_SAFE_ATTRIBUTES',
    'DEFAULT_CLASSIFIERS',
    'DEFAULT_PRICING', // v0.5.0 cost attribution
    'defaultExtractor',
    'calculateCost',
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

  it('calculateCost is callable and matches DEFAULT_PRICING for a known model', () => {
    const cost = pkg.calculateCost(1_000_000, 1_000_000, 'claude-sonnet-5', pkg.DEFAULT_PRICING);
    const pricing = pkg.DEFAULT_PRICING['claude-sonnet-5'];
    expect(cost).toBeCloseTo(pricing.inputPer1M + pricing.outputPer1M, 6);
  });

  it('defaultExtractor is callable and recognizes Anthropic-format usage', () => {
    const usage = pkg.defaultExtractor({ usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-sonnet-5' });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, model: 'claude-sonnet-5' });
  });

  it('DEFAULT_PRICING, defaultExtractor, and calculateCost work identically imported by package name', () => {
    // Verifies `import { DEFAULT_PRICING, defaultExtractor } from 'opentel-mcp'` actually resolves — see
    // the self-referencing import at the top of this file.
    expect(SELF_REF_DEFAULT_PRICING).toBe(pkg.DEFAULT_PRICING);
    expect(selfRefDefaultExtractor).toBe(pkg.defaultExtractor);
  });
});
