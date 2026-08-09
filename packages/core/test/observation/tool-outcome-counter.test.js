import { describe, it, expect } from 'vitest';
import { ToolOutcomeCounter } from '../../src/observation/tool-outcome-counter.js';
import { resolveOptions } from '../../src/config.js';

describe('ToolOutcomeCounter', () => {
  it('counts a successful result', () => {
    const counter = new ToolOutcomeCounter();
    counter.recordResult({ content: [{ type: 'text', text: 'ok' }] });
    expect(counter.getCounts()).toEqual({ success: 1, failure: 0, unknown: 0 });
  });

  it('counts an isError: true result as a failure', () => {
    const counter = new ToolOutcomeCounter();
    counter.recordResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    expect(counter.getCounts()).toEqual({ success: 0, failure: 1, unknown: 0 });
  });

  it('counts a thrown/rejected call as a failure', () => {
    const counter = new ToolOutcomeCounter();
    counter.recordThrown();
    expect(counter.getCounts()).toEqual({ success: 0, failure: 1, unknown: 0 });
  });

  it('accumulates correctly across many mixed calls', () => {
    const counter = new ToolOutcomeCounter();
    for (let i = 0; i < 5; i++) counter.recordResult({ content: [] });
    for (let i = 0; i < 3; i++) counter.recordResult({ isError: true, content: [] });
    for (let i = 0; i < 2; i++) counter.recordThrown();

    expect(counter.getCounts()).toEqual({ success: 5, failure: 5, unknown: 0 });
  });

  describe('malformed results degrade to UNKNOWN, never throwing', () => {
    it.each([null, undefined, 'not-an-object', 42, true, []])('result = %p -> unknown', (malformed) => {
      const counter = new ToolOutcomeCounter();
      expect(() => counter.recordResult(malformed)).not.toThrow();
      expect(counter.getCounts()).toEqual({ success: 0, failure: 0, unknown: 1 });
    });

    it('a result whose isError getter itself throws degrades to unknown', () => {
      const counter = new ToolOutcomeCounter();
      const hostile = {
        get isError() {
          throw new Error('boom');
        },
      };
      expect(() => counter.recordResult(hostile)).not.toThrow();
      expect(counter.getCounts()).toEqual({ success: 0, failure: 0, unknown: 1 });
    });

    it('recordResult() called with no arguments at all degrades to unknown', () => {
      const counter = new ToolOutcomeCounter();
      expect(() => counter.recordResult()).not.toThrow();
      expect(counter.getCounts()).toEqual({ success: 0, failure: 0, unknown: 1 });
    });
  });

  describe('counts are unaffected by other features being disabled — the whole point of this phase', () => {
    // Each test below resolves real InstrumentOptions with the feature
    // flag disabled, to confirm the DISABLING actually took effect on
    // that unrelated config surface — then exercises a brand new
    // ToolOutcomeCounter, constructed and called with ZERO reference to
    // `resolved` at all. This demonstrates the independence structurally,
    // not just by observation: ToolOutcomeCounter's constructor and
    // record*() methods have no parameter that could even carry
    // `fingerprinting`/`thrashDetection`/`enableMetrics` through to it.

    it('is unaffected by fingerprinting: false', () => {
      const resolved = resolveOptions({ fingerprinting: false });
      expect(resolved.fingerprinting).toBe(false);

      const counter = new ToolOutcomeCounter();
      counter.recordResult({ content: [] });
      counter.recordResult({ isError: true, content: [] });
      counter.recordThrown();

      expect(counter.getCounts()).toEqual({ success: 1, failure: 2, unknown: 0 });
    });

    it('is unaffected by thrashDetection: { enabled: false }', () => {
      const resolved = resolveOptions({ thrashDetection: { enabled: false } });
      expect(resolved.thrashDetection.enabled).toBe(false);

      const counter = new ToolOutcomeCounter();
      counter.recordResult({ content: [] });
      counter.recordResult({ isError: true, content: [] });
      counter.recordThrown();

      expect(counter.getCounts()).toEqual({ success: 1, failure: 2, unknown: 0 });
    });

    it('is unaffected by enableMetrics: false', () => {
      const resolved = resolveOptions({ enableMetrics: false });
      expect(resolved.enableMetrics).toBe(false);

      const counter = new ToolOutcomeCounter();
      counter.recordResult({ content: [] });
      counter.recordResult({ isError: true, content: [] });
      counter.recordThrown();

      expect(counter.getCounts()).toEqual({ success: 1, failure: 2, unknown: 0 });
    });

    it('is unaffected even with all three disabled at once', () => {
      const resolved = resolveOptions({
        fingerprinting: false,
        thrashDetection: { enabled: false },
        enableMetrics: false,
      });
      expect(resolved.fingerprinting).toBe(false);
      expect(resolved.thrashDetection.enabled).toBe(false);
      expect(resolved.enableMetrics).toBe(false);

      const counter = new ToolOutcomeCounter();
      for (let i = 0; i < 4; i++) counter.recordResult({ content: [] });
      for (let i = 0; i < 2; i++) counter.recordResult({ isError: true, content: [] });
      counter.recordThrown();
      counter.recordResult(null);

      expect(counter.getCounts()).toEqual({ success: 4, failure: 3, unknown: 1 });
    });
  });
});
