import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { compileSensitiveTools, MAX_SENSITIVE_PATTERNS } from '../src/sensitive-tools.js';
import { SHAPES, createHarness, lastToolSpan } from './helpers/security-harness.js';

/** ADR 032: sensitiveTools, mcp.tool.sensitive, mcp.audit.sensitive_call. */

const ok = () => ({ content: [{ type: 'text', text: 'done' }] });
const silent = () => ({ isError: true, content: [{ type: 'text', text: 'Access denied' }] });
const auditEvents = (span) => span.events.filter((e) => e.name === 'mcp.audit.sensitive_call');

describe('compileSensitiveTools', () => {
  let warn;
  beforeEach(() => {
    warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  });
  afterEach(() => diag.disable());

  it('undefined, [] and all-invalid lists mean "off" (null)', () => {
    expect(compileSensitiveTools(undefined)).toBeNull();
    expect(compileSensitiveTools([])).toBeNull();
    expect(compileSensitiveTools([1, '', null])).toBeNull();
  });

  it('exact names match exactly, case-sensitively', () => {
    const m = compileSensitiveTools(['delete_record']);
    expect(m.matches('delete_record')).toBe(true);
    expect(m.matches('delete_records')).toBe(false);
    expect(m.matches('Delete_record')).toBe(false);
    expect(m.matches('xdelete_record')).toBe(false);
  });

  it('* matches any run of characters, including none, and is anchored at both ends', () => {
    const m = compileSensitiveTools(['delete_*', '*_admin', 'a*b*c', '*']);
    // '*' alone matches everything
    expect(m.matches('whatever')).toBe(true);
    const only = (p) => compileSensitiveTools([p]);
    expect(only('delete_*').matches('delete_')).toBe(true);
    expect(only('delete_*').matches('delete_all_things')).toBe(true);
    expect(only('delete_*').matches('xdelete_all')).toBe(false);
    expect(only('*_admin').matches('super_admin')).toBe(true);
    expect(only('*_admin').matches('super_admins')).toBe(false);
    expect(only('a*b*c').matches('abc')).toBe(true);
    expect(only('a*b*c').matches('aXbYc')).toBe(true);
    expect(only('a*b*c').matches('acb')).toBe(false);
    expect(only('ab*ba').matches('aba')).toBe(false);
    expect(only('ab*ba').matches('abba')).toBe(true);
    expect(only('a**b').matches('ab')).toBe(true);
  });

  it('regex metacharacters and ? are literal', () => {
    const m = compileSensitiveTools(['a.b', 'x?y', '(z)+']);
    expect(m.matches('a.b')).toBe(true);
    expect(m.matches('aXb')).toBe(false);
    expect(m.matches('xy')).toBe(false);
    expect(m.matches('x?y')).toBe(true);
    expect(m.matches('(z)+')).toBe(true);
  });

  it('non-string tool names never match and never throw', () => {
    const m = compileSensitiveTools(['*']);
    for (const bad of [undefined, null, 5, {}, [], Symbol('x')]) expect(m.matches(bad)).toBe(false);
  });

  it('invalid entries warn once (a single message) and are skipped; valid ones still work', () => {
    const m = compileSensitiveTools(['ok', 42, '', 'x'.repeat(257), null]);
    expect(m.matches('ok')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('4 entries were skipped');
  });

  it('a non-array value warns once and is ignored', () => {
    expect(compileSensitiveTools('delete_*')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('more than MAX_SENSITIVE_PATTERNS entries: the rest are ignored with one warning', () => {
    const list = Array.from({ length: MAX_SENSITIVE_PATTERNS + 5 }, (_, i) => `tool_${i}`);
    const m = compileSensitiveTools(list);
    expect(m.size).toBe(MAX_SENSITIVE_PATTERNS);
    expect(m.matches('tool_0')).toBe(true);
    expect(m.matches(`tool_${MAX_SENSITIVE_PATTERNS + 1}`)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a throwing getter / proxy never throws', () => {
    const hostile = new Proxy([], {
      get() {
        throw new Error('boom');
      },
    });
    // Array.isArray(proxy of array) is true; iterating throws.
    expect(() => compileSensitiveTools(hostile)).not.toThrow();
  });

  it('adversarial pattern and name stay linear: many wildcards against a long near-match', () => {
    const m = compileSensitiveTools(['a*a*a*a*a*a*a*a*a*a*a*b']);
    const name = 'a'.repeat(1000) + 'c';
    const start = performance.now();
    for (let i = 0; i < 200; i++) expect(m.matches(name)).toBe(false);
    // Structural property: a backtracking regex would take exponential time here; a linear glob is far under a second.
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('names longer than 1024 characters never match a wildcard (bounded work), exact still works', () => {
    const m = compileSensitiveTools(['*', 'x']);
    expect(m.matches('y'.repeat(2000))).toBe(false);
    expect(m.matches('x')).toBe(true);
  });
});

describe('sensitive tool audit on real spans', () => {
  let h;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.teardown());

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('success: attribute set at start, one audit event with outcome, duration, and the span trace context', async () => {
        const t = shape.build({ sensitiveTools: ['get_*'] }, ok);
        await t.call();
        const span = lastToolSpan(h);
        expect(span.attributes['mcp.tool.sensitive']).toBe(true);
        const events = auditEvents(span);
        expect(events).toHaveLength(1);
        expect(events[0].attributes).toMatchObject({ 'gen_ai.tool.name': 'get_quote', 'mcp.tool.outcome': 'success' });
        expect(typeof events[0].attributes['mcp.tool.duration_ms']).toBe('number');
        expect(events[0].attributes['mcp.tool.duration_ms']).toBeGreaterThanOrEqual(0);
        expect('mcp.failure.category' in events[0].attributes).toBe(false);
        expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      });

      it('silent failure: outcome silent_failure and the failure category', async () => {
        const t = shape.build({ sensitiveTools: ['get_quote'] }, silent);
        await t.call();
        const events = auditEvents(lastToolSpan(h));
        expect(events).toHaveLength(1);
        expect(events[0].attributes['mcp.tool.outcome']).toBe('silent_failure');
        expect(events[0].attributes['mcp.failure.category']).toBe('auth');
      });

      it('a tool not on the list: no attribute, no event', async () => {
        const t = shape.build({ sensitiveTools: ['delete_*'] }, ok);
        await t.call();
        const span = lastToolSpan(h);
        expect('mcp.tool.sensitive' in span.attributes).toBe(false);
        expect(auditEvents(span)).toEqual([]);
      });

      it('default (no option): spans carry nothing new', async () => {
        const t = shape.build({}, ok);
        await t.call();
        const span = lastToolSpan(h);
        expect(Object.keys(span.attributes).some((k) => k.startsWith('mcp.tool.sensitive'))).toBe(false);
        expect(span.events.some((e) => e.name.startsWith('mcp.audit'))).toBe(false);
      });
    });
  }

  it('thrown error: outcome error, error category, and the error still propagates (low-level Server)', async () => {
    const boom = Object.assign(new Error('403 Forbidden'), { status: 403 });
    const t = SHAPES[2].build({ sensitiveTools: ['get_quote'] }, () => {
      throw boom;
    });
    await expect(t.call()).rejects.toBe(boom);
    const events = auditEvents(lastToolSpan(h));
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toMatchObject({ 'mcp.tool.outcome': 'error', 'mcp.failure.category': 'auth' });
  });

  it('adds no metric', async () => {
    const t = SHAPES[2].build({ sensitiveTools: ['get_quote'] }, ok);
    await t.call();
    const names = (await h.allMetrics()).map((m) => m.descriptor.name);
    expect(names.some((n) => n.includes('sensitive'))).toBe(false);
  });

  it('invalid option never throws the instrumentation or the call', async () => {
    for (const bad of ['delete_*', 5, { a: 1 }, [null, 5]]) {
      const t = SHAPES[2].build({ sensitiveTools: bad }, ok);
      await expect(t.call()).resolves.toBeDefined();
    }
  });

  it('canary: arguments, results and error text never reach spans, events, metrics or logs', async () => {
    const CANARY = 'CANARY-SENS-4b2e';
    const t = SHAPES[2].build({ sensitiveTools: ['get_quote'] }, () => ({
      isError: true,
      content: [{ type: 'text', text: `denied ${CANARY}` }],
      structuredContent: { leak: CANARY },
    }));
    await t.call('get_quote', { password: CANARY, nested: { x: [CANARY] } });
    const dump =
      JSON.stringify(h.spans().map((s) => [s.name, s.attributes, s.events, s.status])) +
      JSON.stringify(await h.allMetrics()) +
      h.diagLines.join('\n');
    expect(dump).not.toContain(CANARY);
  });
});
