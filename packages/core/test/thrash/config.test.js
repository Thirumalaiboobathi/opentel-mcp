import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveThrashConfig } from '../../src/thrash/config.js';

const ENV_KEYS = [
  'OTEL_MCP_THRASH_ENABLED',
  'OTEL_MCP_THRASH_THRESHOLD',
  'OTEL_MCP_THRASH_WINDOW_MS',
  'OTEL_MCP_THRASH_MAX_TRACKED_KEYS',
  'OTEL_MCP_THRASH_ENTRY_TTL_MS',
  'OTEL_MCP_THRASH_RE_EMIT_AFTER',
  'OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION',
  'OTEL_MCP_THRASH_INPUT_THRESHOLD',
  'OTEL_MCP_THRASH_NOT_FOUND_THRESHOLD',
];

let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const DEFAULTS = {
  enabled: true,
  threshold: 3,
  windowMs: 60_000,
  maxTrackedKeys: 1000,
  entryTtlMs: 900_000,
  reEmitAfter: 3,
  assumeSingleSession: false,
  inputThreshold: 5,
  notFoundThreshold: 1,
};

describe('resolveThrashConfig', () => {
  describe('defaults', () => {
    it('returns all documented defaults when called with no argument', () => {
      expect(resolveThrashConfig()).toEqual(DEFAULTS);
    });

    it('returns all documented defaults when called with an empty object', () => {
      expect(resolveThrashConfig({})).toEqual(DEFAULTS);
    });
  });

  describe('partial overrides', () => {
    it('overrides enabled', () => {
      expect(resolveThrashConfig({ enabled: false }).enabled).toBe(false);
    });

    it('overrides threshold', () => {
      expect(resolveThrashConfig({ threshold: 5 }).threshold).toBe(5);
    });

    it('overrides windowMs', () => {
      expect(resolveThrashConfig({ windowMs: 30_000 }).windowMs).toBe(30_000);
    });

    it('overrides maxTrackedKeys', () => {
      expect(resolveThrashConfig({ maxTrackedKeys: 500 }).maxTrackedKeys).toBe(500);
    });

    it('overrides entryTtlMs', () => {
      expect(resolveThrashConfig({ entryTtlMs: 60_000 }).entryTtlMs).toBe(60_000);
    });

    it('overrides reEmitAfter', () => {
      expect(resolveThrashConfig({ reEmitAfter: 1 }).reEmitAfter).toBe(1);
    });

    it('overrides assumeSingleSession', () => {
      expect(resolveThrashConfig({ assumeSingleSession: true }).assumeSingleSession).toBe(true);
    });

    it('overrides inputThreshold', () => {
      expect(resolveThrashConfig({ inputThreshold: 8 }).inputThreshold).toBe(8);
    });

    it('overrides notFoundThreshold', () => {
      expect(resolveThrashConfig({ notFoundThreshold: 2 }).notFoundThreshold).toBe(2);
    });

    it('leaves every other field at its default when only one is overridden', () => {
      expect(resolveThrashConfig({ threshold: 10 })).toEqual({ ...DEFAULTS, threshold: 10 });
    });
  });

  describe('env var overrides', () => {
    it('overrides enabled via OTEL_MCP_THRASH_ENABLED', () => {
      process.env.OTEL_MCP_THRASH_ENABLED = 'false';
      expect(resolveThrashConfig().enabled).toBe(false);
    });

    it('accepts "1"/"0" as well as "true"/"false" for OTEL_MCP_THRASH_ENABLED', () => {
      process.env.OTEL_MCP_THRASH_ENABLED = '0';
      expect(resolveThrashConfig().enabled).toBe(false);
      process.env.OTEL_MCP_THRASH_ENABLED = '1';
      expect(resolveThrashConfig().enabled).toBe(true);
    });

    it('overrides threshold via OTEL_MCP_THRASH_THRESHOLD', () => {
      process.env.OTEL_MCP_THRASH_THRESHOLD = '7';
      expect(resolveThrashConfig().threshold).toBe(7);
    });

    it('overrides windowMs via OTEL_MCP_THRASH_WINDOW_MS', () => {
      process.env.OTEL_MCP_THRASH_WINDOW_MS = '12345';
      expect(resolveThrashConfig().windowMs).toBe(12345);
    });

    it('overrides maxTrackedKeys via OTEL_MCP_THRASH_MAX_TRACKED_KEYS', () => {
      process.env.OTEL_MCP_THRASH_MAX_TRACKED_KEYS = '2000';
      expect(resolveThrashConfig().maxTrackedKeys).toBe(2000);
    });

    it('overrides entryTtlMs via OTEL_MCP_THRASH_ENTRY_TTL_MS', () => {
      process.env.OTEL_MCP_THRASH_ENTRY_TTL_MS = '1800000';
      expect(resolveThrashConfig().entryTtlMs).toBe(1_800_000);
    });

    it('overrides reEmitAfter via OTEL_MCP_THRASH_RE_EMIT_AFTER', () => {
      process.env.OTEL_MCP_THRASH_RE_EMIT_AFTER = '5';
      expect(resolveThrashConfig().reEmitAfter).toBe(5);
    });

    it('overrides assumeSingleSession via OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION', () => {
      process.env.OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION = 'true';
      expect(resolveThrashConfig().assumeSingleSession).toBe(true);
    });

    it('falls back to the default for an unrecognized OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION value', () => {
      process.env.OTEL_MCP_THRASH_ASSUME_SINGLE_SESSION = 'sure';
      expect(resolveThrashConfig().assumeSingleSession).toBe(false);
    });

    it('overrides inputThreshold via OTEL_MCP_THRASH_INPUT_THRESHOLD', () => {
      process.env.OTEL_MCP_THRASH_INPUT_THRESHOLD = '8';
      expect(resolveThrashConfig().inputThreshold).toBe(8);
    });

    it('overrides notFoundThreshold via OTEL_MCP_THRASH_NOT_FOUND_THRESHOLD', () => {
      process.env.OTEL_MCP_THRASH_NOT_FOUND_THRESHOLD = '2';
      expect(resolveThrashConfig().notFoundThreshold).toBe(2);
    });

    it('a partial field wins over a conflicting env var for that same field', () => {
      process.env.OTEL_MCP_THRASH_THRESHOLD = '99';
      expect(resolveThrashConfig({ threshold: 2 }).threshold).toBe(2);
    });
  });

  describe('invalid/unparseable input falls back to defaults silently', () => {
    it('never throws for a garbage env value', () => {
      process.env.OTEL_MCP_THRASH_THRESHOLD = 'not-a-number';
      expect(() => resolveThrashConfig()).not.toThrow();
      expect(resolveThrashConfig().threshold).toBe(DEFAULTS.threshold);
    });

    it('falls back for a non-boolean-looking OTEL_MCP_THRASH_ENABLED', () => {
      process.env.OTEL_MCP_THRASH_ENABLED = 'yes-please';
      expect(resolveThrashConfig().enabled).toBe(DEFAULTS.enabled);
    });

    it('falls back for a non-integer (float) env value', () => {
      process.env.OTEL_MCP_THRASH_WINDOW_MS = '1000.5';
      expect(resolveThrashConfig().windowMs).toBe(DEFAULTS.windowMs);
    });

    it('falls back for an empty-string env value', () => {
      process.env.OTEL_MCP_THRASH_MAX_TRACKED_KEYS = '';
      expect(resolveThrashConfig().maxTrackedKeys).toBe(DEFAULTS.maxTrackedKeys);
    });

    it('falls back for a garbage partial value (wrong type)', () => {
      expect(resolveThrashConfig({ threshold: 'three' }).threshold).toBe(DEFAULTS.threshold);
      expect(resolveThrashConfig({ enabled: 'yes' }).enabled).toBe(DEFAULTS.enabled);
    });

    it('never throws for null/undefined/array partial values', () => {
      expect(() => resolveThrashConfig({ threshold: null })).not.toThrow();
      expect(() => resolveThrashConfig({ threshold: [3] })).not.toThrow();
      expect(resolveThrashConfig({ threshold: null }).threshold).toBe(DEFAULTS.threshold);
    });
  });

  describe('out-of-range values clamp to defaults', () => {
    it('a negative threshold (partial) clamps to the default', () => {
      expect(resolveThrashConfig({ threshold: -1 }).threshold).toBe(DEFAULTS.threshold);
    });

    it('a zero maxTrackedKeys (partial) clamps to the default', () => {
      expect(resolveThrashConfig({ maxTrackedKeys: 0 }).maxTrackedKeys).toBe(DEFAULTS.maxTrackedKeys);
    });

    it('a negative threshold (env) clamps to the default', () => {
      process.env.OTEL_MCP_THRASH_THRESHOLD = '-5';
      expect(resolveThrashConfig().threshold).toBe(DEFAULTS.threshold);
    });

    it('a zero maxTrackedKeys (env) clamps to the default', () => {
      process.env.OTEL_MCP_THRASH_MAX_TRACKED_KEYS = '0';
      expect(resolveThrashConfig().maxTrackedKeys).toBe(DEFAULTS.maxTrackedKeys);
    });

    it('clamps every other numeric field to its default when given zero or negative', () => {
      expect(resolveThrashConfig({ windowMs: 0 }).windowMs).toBe(DEFAULTS.windowMs);
      expect(resolveThrashConfig({ entryTtlMs: -100 }).entryTtlMs).toBe(DEFAULTS.entryTtlMs);
      expect(resolveThrashConfig({ reEmitAfter: 0 }).reEmitAfter).toBe(DEFAULTS.reEmitAfter);
      expect(resolveThrashConfig({ inputThreshold: 0 }).inputThreshold).toBe(DEFAULTS.inputThreshold);
      expect(resolveThrashConfig({ notFoundThreshold: -1 }).notFoundThreshold).toBe(DEFAULTS.notFoundThreshold);
    });
  });

  it('never throws, across a batch of hostile inputs', () => {
    const inputs = [undefined, null, {}, { threshold: NaN }, { windowMs: Infinity }, { enabled: {} }, { maxTrackedKeys: -Infinity }];
    for (const input of inputs) {
      expect(() => resolveThrashConfig(input)).not.toThrow();
    }
  });
});
