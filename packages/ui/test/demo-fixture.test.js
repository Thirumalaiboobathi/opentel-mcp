import { describe, it, expect } from 'vitest';
import { buildDemoFixture } from '../src/demo-fixture.js';
import { computeSummary } from '../src/summary.js';
import { SpanBuffer } from '../src/span-buffer.js';
import { isToolCallSpan } from '../src/span-method.js';
import { computeToolHealth } from '../web/data/healthGrades.ts';

describe('buildDemoFixture', () => {
  it('produces a realistic mix matching the design brief\'s worked example (42 success, 7 visible failures, 11 missed-by-otel failures)', () => {
    const spans = buildDemoFixture();
    const buffer = new SpanBuffer({ capacity: spans.length });
    for (const span of spans) buffer.push(span);

    const { buffered } = computeSummary({ instrumentedServer: {}, buffer });
    expect(buffered).toEqual({ total: 60, success: 42, error: 7, silentFailure: 11 });
  });

  it('every span is well-formed (unique id, MCP method name, valid status)', () => {
    const spans = buildDemoFixture();
    const ids = new Set(spans.map((s) => s.id));
    expect(ids.size).toBe(spans.length);
    for (const span of spans) {
      expect(span.name).toMatch(/^(tools\/call |resources\/|prompts\/)/);
      expect(['OK', 'ERROR']).toContain(span.status);
    }
  });

  it('includes resource and prompt calls (ADR 026), with failures, and none carries a tool name or URI', () => {
    const spans = buildDemoFixture().filter((s) => !s.name.startsWith('tools/call'));
    const methods = new Set(spans.map((s) => s.attributes['mcp.method.name']));
    expect(methods).toEqual(new Set(['resources/read', 'resources/list', 'resources/templates/list', 'prompts/get', 'prompts/list']));
    expect(spans.some((s) => s.status === 'ERROR')).toBe(true);
    for (const s of spans) {
      expect(s.toolName).toBeUndefined();
      expect(JSON.stringify(s)).not.toMatch(/:\/\//);
    }
  });

  it('silent failures use errorType tool_error; visible failures never do', () => {
    const spans = buildDemoFixture().filter(isToolCallSpan);
    const visible = spans.filter((s) => s.status === 'ERROR' && s.errorType !== 'tool_error');
    const missed = spans.filter((s) => s.errorType === 'tool_error');
    expect(visible).toHaveLength(7);
    expect(missed).toHaveLength(11);
    expect(missed.every((s) => s.status === 'ERROR')).toBe(true);
  });

  it('grades out to a realistic spread across tools, not all A or all F (docs/health-grades.md)', () => {
    const grades = Object.fromEntries(computeToolHealth(buildDemoFixture()).map((h) => [h.toolName, h.grade]));
    expect(grades).toEqual({
      read_file: 'A',
      search: 'B',
      write_file: 'C',
      run_query: 'D',
      send_email: 'F',
      list_calendars: null,
    });
  });

  it('includes some silent failures flagged unactionable (ADR 025), and only silent failures carry the flag', () => {
    const spans = buildDemoFixture();
    const flagged = spans.filter((s) => s.attributes['mcp.failure.unactionable'] === true);
    expect(flagged.length).toBe(4);
    expect(flagged.every((s) => s.errorType === 'tool_error')).toBe(true);
    const withAttr = spans.filter((s) => 'mcp.failure.unactionable' in s.attributes);
    expect(withAttr.every((s) => s.errorType === 'tool_error')).toBe(true);
    for (const s of withAttr) {
      expect(['empty', 'tiny', 'short', 'medium', 'long']).toContain(s.attributes['mcp.failure.content_length_bucket']);
    }
  });
});
