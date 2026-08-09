import { describe, it, expect, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { detectObservationIntegrity, OBSERVATION_INTEGRITY } from '../../src/observation/integrity.js';

afterEach(() => {
  trace.disable();
  vi.restoreAllMocks();
});

describe('detectObservationIntegrity', () => {
  it('OBSERVATION_INTEGRITY has exactly DEGRADED and UNKNOWN — no HEALTHY value exists', () => {
    expect(Object.values(OBSERVATION_INTEGRITY).sort()).toEqual(['DEGRADED', 'UNKNOWN']);
    expect(OBSERVATION_INTEGRITY).not.toHaveProperty('HEALTHY');
    expect(Object.isFrozen(OBSERVATION_INTEGRITY)).toBe(true);
  });

  describe('setupNodeSdk: false (host-owned provider)', () => {
    it('returns DEGRADED when no TracerProvider has been registered at all', () => {
      // Deliberately no trace.setGlobalTracerProvider() anywhere in this
      // test -- the default no-op state is exactly the "no delegate set"
      // condition this check confirms.
      expect(detectObservationIntegrity(false)).toBe(OBSERVATION_INTEGRITY.DEGRADED);
    });

    it('returns UNKNOWN, never a HEALTHY-shaped value, when a real TracerProvider is registered', () => {
      const provider = new NodeTracerProvider();
      provider.register();

      const result = detectObservationIntegrity(false);

      expect(result).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
      // Explicit, structural assertion per the task: HEALTHY must not
      // exist as a possible outcome at all, not merely "not returned
      // this time."
      expect(result).not.toBe('HEALTHY');
      expect(Object.values(OBSERVATION_INTEGRITY)).not.toContain('HEALTHY');
    });
  });

  describe('setupNodeSdk: true (opentel-mcp owns the provider)', () => {
    it('always returns UNKNOWN when no provider happens to be registered globally either', () => {
      expect(detectObservationIntegrity(true)).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
    });

    it('always returns UNKNOWN even when a real TracerProvider IS registered — there is nothing left to detect', () => {
      const provider = new NodeTracerProvider();
      provider.register();

      expect(detectObservationIntegrity(true)).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
    });

    it('never even invokes the fragile absence-check when setupNodeSdk is true', () => {
      const spy = vi.spyOn(trace, 'getTracerProvider');
      detectObservationIntegrity(true);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('fragility: never a wrong confident answer', () => {
    it('degrades to UNKNOWN, without throwing, if the check itself throws', () => {
      vi.spyOn(trace, 'getTracerProvider').mockImplementation(() => {
        throw new Error('deliberately broken for this test');
      });

      expect(() => detectObservationIntegrity(false)).not.toThrow();
      expect(detectObservationIntegrity(false)).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
    });

    it('degrades to UNKNOWN, without throwing, when the registered provider is not shaped like a ProxyTracerProvider', () => {
      // Simulates a future @opentelemetry/api version changing
      // trace.getTracerProvider()'s return shape, or a dual-package-
      // hazard scenario handing back a provider from a different copy of
      // the API -- either way, no getDelegate() method to call.
      vi.spyOn(trace, 'getTracerProvider').mockReturnValue({ notAProxyTracerProvider: true });

      expect(() => detectObservationIntegrity(false)).not.toThrow();
      expect(detectObservationIntegrity(false)).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
    });

    it('degrades to UNKNOWN, without throwing, when getDelegate() itself throws', () => {
      vi.spyOn(trace, 'getTracerProvider').mockReturnValue({
        getDelegate() {
          throw new Error('getDelegate is broken');
        },
      });

      expect(() => detectObservationIntegrity(false)).not.toThrow();
      expect(detectObservationIntegrity(false)).toBe(OBSERVATION_INTEGRITY.UNKNOWN);
    });

    it('never throws regardless of the setupNodeSdk argument type', () => {
      expect(() => detectObservationIntegrity(undefined)).not.toThrow();
      expect(() => detectObservationIntegrity(null)).not.toThrow();
      expect(() => detectObservationIntegrity('not-a-boolean')).not.toThrow();
    });
  });
});
