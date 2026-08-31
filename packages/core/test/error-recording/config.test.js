import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveErrorRecordingConfig } from '../../src/error-recording/config.js';

const ENV_KEYS = ['OTEL_MCP_ERROR_RECORDING_MODE'];

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

const DEFAULTS = { mode: 'full' };

describe('resolveErrorRecordingConfig', () => {
  describe('defaults', () => {
    it('returns { mode: "full" } when called with no argument', () => {
      expect(resolveErrorRecordingConfig()).toEqual(DEFAULTS);
    });

    it('returns { mode: "full" } when called with an empty object', () => {
      expect(resolveErrorRecordingConfig({})).toEqual(DEFAULTS);
    });
  });

  describe('partial overrides', () => {
    it('overrides mode to "normalized"', () => {
      expect(resolveErrorRecordingConfig({ mode: 'normalized' }).mode).toBe('normalized');
    });

    it('overrides mode to "none"', () => {
      expect(resolveErrorRecordingConfig({ mode: 'none' }).mode).toBe('none');
    });

    it('accepts an explicit "full" (a no-op relative to the default)', () => {
      expect(resolveErrorRecordingConfig({ mode: 'full' }).mode).toBe('full');
    });
  });

  describe('env var override', () => {
    it('overrides mode via OTEL_MCP_ERROR_RECORDING_MODE', () => {
      process.env.OTEL_MCP_ERROR_RECORDING_MODE = 'normalized';
      expect(resolveErrorRecordingConfig().mode).toBe('normalized');
    });

    it('accepts "none" via the env var', () => {
      process.env.OTEL_MCP_ERROR_RECORDING_MODE = 'none';
      expect(resolveErrorRecordingConfig().mode).toBe('none');
    });

    it('an explicit option value wins over the env var', () => {
      process.env.OTEL_MCP_ERROR_RECORDING_MODE = 'none';
      expect(resolveErrorRecordingConfig({ mode: 'normalized' }).mode).toBe('normalized');
    });
  });

  describe('invalid values fall back silently, never throw', () => {
    it('an unrecognized option value falls back to "full"', () => {
      expect(() => resolveErrorRecordingConfig({ mode: 'normalised' })).not.toThrow();
      expect(resolveErrorRecordingConfig({ mode: 'normalised' }).mode).toBe('full');
    });

    it('a non-string option value falls back to "full"', () => {
      expect(resolveErrorRecordingConfig({ mode: 42 }).mode).toBe('full');
      expect(resolveErrorRecordingConfig({ mode: null }).mode).toBe('full');
      expect(resolveErrorRecordingConfig({ mode: true }).mode).toBe('full');
    });

    it('an unrecognized env var value falls back to "full"', () => {
      process.env.OTEL_MCP_ERROR_RECORDING_MODE = 'YOLO';
      expect(resolveErrorRecordingConfig().mode).toBe('full');
    });

    it('an empty-string env var value falls back to "full"', () => {
      process.env.OTEL_MCP_ERROR_RECORDING_MODE = '';
      expect(resolveErrorRecordingConfig().mode).toBe('full');
    });
  });
});
