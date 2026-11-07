import { describe, it, expect } from 'vitest';
import { parseOtlpJsonTraceRequest } from '../src/otlp-json-receiver.js';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';
import { computeSummary } from '../src/summary.js';
import { isOperationSpanName, OPERATION_METHODS } from '../src/span-method.js';
import { OPERATION_METHODS as WEB_OPERATION_METHODS } from '../web/data/operations.ts';

const str = (stringValue) => ({ stringValue });
const otlp = (name, attrs = {}, extra = {}) => ({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              traceId: 't'.repeat(32),
              spanId: 's'.repeat(16),
              name,
              startTimeUnixNano: '1000000000',
              endTimeUnixNano: '2000000000',
              status: { code: 0 },
              attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: str(v) })),
              ...extra,
            },
          ],
        },
      ],
    },
  ],
});

describe('resource/prompt span admission', () => {
  it('the server-side and browser method lists agree', () => {
    expect([...OPERATION_METHODS]).toEqual([...WEB_OPERATION_METHODS]);
  });

  it('matches the method exactly, or the method followed by a space (prompts/get <name>)', () => {
    for (const m of OPERATION_METHODS) {
      expect(isOperationSpanName(m)).toBe(true);
      expect(isOperationSpanName(`${m} x`)).toBe(true);
      expect(isOperationSpanName(`${m}x`)).toBe(false);
    }
    for (const bad of ['tools/list', 'resources/', 'resources', 'prompts', 'RESOURCES/READ', undefined, 42, null]) {
      expect(isOperationSpanName(bad)).toBe(false);
    }
  });

  it('OTLP receiver admits all five and keeps only the allowlisted fields', () => {
    for (const method of OPERATION_METHODS) {
      const name = method === 'prompts/get' ? 'prompts/get greet' : method;
      const [span] = parseOtlpJsonTraceRequest(
        otlp(
          name,
          {
            'mcp.method.name': method,
            'gen_ai.prompt.name': 'greet',
            'resource.uri': 'canary://secret/1',
            'gen_ai.tool.name': 'sneaky',
            'prompt.argument': 'CANARY-ARG',
          },
          { events: [{ name: 'mcp.tool_definition.changed', timeUnixNano: '1', attributes: [] }] },
        ),
      );
      expect(span.name).toBe(name);
      expect(span.attributes).toEqual({ 'mcp.method.name': method, 'gen_ai.prompt.name': 'greet' });
      expect(span.toolName).toBeUndefined();
      expect(span.events).toBeUndefined();
      expect(JSON.stringify(span)).not.toMatch(/canary|CANARY|sneaky/);
    }
  });

  it('OTLP receiver still drops everything else that is not tools/call', () => {
    for (const name of ['tools/list', 'initialize', 'resources/readx', 'prompts/', 'GET /health']) {
      expect(parseOtlpJsonTraceRequest(otlp(name))).toEqual([]);
    }
  });

  it('operation spans do not change the tool-call summary', () => {
    const collector = new CollectorSpanProcessor();
    const ingest = (name, extra = {}) =>
      collector.ingestSerializedSpan(parseOtlpJsonTraceRequest(otlp(name, { 'mcp.method.name': name.split(' ')[0] }, extra))[0]);
    ingest('tools/call echo', { status: { code: 1 } });
    ingest('resources/read', { status: { code: 2 } });
    ingest('prompts/get greet', { status: { code: 2 } });
    ingest('resources/list');
    expect(collector.buffer.size).toBe(4);
    expect(computeSummary({ instrumentedServer: null, buffer: collector.buffer }).buffered).toEqual({
      total: 1,
      success: 1,
      error: 0,
      silentFailure: 0,
    });
  });
});
