import { describe, it, expect } from 'vitest';
import { calculateCost, isValidModelId, describeInvalidModelId, MODEL_ID_MAX_LENGTH } from '../../src/cost/calculator.js';
import { DEFAULT_PRICING } from '../../src/cost/pricing.js';

describe('calculateCost', () => {
  it('computes cost for 1M input + 1M output tokens against claude-sonnet-5', () => {
    // 1M * $3.00/1M + 1M * $15.00/1M = $18.00
    expect(calculateCost(1_000_000, 1_000_000, 'claude-sonnet-5', DEFAULT_PRICING)).toBe(18);
  });

  it('computes cost for a realistic sub-1M token call', () => {
    // 1500 input @ $3/1M + 400 output @ $15/1M = 0.0045 + 0.006 = 0.0105
    expect(calculateCost(1500, 400, 'claude-sonnet-5', DEFAULT_PRICING)).toBeCloseTo(0.0105, 6);
  });

  it('computes cost for claude-haiku-4-5', () => {
    // 1M * $1.00/1M + 1M * $5.00/1M = $6.00
    expect(calculateCost(1_000_000, 1_000_000, 'claude-haiku-4-5', DEFAULT_PRICING)).toBe(6);
  });

  it('computes cost using only input tokens (0 output)', () => {
    expect(calculateCost(2_000_000, 0, 'claude-sonnet-5', DEFAULT_PRICING)).toBe(6);
  });

  it('computes cost using only output tokens (0 input)', () => {
    expect(calculateCost(0, 2_000_000, 'claude-sonnet-5', DEFAULT_PRICING)).toBe(30);
  });

  it('rounds to 6 decimal places', () => {
    const table = { m: { inputPer1M: 1, outputPer1M: 1, currency: 'USD' } };
    // 1 token @ $1/1M + 2 tokens @ $1/1M = 0.000003, exactly representable at 6dp.
    expect(calculateCost(1, 2, 'm', table)).toBe(0.000003);

    // A rate that produces a repeating decimal beyond 6dp must still round cleanly.
    const oddTable = { m: { inputPer1M: 3, outputPer1M: 0, currency: 'USD' } };
    expect(calculateCost(1, 0, 'm', oddTable)).toBe(0.000003);
  });

  describe('unknown models', () => {
    it('returns null for a model not in the pricing table', () => {
      expect(calculateCost(1000, 1000, 'not-a-real-model', DEFAULT_PRICING)).toBeNull();
    });

    it('returns null for an empty model string', () => {
      expect(calculateCost(1000, 1000, '', DEFAULT_PRICING)).toBeNull();
    });

    it('never throws for an unknown model', () => {
      expect(() => calculateCost(1000, 1000, 'totally-unknown', DEFAULT_PRICING)).not.toThrow();
    });

    it('returns null against an empty pricing table', () => {
      expect(calculateCost(1000, 1000, 'claude-sonnet-5', {})).toBeNull();
    });
  });

  describe('model name normalization', () => {
    it('resolves an uppercase model name', () => {
      expect(calculateCost(1_000_000, 1_000_000, 'CLAUDE-SONNET-5', DEFAULT_PRICING)).toBe(18);
    });

    it('resolves a mixed-case model name', () => {
      expect(calculateCost(1_000_000, 1_000_000, 'Claude-Sonnet-5', DEFAULT_PRICING)).toBe(18);
    });

    it('resolves a provider-prefixed model name', () => {
      expect(calculateCost(1_000_000, 1_000_000, 'anthropic/claude-sonnet-5', DEFAULT_PRICING)).toBe(18);
    });

    it('resolves an uppercase, provider-prefixed model name', () => {
      expect(calculateCost(1_000_000, 1_000_000, 'Anthropic/Claude-Sonnet-5', DEFAULT_PRICING)).toBe(18);
    });

    it('resolves a Bedrock-style prefixed model name', () => {
      expect(calculateCost(1_000_000, 1_000_000, 'aws/amazon-nova-pro', DEFAULT_PRICING)).toBe(4);
    });

    it('does not strip a second slash beyond the first prefix', () => {
      // "openai/o3-mini" -> strip "openai/" only, leaving "o3-mini" intact.
      expect(calculateCost(1_000_000, 1_000_000, 'openai/o3-mini', DEFAULT_PRICING)).toBeCloseTo(1.1 + 4.4, 6);
    });
  });

  describe('edge cases', () => {
    it('returns 0 for 0 input and 0 output tokens', () => {
      expect(calculateCost(0, 0, 'claude-sonnet-5', DEFAULT_PRICING)).toBe(0);
    });

    it('handles very large token counts without overflow or throwing', () => {
      const result = calculateCost(1e12, 1e12, 'claude-sonnet-5', DEFAULT_PRICING);
      expect(result).toBe(3_000_000 + 15_000_000);
    });

    it('returns null for negative input tokens', () => {
      expect(calculateCost(-1, 1000, 'claude-sonnet-5', DEFAULT_PRICING)).toBeNull();
    });

    it('returns null for negative output tokens', () => {
      expect(calculateCost(1000, -1, 'claude-sonnet-5', DEFAULT_PRICING)).toBeNull();
    });

    it('returns null for both token counts negative', () => {
      expect(calculateCost(-5, -5, 'claude-sonnet-5', DEFAULT_PRICING)).toBeNull();
    });

    it('returns null for NaN token counts', () => {
      expect(calculateCost(NaN, 1000, 'claude-sonnet-5', DEFAULT_PRICING)).toBeNull();
    });

    it('returns null for Infinity token counts', () => {
      expect(calculateCost(Infinity, 1000, 'claude-sonnet-5', DEFAULT_PRICING)).toBeNull();
    });

    it('never throws for negative or non-finite inputs', () => {
      expect(() => calculateCost(-1, NaN, 'claude-sonnet-5', DEFAULT_PRICING)).not.toThrow();
      expect(() => calculateCost(Infinity, -Infinity, 'claude-sonnet-5', DEFAULT_PRICING)).not.toThrow();
    });
  });

  describe('every model in DEFAULT_PRICING', () => {
    const chatEntries = Object.entries(DEFAULT_PRICING).filter(([, pricing]) => pricing.pricingKind === 'chat');
    const embeddingEntries = Object.entries(DEFAULT_PRICING).filter(([, pricing]) => pricing.pricingKind === 'embedding');

    it.each(chatEntries)('%s produces the expected cost for 1M/1M tokens', (model, pricing) => {
      const expected = pricing.inputPer1M + pricing.outputPer1M;
      expect(calculateCost(1_000_000, 1_000_000, model, DEFAULT_PRICING)).toBeCloseTo(expected, 6);
    });

    it.each(embeddingEntries)('%s (embedding) prices only the input tokens for 1M/1M tokens', (model, pricing) => {
      // Output tokens are supplied (1M) but must not contribute — proves the
      // embedding branch ignores outputTokens rather than needing it to be 0.
      expect(calculateCost(1_000_000, 1_000_000, model, DEFAULT_PRICING)).toBeCloseTo(pricing.inputPer1M, 6);
    });
  });

  describe('embedding cost math', () => {
    const table = { 'my-embedder': { pricingKind: 'embedding', inputPer1M: 0.1, currency: 'USD' } };

    it('charges only for input tokens', () => {
      // 500,000 input @ $0.10/1M = $0.05
      expect(calculateCost(500_000, 0, 'my-embedder', table)).toBeCloseTo(0.05, 6);
    });

    it('ignores a nonzero outputTokens value entirely', () => {
      expect(calculateCost(500_000, 999_999, 'my-embedder', table)).toBeCloseTo(0.05, 6);
      expect(calculateCost(500_000, 0, 'my-embedder', table)).toBe(calculateCost(500_000, 999_999, 'my-embedder', table));
    });

    it('is 0 for 0 input tokens', () => {
      expect(calculateCost(0, 100, 'my-embedder', table)).toBe(0);
    });

    it('still validates outputTokens as a non-negative finite number', () => {
      expect(calculateCost(500_000, -1, 'my-embedder', table)).toBeNull();
      expect(calculateCost(500_000, NaN, 'my-embedder', table)).toBeNull();
    });

    it('resolves normally via provider-prefixed / cased model names', () => {
      expect(calculateCost(1_000_000, 0, 'OpenAI/my-embedder', table)).toBeCloseTo(0.1, 6);
    });
  });

  describe('malformed pricing entries (must degrade to null, never throw)', () => {
    it('returns null when inputPer1M is missing', () => {
      const table = { m: { pricingKind: 'chat', outputPer1M: 1, currency: 'USD' } };
      expect(calculateCost(1000, 1000, 'm', table)).toBeNull();
    });

    it('returns null when inputPer1M is non-numeric', () => {
      const table = { m: { pricingKind: 'chat', inputPer1M: '1', outputPer1M: 1, currency: 'USD' } };
      expect(calculateCost(1000, 1000, 'm', table)).toBeNull();
    });

    it('returns null when inputPer1M is negative', () => {
      const table = { m: { pricingKind: 'chat', inputPer1M: -1, outputPer1M: 1, currency: 'USD' } };
      expect(calculateCost(1000, 1000, 'm', table)).toBeNull();
    });

    it('returns null for a chat-kind entry missing outputPer1M', () => {
      const table = { m: { pricingKind: 'chat', inputPer1M: 1, currency: 'USD' } };
      expect(calculateCost(1000, 1000, 'm', table)).toBeNull();
    });

    it('treats a missing pricingKind as chat (pre-v0.11.0 custom tables keep working)', () => {
      const table = { m: { inputPer1M: 1, outputPer1M: 2, currency: 'USD' } };
      expect(calculateCost(1_000_000, 1_000_000, 'm', table)).toBe(3);
    });

    it('treats an unrecognized pricingKind as chat', () => {
      const table = { m: { pricingKind: 'bogus', inputPer1M: 1, outputPer1M: 2, currency: 'USD' } };
      expect(calculateCost(1_000_000, 1_000_000, 'm', table)).toBe(3);
    });

    it('returns null when the pricing entry is not an object', () => {
      expect(calculateCost(1000, 1000, 'm', { m: 'not-an-object' })).toBeNull();
      expect(calculateCost(1000, 1000, 'm', { m: null })).toBeNull();
      expect(calculateCost(1000, 1000, 'm', { m: 42 })).toBeNull();
    });

    it('never throws for any malformed entry shape', () => {
      const shapes = [
        {},
        { pricingKind: 'chat' },
        { pricingKind: 'embedding' },
        { pricingKind: 'chat', inputPer1M: NaN, outputPer1M: NaN },
        { pricingKind: 'chat', inputPer1M: Infinity, outputPer1M: 1 },
        null,
        'garbage',
        42,
        [1, 2, 3],
      ];
      for (const pricing of shapes) {
        expect(() => calculateCost(1000, 1000, 'm', { m: pricing })).not.toThrow();
      }
    });
  });
});

// ADR 019 Part 2 (docs/adr/019-raw-content-on-spans.md, v0.13.0 Phase 2).
describe('isValidModelId', () => {
  it('accepts every DEFAULT_PRICING key unchanged', () => {
    for (const key of Object.keys(DEFAULT_PRICING)) {
      expect(isValidModelId(key)).toBe(true);
    }
  });

  it('accepts a "provider/model" form — normalizeModelName()\'s own documented, tested contract', () => {
    expect(isValidModelId('Anthropic/Claude-Sonnet-5')).toBe(true);
    expect(isValidModelId('openai/gpt-4o')).toBe(true);
  });

  it('accepts a dot/colon-bearing Bedrock-style model id and a full ARN', () => {
    expect(isValidModelId('anthropic.claude-3-sonnet-20240229-v1:0')).toBe(true);
    expect(isValidModelId('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0')).toBe(
      true,
    );
  });

  it('accepts an @-versioned model id (Vertex AI convention)', () => {
    expect(isValidModelId('text-bison@001')).toBe(true);
  });

  it('accepts an underscore', () => {
    expect(isValidModelId('some_model_name')).toBe(true);
  });

  it('accepts exactly MODEL_ID_MAX_LENGTH characters', () => {
    expect(isValidModelId('a'.repeat(MODEL_ID_MAX_LENGTH))).toBe(true);
  });

  it('rejects a value one character over MODEL_ID_MAX_LENGTH', () => {
    expect(isValidModelId('a'.repeat(MODEL_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects a value with a disallowed character (space)', () => {
    expect(isValidModelId('claude sonnet 5')).toBe(false);
  });

  it('rejects a value with a disallowed character (angle brackets, e.g. an injection attempt)', () => {
    expect(isValidModelId('<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a value containing a newline', () => {
    expect(isValidModelId('claude-sonnet-5\nInjected: true')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidModelId('')).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isValidModelId(undefined)).toBe(false);
    expect(isValidModelId(null)).toBe(false);
    expect(isValidModelId(42)).toBe(false);
    expect(isValidModelId({})).toBe(false);
    expect(isValidModelId(['claude-sonnet-5'])).toBe(false);
  });

  it('never throws for any input', () => {
    for (const value of [undefined, null, 42, {}, [], Symbol('x'), () => {}]) {
      expect(() => isValidModelId(value)).not.toThrow();
    }
  });
});

describe('describeInvalidModelId', () => {
  it('reports "not a string" for a non-string value, without echoing it', () => {
    expect(describeInvalidModelId(42)).toBe('not a string');
    expect(describeInvalidModelId({ secret: 'value' })).toBe('not a string');
  });

  it('reports "empty string" for an empty string', () => {
    expect(describeInvalidModelId('')).toBe('empty string');
  });

  it('reports the length and the max when over MODEL_ID_MAX_LENGTH, without echoing the value', () => {
    const huge = 'x'.repeat(9000);
    const description = describeInvalidModelId(huge);
    expect(description).toContain('9000');
    expect(description).toContain(String(MODEL_ID_MAX_LENGTH));
    expect(description).not.toContain(huge);
  });

  it('reports "disallowed character" for an in-range value with a bad character, without echoing it', () => {
    const secret = 'jane@example.com is the model, believe me';
    const description = describeInvalidModelId(secret);
    expect(description).toContain('disallowed character');
    expect(description).not.toContain(secret);
    expect(description).not.toContain('jane@example.com is the model');
  });

  it('never throws for any input', () => {
    for (const value of [undefined, null, 42, {}, [], Symbol('x'), () => {}, 'a'.repeat(9000)]) {
      expect(() => describeInvalidModelId(value)).not.toThrow();
    }
  });
});
