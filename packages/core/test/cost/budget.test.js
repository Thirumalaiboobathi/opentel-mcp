import { describe, it, expect } from 'vitest';
import { createBudgetTracker } from '../../src/cost/budget.js';

describe('createBudgetTracker', () => {
  it('never exceeds when no budget is configured', () => {
    const tracker = createBudgetTracker(undefined);
    for (let i = 0; i < 20; i++) {
      expect(tracker.recordAndCheck('session-1', 'tool-a', 1_000_000)).toEqual({ exceeded: false, scope: null });
    }
  });

  describe('session-only budget', () => {
    it('flags exceeded once cumulative session cost crosses perSessionUsd', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 5 });
      expect(tracker.recordAndCheck('s1', 'tool', 3)).toEqual({ exceeded: false, scope: null });
      expect(tracker.recordAndCheck('s1', 'tool', 2)).toEqual({ exceeded: false, scope: null }); // total 5, not > 5
      expect(tracker.recordAndCheck('s1', 'tool', 0.01)).toEqual({ exceeded: true, scope: 'session' }); // total 5.01
    });

    it('never checks tool budget when only perSessionUsd is configured', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 1000 });
      expect(tracker.recordAndCheck('s1', 'tool', 1)).toEqual({ exceeded: false, scope: null });
    });
  });

  describe('tool-only budget', () => {
    it('flags exceeded once cumulative tool cost crosses perToolUsd', () => {
      const tracker = createBudgetTracker({ perToolUsd: 2 });
      expect(tracker.recordAndCheck('s1', 'search', 1)).toEqual({ exceeded: false, scope: null });
      expect(tracker.recordAndCheck('s2', 'search', 1.5)).toEqual({ exceeded: true, scope: 'tool' }); // 2.5 across sessions
    });

    it('never checks session budget when only perToolUsd is configured', () => {
      const tracker = createBudgetTracker({ perToolUsd: 1000 });
      expect(tracker.recordAndCheck('s1', 'tool', 1)).toEqual({ exceeded: false, scope: null });
    });
  });

  describe('both configured', () => {
    it('prefers "session" when a single call crosses both limits at once', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 1, perToolUsd: 1 });
      expect(tracker.recordAndCheck('s1', 'tool', 5)).toEqual({ exceeded: true, scope: 'session' });
    });

    it('reports "tool" when only the tool limit is crossed', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 100, perToolUsd: 1 });
      expect(tracker.recordAndCheck('s1', 'tool', 5)).toEqual({ exceeded: true, scope: 'tool' });
    });

    it('reports "session" when only the session limit is crossed', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 1, perToolUsd: 100 });
      expect(tracker.recordAndCheck('s1', 'tool', 5)).toEqual({ exceeded: true, scope: 'session' });
    });
  });

  describe('no session id available', () => {
    it('skips session tracking gracefully for undefined sessionId, tool budget still works', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 0.01, perToolUsd: 5 });
      // Called many times with no session id — session budget (tiny limit) never trips.
      for (let i = 0; i < 10; i++) {
        const result = tracker.recordAndCheck(undefined, 'tool', 1);
        expect(result.scope).not.toBe('session');
      }
      // Tool budget still accumulates normally and eventually trips.
      expect(tracker.recordAndCheck(undefined, 'tool', 100)).toEqual({ exceeded: true, scope: 'tool' });
    });

    it('skips session tracking gracefully for an empty-string sessionId', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 0.01 });
      expect(tracker.recordAndCheck('', 'tool', 1000)).toEqual({ exceeded: false, scope: null });
    });

    it('skips tool tracking gracefully for an undefined toolName', () => {
      const tracker = createBudgetTracker({ perToolUsd: 0.01 });
      expect(tracker.recordAndCheck('s1', undefined, 1000)).toEqual({ exceeded: false, scope: null });
    });
  });

  describe('edge cases', () => {
    it('a budget of 0 is exceeded by any positive cost', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 0 });
      expect(tracker.recordAndCheck('s1', 'tool', 0.000001)).toEqual({ exceeded: true, scope: 'session' });
    });

    it('a budget of 0 is not exceeded by a cost of exactly 0', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 0 });
      expect(tracker.recordAndCheck('s1', 'tool', 0)).toEqual({ exceeded: false, scope: null });
    });

    it('a very large budget is never exceeded by realistic costs', () => {
      const tracker = createBudgetTracker({ perSessionUsd: Number.MAX_SAFE_INTEGER });
      for (let i = 0; i < 1000; i++) {
        expect(tracker.recordAndCheck('s1', 'tool', 10).exceeded).toBe(false);
      }
    });

    it('never throws for non-numeric or NaN costUsd, and does not poison the running total', () => {
      const tracker = createBudgetTracker({ perToolUsd: 1 });
      expect(() => tracker.recordAndCheck('s1', 'tool', NaN)).not.toThrow();
      expect(() => tracker.recordAndCheck('s1', 'tool', 'not-a-number')).not.toThrow();
      expect(tracker.recordAndCheck('s1', 'tool', NaN)).toEqual({ exceeded: false, scope: null });
      // A subsequent valid call still accumulates correctly (total wasn't NaN-poisoned).
      expect(tracker.recordAndCheck('s1', 'tool', 0.5).exceeded).toBe(false);
      expect(tracker.recordAndCheck('s1', 'tool', 0.6)).toEqual({ exceeded: true, scope: 'tool' });
    });

    it('never throws for garbage sessionId/toolName types', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 1, perToolUsd: 1 });
      expect(() => tracker.recordAndCheck(42, {}, 5)).not.toThrow();
      expect(() => tracker.recordAndCheck(null, [], 5)).not.toThrow();
      expect(() => tracker.recordAndCheck(Symbol('x'), () => {}, 5)).not.toThrow();
    });
  });

  describe('independent accumulation', () => {
    it('accumulates multiple tools independently', () => {
      const tracker = createBudgetTracker({ perToolUsd: 5 });
      expect(tracker.recordAndCheck('s1', 'search', 4)).toEqual({ exceeded: false, scope: null });
      expect(tracker.recordAndCheck('s1', 'fetch', 4)).toEqual({ exceeded: false, scope: null });
      // Neither tool alone is over 5 yet.
      expect(tracker.recordAndCheck('s1', 'search', 1.5)).toEqual({ exceeded: true, scope: 'tool' }); // search: 5.5
      expect(tracker.recordAndCheck('s1', 'fetch', 0.5)).toEqual({ exceeded: false, scope: null }); // fetch: 4.5, still under
    });

    it('accumulates multiple sessions independently', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 5 });
      expect(tracker.recordAndCheck('session-a', 'tool', 4.99)).toEqual({ exceeded: false, scope: null });
      expect(tracker.recordAndCheck('session-b', 'tool', 4.99)).toEqual({ exceeded: false, scope: null });
      expect(tracker.recordAndCheck('session-a', 'tool', 0.02)).toEqual({ exceeded: true, scope: 'session' });
      // session-b is unaffected by session-a crossing its limit.
      expect(tracker.recordAndCheck('session-b', 'tool', 0.001)).toEqual({ exceeded: false, scope: null });
    });
  });

  describe('cumulative math correctness', () => {
    it('trips exactly on the call that pushes the total over the limit, not before or after', () => {
      const tracker = createBudgetTracker({ perToolUsd: 5 });
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(tracker.recordAndCheck('s1', 'tool', 1).exceeded);
      }
      // Totals after each $1 call: 1,2,3,4,5,6,7,8,9,10 — only index 5 (total 6) onward is exceeded.
      expect(results).toEqual([false, false, false, false, false, true, true, true, true, true]);
    });

    it('once exceeded, stays exceeded on every later call (never resets)', () => {
      const tracker = createBudgetTracker({ perSessionUsd: 1 });
      expect(tracker.recordAndCheck('s1', 'tool', 2)).toEqual({ exceeded: true, scope: 'session' });
      expect(tracker.recordAndCheck('s1', 'tool', 0.001)).toEqual({ exceeded: true, scope: 'session' });
      expect(tracker.recordAndCheck('s1', 'tool', 0.001)).toEqual({ exceeded: true, scope: 'session' });
    });
  });
});
