import { describe, it, expect } from 'vitest';
import { defaultExtractor } from '../../src/cost/extractor.js';

/** Fixture tool results, one per provider convention this module recognizes. */
const fixtures = {
  anthropic: {
    content: [{ type: 'text', text: 'The answer is 42.' }],
    model: 'claude-sonnet-5',
    usage: { input_tokens: 120, output_tokens: 48 },
  },
  openai: {
    choices: [{ message: { content: 'The answer is 42.' } }],
    model: 'gpt-4o',
    usage: { prompt_tokens: 200, completion_tokens: 75, total_tokens: 275 },
  },
  bedrock: {
    output: { text: 'The answer is 42.' },
    usage: { inputTokens: 300, outputTokens: 100, model: 'amazon-nova-pro' },
  },
};

describe('defaultExtractor', () => {
  describe('provider usage conventions', () => {
    it('extracts Anthropic-format usage (input_tokens / output_tokens)', () => {
      expect(defaultExtractor(fixtures.anthropic)).toEqual({
        inputTokens: 120,
        outputTokens: 48,
        totalTokens: 168,
        model: 'claude-sonnet-5',
      });
    });

    it('extracts OpenAI-format usage (prompt_tokens / completion_tokens)', () => {
      expect(defaultExtractor(fixtures.openai)).toEqual({
        inputTokens: 200,
        outputTokens: 75,
        totalTokens: 275,
        model: 'gpt-4o',
      });
    });

    it('extracts Bedrock-format usage (inputTokens / outputTokens)', () => {
      expect(defaultExtractor(fixtures.bedrock)).toEqual({
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400,
        model: 'amazon-nova-pro',
      });
    });

    it('returns a TokenUsage with no model field when none is present', () => {
      const result = defaultExtractor({ usage: { input_tokens: 10, output_tokens: 5 } });
      expect(result).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      expect(result).not.toHaveProperty('model');
    });

    it('does not match a usage object with only one recognized field', () => {
      expect(defaultExtractor({ usage: { input_tokens: 10, completion_tokens: 5 } })).toBeNull();
    });

    it('does not match when token fields are non-numeric', () => {
      expect(defaultExtractor({ usage: { input_tokens: '10', output_tokens: '5' } })).toBeNull();
    });

    it('does not match when token fields are NaN or Infinity', () => {
      expect(defaultExtractor({ usage: { input_tokens: NaN, output_tokens: 5 } })).toBeNull();
      expect(defaultExtractor({ usage: { input_tokens: Infinity, output_tokens: 5 } })).toBeNull();
    });
  });

  describe('JSON-in-text extraction', () => {
    it('extracts usage nested under a "usage" key inside content[0].text', () => {
      const toolResult = {
        content: [{ type: 'text', text: JSON.stringify({ usage: { input_tokens: 50, output_tokens: 20 }, model: 'gpt-5' }) }],
      };
      expect(defaultExtractor(toolResult)).toEqual({
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
        model: 'gpt-5',
      });
    });

    it('extracts usage when the parsed JSON is itself the usage object', () => {
      const toolResult = {
        content: [{ type: 'text', text: JSON.stringify({ input_tokens: 8, output_tokens: 2 }) }],
      };
      expect(defaultExtractor(toolResult)).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    });

    it('returns null when content[0].text is not valid JSON', () => {
      expect(defaultExtractor({ content: [{ type: 'text', text: 'not json at all' }] })).toBeNull();
    });

    it('returns null when content is missing', () => {
      expect(defaultExtractor({ foo: 'bar' })).toBeNull();
    });

    it('returns null when content is an empty array', () => {
      expect(defaultExtractor({ content: [] })).toBeNull();
    });

    it('returns null when content is not an array', () => {
      expect(defaultExtractor({ content: 'not-an-array' })).toBeNull();
    });

    it('returns null when content[0] has no text field', () => {
      expect(defaultExtractor({ content: [{ type: 'image', data: 'abc' }] })).toBeNull();
    });

    it('returns null when content[0].text is JSON but not an object (e.g. an array)', () => {
      expect(defaultExtractor({ content: [{ type: 'text', text: '[1,2,3]' }] })).toBeNull();
    });
  });

  describe('_meta.usage convention', () => {
    it('extracts usage nested under _meta.usage', () => {
      const toolResult = {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { usage: { input_tokens: 33, output_tokens: 11 } },
      };
      expect(defaultExtractor(toolResult)).toEqual({ inputTokens: 33, outputTokens: 11, totalTokens: 44 });
    });

    it('extracts model from _meta.model alongside _meta.usage', () => {
      const toolResult = { _meta: { usage: { input_tokens: 1, output_tokens: 1 }, model: 'deepseek-v3' } };
      expect(defaultExtractor(toolResult)).toEqual({
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        model: 'deepseek-v3',
      });
    });

    it('returns null when _meta is present but has no usage', () => {
      expect(defaultExtractor({ _meta: { requestId: 'abc123' } })).toBeNull();
    });

    it('returns null when _meta is not an object', () => {
      expect(defaultExtractor({ _meta: 'not-an-object' })).toBeNull();
    });
  });

  describe('model name extraction locations', () => {
    it('reads model from result.model', () => {
      const result = defaultExtractor({ model: 'top-level-model', usage: { input_tokens: 1, output_tokens: 1 } });
      expect(result?.model).toBe('top-level-model');
    });

    it('reads model from result.usage.model', () => {
      const result = defaultExtractor({ usage: { input_tokens: 1, output_tokens: 1, model: 'usage-model' } });
      expect(result?.model).toBe('usage-model');
    });

    it('reads model from result._meta.model', () => {
      const result = defaultExtractor({
        usage: { input_tokens: 1, output_tokens: 1 },
        _meta: { model: 'meta-model' },
      });
      expect(result?.model).toBe('meta-model');
    });

    it('prefers result.model over result.usage.model when both are present', () => {
      const result = defaultExtractor({
        model: 'top-level-model',
        usage: { input_tokens: 1, output_tokens: 1, model: 'usage-model' },
      });
      expect(result?.model).toBe('top-level-model');
    });

    it('ignores an empty-string model and falls through to the next location', () => {
      const result = defaultExtractor({
        model: '',
        usage: { input_tokens: 1, output_tokens: 1, model: 'usage-model' },
      });
      expect(result?.model).toBe('usage-model');
    });
  });

  describe('priority ordering across conventions', () => {
    it('prefers direct result.usage over _meta.usage', () => {
      const toolResult = {
        usage: { input_tokens: 1, output_tokens: 1 },
        _meta: { usage: { input_tokens: 999, output_tokens: 999 } },
      };
      expect(defaultExtractor(toolResult)).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    });

    it('prefers direct result.usage over JSON-in-text', () => {
      const toolResult = {
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ usage: { input_tokens: 999, output_tokens: 999 } }) }],
      };
      expect(defaultExtractor(toolResult)).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    });

    it('prefers JSON-in-text over _meta.usage', () => {
      const toolResult = {
        content: [{ type: 'text', text: JSON.stringify({ usage: { input_tokens: 5, output_tokens: 5 } }) }],
        _meta: { usage: { input_tokens: 999, output_tokens: 999 } },
      };
      expect(defaultExtractor(toolResult)).toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    });
  });

  describe('malformed inputs — never throw, always resolve to null', () => {
    it('returns null for an empty object', () => {
      expect(defaultExtractor({})).toBeNull();
    });

    it('returns null for null', () => {
      expect(defaultExtractor(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(defaultExtractor(undefined)).toBeNull();
    });

    it('returns null for a plain string', () => {
      expect(defaultExtractor('just a string')).toBeNull();
    });

    it('returns null for a number', () => {
      expect(defaultExtractor(42)).toBeNull();
    });

    it('returns null for a bare array', () => {
      expect(defaultExtractor([{ usage: { input_tokens: 1, output_tokens: 1 } }])).toBeNull();
    });

    it('returns null for a circular reference and does not throw', () => {
      const circular = { usage: {} };
      circular.self = circular;
      circular.usage.self = circular;
      expect(() => defaultExtractor(circular)).not.toThrow();
      expect(defaultExtractor(circular)).toBeNull();
    });

    it('returns null for deeply nested garbage and does not throw', () => {
      const garbage = { a: { b: { c: { d: { e: [1, 2, { f: () => {} }] } } } }, usage: null, content: 12345 };
      expect(() => defaultExtractor(garbage)).not.toThrow();
      expect(defaultExtractor(garbage)).toBeNull();
    });

    it('returns null and does not throw when a property access throws', () => {
      const hostile = {
        get usage() {
          throw new Error('boom');
        },
      };
      expect(() => defaultExtractor(hostile)).not.toThrow();
      expect(defaultExtractor(hostile)).toBeNull();
    });

    it('never throws across a batch of malformed inputs', () => {
      const inputs = [{}, null, undefined, '', 0, NaN, [], {}, Symbol('x'), new Map(), new Set()];
      for (const input of inputs) {
        expect(() => defaultExtractor(input)).not.toThrow();
      }
    });
  });
});
