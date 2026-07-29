import { describe, it, expect } from 'vitest';
import { DEFAULT_PRICING } from '../../src/cost/pricing.js';

describe('DEFAULT_PRICING', () => {
  const entries = Object.entries(DEFAULT_PRICING);

  it('is non-empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s has a valid ModelPricing entry', (_model, pricing) => {
    expect(pricing).toBeTypeOf('object');
    expect(pricing.currency).toBe('USD');
    expect(pricing.inputPer1M).toBeTypeOf('number');
    expect(pricing.outputPer1M).toBeTypeOf('number');
    expect(Number.isFinite(pricing.inputPer1M)).toBe(true);
    expect(Number.isFinite(pricing.outputPer1M)).toBe(true);
    expect(pricing.inputPer1M).toBeGreaterThan(0);
    expect(pricing.outputPer1M).toBeGreaterThan(0);
  });

  it('includes every documented Anthropic model', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
    ]) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
    }
  });

  it('includes every documented OpenAI model', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini']) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
    }
  });

  it('includes every documented Google model', () => {
    for (const model of ['gemini-2-5-pro', 'gemini-2-5-flash']) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
    }
  });

  it('includes every documented AWS Bedrock model', () => {
    for (const model of ['amazon-nova-pro', 'amazon-nova-lite', 'amazon-nova-micro']) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
    }
  });

  it('includes every documented DeepSeek model', () => {
    for (const model of ['deepseek-v3', 'deepseek-r1']) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
    }
  });

  it('prices output tokens at or above input tokens for every model', () => {
    // Every provider in this table charges >= input price for output tokens.
    for (const [model, pricing] of entries) {
      expect(pricing.outputPer1M, `${model} output should be >= input`).toBeGreaterThanOrEqual(pricing.inputPer1M);
    }
  });

  it('uses only lowercase, hyphenated keys', () => {
    for (const model of Object.keys(DEFAULT_PRICING)) {
      expect(model).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
