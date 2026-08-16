import { describe, it, expect } from 'vitest';
import { DEFAULT_PRICING, DEFAULT_PRICING_LAST_VERIFIED, isDefaultPricingStale } from '../../src/cost/pricing.js';

describe('DEFAULT_PRICING', () => {
  const entries = Object.entries(DEFAULT_PRICING);
  const chatEntries = entries.filter(([, pricing]) => pricing.pricingKind === 'chat');
  const embeddingEntries = entries.filter(([, pricing]) => pricing.pricingKind === 'embedding');

  it('is non-empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every entry has a recognized pricingKind', () => {
    for (const [model, pricing] of entries) {
      expect(['chat', 'embedding'], model).toContain(pricing.pricingKind);
    }
    expect(chatEntries.length + embeddingEntries.length).toBe(entries.length);
  });

  it.each(chatEntries)('%s has a valid chat ModelPricing entry', (_model, pricing) => {
    expect(pricing).toBeTypeOf('object');
    expect(pricing.currency).toBe('USD');
    expect(pricing.inputPer1M).toBeTypeOf('number');
    expect(pricing.outputPer1M).toBeTypeOf('number');
    expect(Number.isFinite(pricing.inputPer1M)).toBe(true);
    expect(Number.isFinite(pricing.outputPer1M)).toBe(true);
    expect(pricing.inputPer1M).toBeGreaterThan(0);
    expect(pricing.outputPer1M).toBeGreaterThan(0);
  });

  it.each(embeddingEntries)('%s has a valid embedding ModelPricing entry', (_model, pricing) => {
    expect(pricing).toBeTypeOf('object');
    expect(pricing.currency).toBe('USD');
    expect(pricing.inputPer1M).toBeTypeOf('number');
    expect(Number.isFinite(pricing.inputPer1M)).toBe(true);
    expect(pricing.inputPer1M).toBeGreaterThan(0);
    // Input-token-only: no outputPer1M field at all, not outputPer1M: 0 — see ADR 016 point 1.
    expect(pricing).not.toHaveProperty('outputPer1M');
  });

  it('includes every documented embedding model', () => {
    for (const model of [
      'text-embedding-3-small',
      'text-embedding-3-large',
      'text-embedding-ada-002',
      'cohere-embed-v3',
      'amazon-titan-embed-v2',
    ]) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
      expect(DEFAULT_PRICING[model].pricingKind).toBe('embedding');
    }
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

  it('prices output tokens at or above input tokens for every chat model', () => {
    // Every provider in this table charges >= input price for output tokens.
    for (const [model, pricing] of chatEntries) {
      expect(pricing.outputPer1M, `${model} output should be >= input`).toBeGreaterThanOrEqual(pricing.inputPer1M);
    }
  });

  it('uses only lowercase, hyphenated keys', () => {
    for (const model of Object.keys(DEFAULT_PRICING)) {
      expect(model).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('DEFAULT_PRICING_LAST_VERIFIED', () => {
  it('is a parseable ISO date string', () => {
    expect(DEFAULT_PRICING_LAST_VERIFIED).toBeTypeOf('string');
    expect(Number.isFinite(Date.parse(DEFAULT_PRICING_LAST_VERIFIED))).toBe(true);
  });
});

describe('isDefaultPricingStale', () => {
  it('is false the day it was last verified', () => {
    expect(isDefaultPricingStale(new Date(DEFAULT_PRICING_LAST_VERIFIED))).toBe(false);
  });

  it('is false just under the 90-day default threshold', () => {
    const justUnder = new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 89 * 24 * 60 * 60 * 1000);
    expect(isDefaultPricingStale(justUnder)).toBe(false);
  });

  it('is true just over the 90-day default threshold', () => {
    const justOver = new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 91 * 24 * 60 * 60 * 1000);
    expect(isDefaultPricingStale(justOver)).toBe(true);
  });

  it('respects a custom thresholdDays', () => {
    const tenDaysLater = new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 10 * 24 * 60 * 60 * 1000);
    expect(isDefaultPricingStale(tenDaysLater, 5)).toBe(true);
    expect(isDefaultPricingStale(tenDaysLater, 30)).toBe(false);
  });

  it('never throws for a malformed now argument', () => {
    expect(() => isDefaultPricingStale(new Date('not-a-date'))).not.toThrow();
    expect(isDefaultPricingStale(new Date('not-a-date'))).toBe(false);
  });
});
