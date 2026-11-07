import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, SpanKind } from '@opentelemetry/api';
import { TracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';
import { parseOtlpJsonTraceRequest } from '../src/otlp-json-receiver.js';

/** ADR 033: security events reach the dashboard through both ingestion paths, whitelisted. */

const INTEGRITY = {
  'gen_ai.tool.name': 'send_email',
  'mcp.tool.integrity.expected_hash': 'sha256:' + 'a'.repeat(64),
  'mcp.tool.integrity.actual_hash': 'sha256:' + 'b'.repeat(64),
  'mcp.tool.integrity.severity': 'high',
};

describe('in-process ingestion (CollectorSpanProcessor)', () => {
  let provider;
  let collector;
  beforeEach(() => {
    collector = new CollectorSpanProcessor({ capacity: 50 });
    provider = new TracerProvider({ spanProcessors: [collector] });
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(async () => {
    trace.disable();
    await provider.shutdown();
  });
  const tracer = () => trace.getTracer('test');

  it('admits a tools/list span that carries an integrity event, keeping only whitelisted data', () => {
    const span = tracer().startSpan('tools/list', { kind: SpanKind.SERVER });
    span.addEvent('mcp.tool.integrity.pin_mismatch', { ...INTEGRITY, 'mcp.tool.description': 'CANARY-DESC' });
    span.addEvent('exception', { 'exception.message': 'CANARY-EXC' });
    span.end();
    const [stored] = collector.buffer.toArray();
    expect(stored.name).toBe('tools/list');
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0].name).toBe('mcp.tool.integrity.pin_mismatch');
    expect(stored.events[0].attributes).toEqual(INTEGRITY);
    expect(typeof stored.events[0].timeMs).toBe('number');
    expect(JSON.stringify(stored)).not.toContain('CANARY');
  });

  it('still drops an ordinary tools/list span, and one with only non-security events', () => {
    tracer().startSpan('tools/list').end();
    const noisy = tracer().startSpan('tools/list');
    noisy.addEvent('mcp.tool.schema_drift.detected', { 'gen_ai.tool.name': 'x' });
    noisy.end();
    expect(collector.buffer.size).toBe(0);
  });

  it('a tools/call span keeps its sensitive audit event, and has no `events` field when it has none', () => {
    const a = tracer().startSpan('tools/call send_email');
    a.addEvent('mcp.audit.sensitive_call', { 'gen_ai.tool.name': 'send_email', 'mcp.tool.outcome': 'success', 'mcp.tool.duration_ms': 3 });
    a.end();
    tracer().startSpan('tools/call echo').end();
    const [withEvent, without] = collector.buffer.toArray();
    expect(withEvent.events[0].attributes['mcp.tool.outcome']).toBe('success');
    expect('events' in without).toBe(false);
  });

  it('a flood of events on one span is bounded', () => {
    const s = tracer().startSpan('tools/list');
    for (let i = 0; i < 500; i++) s.addEvent('mcp.tool.integrity.changed', { 'gen_ai.tool.name': `t${i}` });
    s.end();
    expect(collector.buffer.toArray()[0].events.length).toBeLessThanOrEqual(32);
  });
});

async function otlpFor(build) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  build(trace.getTracer('test'));
  const bytes = JsonTraceSerializer.serializeRequest(exporter.getFinishedSpans());
  trace.disable();
  await provider.shutdown();
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe('OTLP receiver (real wire format)', () => {
  it('decodes integrity events from a tools/list span and admits it', async () => {
    const json = await otlpFor((t) => {
      const s = t.startSpan('tools/list');
      s.addEvent('mcp.tool.integrity.pin_mismatch', { ...INTEGRITY, 'mcp.tool.description': 'CANARY-DESC' });
      s.end();
    });
    const spans = parseOtlpJsonTraceRequest(json);
    expect(spans).toHaveLength(1);
    expect(spans[0].events[0].attributes).toEqual(INTEGRITY);
    expect(typeof spans[0].events[0].timeMs).toBe('number');
    expect(JSON.stringify(spans)).not.toContain('CANARY');
  });

  it('drops ordinary tools/list spans and keeps tools/call ones, with the audit event', async () => {
    const json = await otlpFor((t) => {
      t.startSpan('tools/list').end();
      const c = t.startSpan('tools/call send_email');
      c.setAttribute('mcp.tool.sensitive', true);
      c.addEvent('mcp.audit.sensitive_call', { 'gen_ai.tool.name': 'send_email', 'mcp.tool.outcome': 'silent_failure', 'mcp.tool.duration_ms': 4.5, 'mcp.failure.category': 'auth' });
      c.end();
    });
    const spans = parseOtlpJsonTraceRequest(json);
    expect(spans.map((s) => s.name)).toEqual(['tools/call send_email']);
    expect(spans[0].events[0].attributes).toEqual({
      'gen_ai.tool.name': 'send_email',
      'mcp.tool.outcome': 'silent_failure',
      'mcp.tool.duration_ms': 4.5,
      'mcp.failure.category': 'auth',
    });
    expect(spans[0].attributes['mcp.tool.sensitive']).toBe(true);
  });

  it('hostile event payloads are bounded or dropped and never throw', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'tools/list',
                  spanId: 'a',
                  traceId: 'b',
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                  events: [
                    ...Array.from({ length: 5000 }, () => ({
                      name: 'mcp.tool.integrity.added',
                      timeUnixNano: 'not-a-number',
                      attributes: [
                        { key: 'gen_ai.tool.name', value: { stringValue: 'y'.repeat(100_000) } },
                        { key: 'mcp.tool.integrity.new_hash', value: { arrayValue: { values: [{ stringValue: 'x' }] } } },
                        { key: 'unlisted', value: { stringValue: 'CANARY' } },
                      ],
                    })),
                    null,
                    5,
                    { name: 7 },
                  ],
                },
                { name: 'tools/list', spanId: 'c', traceId: 'd', events: 'nope' },
              ],
            },
          ],
        },
      ],
    };
    let spans;
    expect(() => (spans = parseOtlpJsonTraceRequest(body))).not.toThrow();
    expect(spans).toHaveLength(1);
    expect(spans[0].events).toHaveLength(32);
    expect(spans[0].events[0].attributes['gen_ai.tool.name']).toHaveLength(256);
    expect('mcp.tool.integrity.new_hash' in spans[0].events[0].attributes).toBe(false);
    expect(JSON.stringify(spans)).not.toContain('CANARY');
  });
});
