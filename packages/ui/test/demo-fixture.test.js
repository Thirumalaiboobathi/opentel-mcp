import { describe, it, expect } from 'vitest';
import { buildDemoFixture } from '../src/demo-fixture.js';
import { computeSummary } from '../src/summary.js';
import { SpanBuffer } from '../src/span-buffer.js';

describe('buildDemoFixture', () => {
  it('produces a realistic mix matching the design brief\'s worked example (42 success, 7 visible failures, 11 missed-by-otel failures)', () => {
    const spans = buildDemoFixture();
    const buffer = new SpanBuffer({ capacity: spans.length });
    for (const span of spans) buffer.push(span);

    const { buffered } = computeSummary({ instrumentedServer: {}, buffer });
    expect(buffered).toEqual({ total: 60, success: 42, error: 7, silentFailure: 11 });
  });

  it('every span is well-formed (unique id, tools/call name, valid status)', () => {
    const spans = buildDemoFixture();
    const ids = new Set(spans.map((s) => s.id));
    expect(ids.size).toBe(spans.length);
    for (const span of spans) {
      expect(span.name.startsWith('tools/call ')).toBe(true);
      expect(['OK', 'ERROR']).toContain(span.status);
    }
  });

  it('silent failures use errorType tool_error; visible failures never do', () => {
    const spans = buildDemoFixture();
    const visible = spans.filter((s) => s.status === 'ERROR' && s.errorType !== 'tool_error');
    const missed = spans.filter((s) => s.errorType === 'tool_error');
    expect(visible).toHaveLength(7);
    expect(missed).toHaveLength(11);
    expect(missed.every((s) => s.status === 'ERROR')).toBe(true);
  });
});
