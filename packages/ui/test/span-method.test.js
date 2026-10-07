import { describe, it, expect } from 'vitest';
import { spanMethod as srcSpanMethod, isToolCallSpan as srcIsToolCall } from '../src/span-method.js';
import { spanMethod as webSpanMethod, isToolCallSpan as webIsToolCall } from '../web/data/method.ts';
import { computeSummary } from '../src/summary.js';
import { SpanBuffer } from '../src/span-buffer.js';

const span = (name, attributes = {}, extra = {}) => ({
  id: name + JSON.stringify(attributes) + JSON.stringify(extra),
  traceId: 't',
  name,
  startTimeMs: 0,
  durationMs: 1,
  status: 'OK',
  attributes,
  ...extra,
});

const CASES = [
  [span('tools/call echo', { 'mcp.method.name': 'tools/call' }), 'tools/call'],
  [span('tools/list', { 'mcp.method.name': 'tools/list' }), 'tools/list'],
  [span('resources/read', { 'mcp.method.name': 'resources/read' }), 'resources/read'],
  [span('prompts/get greet', { 'mcp.method.name': 'prompts/get' }), 'prompts/get'],
  // No mcp.method.name: fall back to the tools/call name prefix (old cores, fixtures).
  [span('tools/call echo'), 'tools/call'],
  [span('tools/call'), 'tools/call'],
  [span('tools/caller'), undefined],
  [span('resources/read'), undefined],
  // The attribute wins over the name.
  [span('tools/call echo', { 'mcp.method.name': 'resources/read' }), 'resources/read'],
];

describe('span-method: server and browser implementations agree', () => {
  for (const [s, expected] of CASES) {
    it(`${s.name} ${JSON.stringify(s.attributes)} -> ${expected}`, () => {
      expect(srcSpanMethod(s)).toBe(expected);
      expect(webSpanMethod(s)).toBe(expected);
      expect(srcIsToolCall(s)).toBe(expected === 'tools/call');
      expect(webIsToolCall(s)).toBe(expected === 'tools/call');
    });
  }
});

describe('/api/summary counts tool calls only', () => {
  it('tools/list, resources/* and prompts/* spans never inflate success or error', () => {
    const buffer = new SpanBuffer({ capacity: 100 });
    const tc = (id, extra) => span(`tools/call t${id}`, { 'mcp.method.name': 'tools/call' }, { toolName: `t${id}`, ...extra });
    buffer.push(tc(1));
    buffer.push(tc(2, { status: 'ERROR', errorType: 'tool_error' }));
    buffer.push(tc(3, { status: 'ERROR', errorType: 'TypeError' }));
    buffer.push(span('tools/list', { 'mcp.method.name': 'tools/list' }));
    buffer.push(span('resources/read', { 'mcp.method.name': 'resources/read' }));
    buffer.push(span('resources/read', { 'mcp.method.name': 'resources/read' }, { status: 'ERROR', errorType: 'McpError' }));
    buffer.push(span('prompts/get greet', { 'mcp.method.name': 'prompts/get' }));
    buffer.push(span('prompts/list', { 'mcp.method.name': 'prompts/list' }));

    const { buffered } = computeSummary({ instrumentedServer: null, buffer });
    expect(buffered).toEqual({ total: 3, success: 1, error: 1, silentFailure: 1 });
  });
});
