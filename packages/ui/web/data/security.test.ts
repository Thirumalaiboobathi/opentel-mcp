import { describe, it, expect } from 'vitest';
import type { SerializedSpan } from '../../src/types.d.ts';
import { deriveSecurity, hashPrefix, hasBurst, BURST_THRESHOLD, BURST_WINDOW_MS } from './security';
import { buildDemoFixture } from '../../src/demo-fixture.js';

function span(over: Partial<SerializedSpan> = {}): SerializedSpan {
  return { id: Math.random().toString(16), traceId: 't', name: 'tools/call echo', toolName: 'echo', startTimeMs: 1_700_000_000_000, durationMs: 5, status: 'OK', attributes: {}, ...over };
}

describe('hashPrefix', () => {
  it('shows 12 hex characters after the sha256: prefix, never the whole hash', () => {
    expect(hashPrefix('sha256:' + 'ab12'.repeat(16))).toBe('ab12ab12ab12');
    expect(hashPrefix('abcdefghijklmnop')).toBe('abcdefghijkl');
    expect(hashPrefix(undefined)).toBe('—');
  });
});

describe('hasBurst', () => {
  it('needs BURST_THRESHOLD events inside one window', () => {
    const t = (n: number, gap: number) => Array.from({ length: n }, (_, i) => i * gap);
    expect(hasBurst(t(BURST_THRESHOLD, 1_000))).toBe(true);
    expect(hasBurst(t(BURST_THRESHOLD - 1, 1_000))).toBe(false);
    expect(hasBurst(t(BURST_THRESHOLD, BURST_WINDOW_MS))).toBe(false);
    expect(hasBurst([0, 1, 2, 3, BURST_WINDOW_MS + 10, BURST_WINDOW_MS + 11])).toBe(false);
    expect(hasBurst([0, 1, 2, 3, BURST_WINDOW_MS])).toBe(true);
  });
});

describe('deriveSecurity', () => {
  it('older cores / plain spans: nothing, so the panel is not rendered', () => {
    const data = deriveSecurity([span(), span({ status: 'ERROR', errorType: 'tool_error', failureCategory: 'validation' })]);
    expect(data.any).toBe(false);
    expect(deriveSecurity([]).any).toBe(false);
  });

  it('auth failures: only ERROR spans categorised auth, per tool, with burst detection', () => {
    const auth = (t: number, tool = 'send_email') => span({ toolName: tool, name: `tools/call ${tool}`, status: 'ERROR', errorType: 'tool_error', failureCategory: 'auth', startTimeMs: t });
    const burst = [0, 1, 2, 3, 4].map((i) => auth(1_000 + i * 1_000));
    const slow = [0, 1, 2, 3, 4].map((i) => auth(i * 3 * BURST_WINDOW_MS, 'slow_tool'));
    const rows = deriveSecurity([...burst, ...slow, span({ failureCategory: 'auth', status: 'OK' })]).auth;
    expect(rows).toEqual([
      { tool: 'send_email', failures: 5, burst: true },
      { tool: 'slow_tool', failures: 5, burst: false },
    ]);
  });

  it('secret leaks: counts calls, merges types, and maps any non-enum-looking type to "other"', () => {
    const leak = (types: unknown) => span({ toolName: 'read_file', attributes: { 'mcp.tool.secret_leak.detected': true, 'mcp.tool.secret_leak.types': types as string[] } });
    const rows = deriveSecurity([leak(['jwt']), leak(['aws_access_key_id', '<img src=x onerror=alert(1)>']), span({ toolName: 'read_file' })]).leaks;
    expect(rows).toEqual([{ tool: 'read_file', calls: 2, types: ['aws_access_key_id', 'jwt', 'other'] }]);
  });

  it('integrity events from any span, newest first; sensitive outcomes tallied; skew uses the largest lead', () => {
    const list = span({
      name: 'tools/list',
      toolName: undefined,
      events: [
        { name: 'mcp.tool.integrity.changed', timeMs: 10, attributes: { 'gen_ai.tool.name': 'a', 'mcp.tool.integrity.old_hash': 'sha256:1', 'mcp.tool.integrity.new_hash': 'sha256:2' } },
        { name: 'mcp.tool.integrity.pin_mismatch', timeMs: 20, attributes: { 'gen_ai.tool.name': 'a', 'mcp.tool.integrity.expected_hash': 'sha256:1', 'mcp.tool.integrity.actual_hash': 'sha256:2' } },
      ],
    });
    const call = (outcome: string) =>
      span({ toolName: 'wipe', events: [{ name: 'mcp.audit.sensitive_call', attributes: { 'gen_ai.tool.name': 'wipe', 'mcp.tool.outcome': outcome } }] });
    const q = (ms: number) => span({ toolName: 'get_quote', attributes: { 'mcp.tool.freshness.clock_skew_ms': ms } });
    const data = deriveSecurity([list, call('success'), call('silent_failure'), call('error'), call('bogus'), q(900), q(4_100)]);
    expect(data.integrity.map((f) => [f.kind, f.before, f.after])).toEqual([
      ['pin_mismatch', 'sha256:1', 'sha256:2'],
      ['changed', 'sha256:1', 'sha256:2'],
    ]);
    expect(data.sensitive).toEqual([{ tool: 'wipe', success: 1, silentFailure: 1, error: 1 }]);
    expect(data.skew).toEqual([{ tool: 'get_quote', calls: 2, maxMs: 4_100 }]);
  });

  it('hostile values never throw: wrong types, huge names, NaN skew', () => {
    const hostile = span({
      toolName: 'x'.repeat(10_000),
      attributes: { 'mcp.tool.freshness.clock_skew_ms': Number.NaN, 'mcp.tool.secret_leak.detected': true, 'mcp.tool.secret_leak.types': 'not-an-array' as unknown as string[] },
      events: [{ name: 'mcp.audit.sensitive_call', attributes: { 'gen_ai.tool.name': 5 as unknown as string } }],
    });
    const data = deriveSecurity([hostile]);
    expect(data.leaks[0]?.tool).toHaveLength(128);
    expect(data.skew).toEqual([]);
  });

  it('the demo fixture produces every section', () => {
    const data = deriveSecurity(buildDemoFixture());
    expect(data.any).toBe(true);
    expect(data.integrity.map((f) => f.kind).sort()).toEqual(['added', 'changed', 'pin_mismatch']);
    expect(data.leaks.map((r) => r.tool)).toEqual(['read_file']);
    expect(data.auth[0]).toEqual({ tool: 'send_email', failures: 5, burst: true });
    expect(data.sensitive.map((r) => r.tool).sort()).toEqual(['send_email', 'write_file']);
    expect(data.skew[0]?.maxMs).toBe(4_300);
  });
});
