import { describe, it, expect } from 'vitest';
import { sanitizeSpanEvents, isSecurityListSpan, MAX_EVENTS_PER_SPAN, MAX_EVENT_STRING_LENGTH } from '../src/security-events.js';

/** ADR 033: the whitelist is the only thing the dashboard retains from span events. */

const changed = (extra = {}) => ({
  name: 'mcp.tool.integrity.changed',
  attributes: { 'gen_ai.tool.name': 't', 'mcp.tool.integrity.old_hash': 'sha256:aa', 'mcp.tool.integrity.new_hash': 'sha256:bb', ...extra },
});

describe('sanitizeSpanEvents', () => {
  it('keeps a whitelisted event with its whitelisted attributes and an optional time', () => {
    expect(sanitizeSpanEvents([{ ...changed(), timeMs: 5 }])).toEqual([
      { name: 'mcp.tool.integrity.changed', timeMs: 5, attributes: { 'gen_ai.tool.name': 't', 'mcp.tool.integrity.old_hash': 'sha256:aa', 'mcp.tool.integrity.new_hash': 'sha256:bb' } },
    ]);
  });

  it('drops unknown events and unknown attribute keys, whatever they contain', () => {
    const out = sanitizeSpanEvents([
      { name: 'exception', attributes: { 'exception.message': 'SECRET' } },
      { name: 'some.other', attributes: {} },
      changed({ 'mcp.tool.description': 'DESCRIPTION TEXT', arguments: 'SECRET' }),
    ]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|DESCRIPTION/);
  });

  it('only strings (capped), finite numbers and booleans survive as values', () => {
    const long = 'x'.repeat(MAX_EVENT_STRING_LENGTH + 500);
    const [e] = sanitizeSpanEvents([
      { name: 'mcp.audit.sensitive_call', attributes: { 'gen_ai.tool.name': long, 'mcp.tool.duration_ms': Number.NaN, 'mcp.tool.outcome': { x: 1 }, 'mcp.failure.category': ['a'] } },
    ]);
    expect(e.attributes['gen_ai.tool.name']).toHaveLength(MAX_EVENT_STRING_LENGTH);
    expect(Object.keys(e.attributes)).toEqual(['gen_ai.tool.name']);
    const [ok] = sanitizeSpanEvents([{ name: 'mcp.audit.sensitive_call', attributes: { 'mcp.tool.duration_ms': 12.5, 'mcp.tool.outcome': 'success' } }]);
    expect(ok.attributes).toEqual({ 'mcp.tool.duration_ms': 12.5, 'mcp.tool.outcome': 'success' });
  });

  it('keeps at most MAX_EVENTS_PER_SPAN events', () => {
    const many = Array.from({ length: 1000 }, () => changed());
    expect(sanitizeSpanEvents(many)).toHaveLength(MAX_EVENTS_PER_SPAN);
  });

  it('never throws on hostile input', () => {
    const cyclic = { name: 'mcp.audit.sensitive_call', attributes: {} };
    cyclic.attributes.self = cyclic;
    const getter = { get name() { throw new Error('boom'); } };
    for (const bad of [undefined, null, 5, 'x', {}, [null, 5, 'x', [], getter, cyclic], { length: 3 }]) {
      expect(() => sanitizeSpanEvents(bad)).not.toThrow();
    }
    expect(sanitizeSpanEvents([null, 5, { name: 5 }])).toEqual([]);
  });

  it('ignores a non-finite or non-number time', () => {
    const [e] = sanitizeSpanEvents([{ ...changed(), timeMs: Number.POSITIVE_INFINITY }]);
    expect('timeMs' in e).toBe(false);
  });
});

describe('isSecurityListSpan', () => {
  it('needs a tools/list name and at least one retained event', () => {
    expect(isSecurityListSpan('tools/list', [{}])).toBe(true);
    expect(isSecurityListSpan('tools/list', [])).toBe(false);
    expect(isSecurityListSpan('tools/call x', [{}])).toBe(false);
    expect(isSecurityListSpan(undefined, [{}])).toBe(false);
    expect(isSecurityListSpan('tools/list', undefined)).toBe(false);
  });
});
