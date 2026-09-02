import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag } from '@opentelemetry/api';
import { resolveErrorRecordingConfig, __resetRedactorNoOpWarnedForTests } from '../../src/error-recording/config.js';

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

  // ADR 020 (docs/adr/020-redactor-hook.md), v0.14.0 Phase 1.
  describe('redactor', () => {
    beforeEach(() => {
      __resetRedactorNoOpWarnedForTests();
    });

    it('is undefined by default', () => {
      expect(resolveErrorRecordingConfig().redactor).toBeUndefined();
      expect(resolveErrorRecordingConfig({}).redactor).toBeUndefined();
    });

    it('accepts a function under mode "normalized"', () => {
      const redactor = () => ({ message: 'x', stack: undefined });
      expect(resolveErrorRecordingConfig({ mode: 'normalized', redactor }).redactor).toBe(redactor);
    });

    describe('invalid values degrade silently to undefined, never throw', () => {
      it.each([
        ['a string', 'not-a-function'],
        ['a number', 42],
        ['null', null],
        ['true', true],
        ['a plain object', { message: 'x' }],
      ])('%s falls back to no redactor', (_label, value) => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        expect(() => resolveErrorRecordingConfig({ mode: 'normalized', redactor: value })).not.toThrow();
        expect(resolveErrorRecordingConfig({ mode: 'normalized', redactor: value }).redactor).toBeUndefined();
        // An invalid redactor is treated as absent — never triggers the
        // separate "configured but mode isn't normalized" warning below.
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    describe('mode-mismatch warning (Decision 6)', () => {
      it('warns once when a valid redactor is configured alongside the default "full" mode', () => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        resolveErrorRecordingConfig({ redactor: () => ({ message: 'x', stack: undefined }) });
        const matches = warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg));
        expect(matches).toHaveLength(1);
        expect(matches[0][0]).toMatch(/mode is 'full'/);
        warnSpy.mockRestore();
      });

      it('warns once when configured alongside mode "none"', () => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        resolveErrorRecordingConfig({ mode: 'none', redactor: () => ({ message: 'x', stack: undefined }) });
        const matches = warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg));
        expect(matches).toHaveLength(1);
        expect(matches[0][0]).toMatch(/mode is 'none'/);
        warnSpy.mockRestore();
      });

      it('does not warn when configured alongside mode "normalized"', () => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        resolveErrorRecordingConfig({ mode: 'normalized', redactor: () => ({ message: 'x', stack: undefined }) });
        const matches = warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg));
        expect(matches).toHaveLength(0);
        warnSpy.mockRestore();
      });

      it('does not warn when no redactor is configured, regardless of mode', () => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        resolveErrorRecordingConfig({ mode: 'full' });
        resolveErrorRecordingConfig({ mode: 'none' });
        const matches = warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg));
        expect(matches).toHaveLength(0);
        warnSpy.mockRestore();
      });

      it('fires only once per process across multiple resolveErrorRecordingConfig() calls', () => {
        const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
        const redactor = () => ({ message: 'x', stack: undefined });
        resolveErrorRecordingConfig({ mode: 'full', redactor });
        resolveErrorRecordingConfig({ mode: 'full', redactor });
        resolveErrorRecordingConfig({ mode: 'none', redactor });
        const matches = warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg));
        expect(matches).toHaveLength(1);
        warnSpy.mockRestore();
      });
    });
  });
});
