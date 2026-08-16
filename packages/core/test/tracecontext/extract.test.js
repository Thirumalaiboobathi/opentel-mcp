import { describe, it, expect, vi, afterEach } from 'vitest';
import { context, trace, ROOT_CONTEXT, TraceFlags, diag } from '@opentelemetry/api';
import { extractTraceContext, __parseTraceParentForTests } from '../../src/tracecontext/extract.js';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_PARENT_ID = '00f067aa0ba902b7';

function traceparent(traceId = VALID_TRACE_ID, spanId = VALID_PARENT_ID, flags = '01', version = '00') {
  return `${version}-${traceId}-${spanId}-${flags}`;
}

describe('extractTraceContext', () => {
  describe('absent/malformed _meta — must resolve to baseContext unchanged', () => {
    it.each([
      ['undefined meta', undefined],
      ['null meta', null],
      ['a string', 'not-an-object'],
      ['a number', 42],
      ['an array', [1, 2, 3]],
      ['an empty object', {}],
      ['no traceparent key', { foo: 'bar' }],
      ['traceparent is not a string', { traceparent: 12345 }],
      ['traceparent is null', { traceparent: null }],
      ['traceparent is an object', { traceparent: { evil: true } }],
    ])('%s', (_label, meta) => {
      const base = ROOT_CONTEXT;
      expect(extractTraceContext(meta, base)).toBe(base);
    });
  });

  describe('malformed traceparent strings — must resolve to baseContext unchanged, never throw', () => {
    it.each([
      ['empty string', ''],
      ['garbage', 'not-a-traceparent'],
      ['wrong number of parts', '00-abc-def'],
      ['trace-id too short', traceparent('abc123')],
      ['trace-id all zeros', traceparent('0'.repeat(32))],
      ['parent-id all zeros', traceparent(VALID_TRACE_ID, '0'.repeat(16))],
      ['reserved version ff', traceparent(VALID_TRACE_ID, VALID_PARENT_ID, '01', 'ff')],
      ['uppercase hex (spec requires lowercase)', traceparent(VALID_TRACE_ID.toUpperCase())],
      ['version 00 with trailing garbage', `${traceparent()}-extra-stuff`],
      ['non-hex characters', traceparent('zz'.repeat(16))],
    ])('%s', (_label, badTraceparent) => {
      const base = ROOT_CONTEXT;
      expect(() => extractTraceContext({ traceparent: badTraceparent }, base)).not.toThrow();
      expect(extractTraceContext({ traceparent: badTraceparent }, base)).toBe(base);
    });
  });

  describe('valid traceparent', () => {
    it('attaches a remote SpanContext with the parsed traceId/spanId', () => {
      const result = extractTraceContext({ traceparent: traceparent() }, ROOT_CONTEXT);
      const spanContext = trace.getSpanContext(result);

      expect(spanContext).toBeDefined();
      expect(spanContext.traceId).toBe(VALID_TRACE_ID);
      expect(spanContext.spanId).toBe(VALID_PARENT_ID);
      expect(spanContext.isRemote).toBe(true);
    });

    it('parses the sampled flag (01) into TraceFlags.SAMPLED', () => {
      const result = extractTraceContext({ traceparent: traceparent(VALID_TRACE_ID, VALID_PARENT_ID, '01') });
      expect(trace.getSpanContext(result).traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
    });

    it('parses the not-sampled flag (00) into TraceFlags.NONE', () => {
      const result = extractTraceContext({ traceparent: traceparent(VALID_TRACE_ID, VALID_PARENT_ID, '00') });
      expect(trace.getSpanContext(result).traceFlags & TraceFlags.SAMPLED).toBe(0);
    });

    it('tolerates a higher version number with trailing fields (forward compatibility)', () => {
      const result = extractTraceContext({ traceparent: `01-${VALID_TRACE_ID}-${VALID_PARENT_ID}-01-extra-vendor-fields` });
      const spanContext = trace.getSpanContext(result);
      expect(spanContext.traceId).toBe(VALID_TRACE_ID);
      expect(spanContext.spanId).toBe(VALID_PARENT_ID);
    });

    it('accepts optional surrounding whitespace per the header-value grammar', () => {
      const result = extractTraceContext({ traceparent: ` ${traceparent()} ` });
      expect(trace.getSpanContext(result)?.traceId).toBe(VALID_TRACE_ID);
    });
  });

  describe('tracestate', () => {
    it('attaches a parsed TraceState when tracestate is a valid string', () => {
      const result = extractTraceContext({ traceparent: traceparent(), tracestate: 'vendor1=value1,vendor2=value2' });
      const spanContext = trace.getSpanContext(result);
      expect(spanContext.traceState).toBeDefined();
      expect(spanContext.traceState.get('vendor1')).toBe('value1');
      expect(spanContext.traceState.get('vendor2')).toBe('value2');
    });

    it('is omitted when tracestate is absent', () => {
      const result = extractTraceContext({ traceparent: traceparent() });
      expect(trace.getSpanContext(result).traceState).toBeUndefined();
    });

    it('drops malformed tracestate entries instead of failing the whole extraction', () => {
      // createTraceState() silently drops invalid entries per the W3C spec's
      // own error-handling rules — the traceparent must still resolve.
      const result = extractTraceContext({ traceparent: traceparent(), tracestate: '!!!not valid!!!' });
      expect(trace.getSpanContext(result)?.traceId).toBe(VALID_TRACE_ID);
    });

    it('is ignored (not attached) when it is not a string', () => {
      const result = extractTraceContext({ traceparent: traceparent(), tracestate: { not: 'a string' } });
      const spanContext = trace.getSpanContext(result);
      expect(spanContext.traceId).toBe(VALID_TRACE_ID);
      expect(spanContext.traceState).toBeUndefined();
    });
  });

  describe('conflicting / pre-existing active context (ADR 017)', () => {
    it('replaces an already-set local SpanContext entirely, not merges with it', () => {
      const localSpanContext = {
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      };
      const localContext = trace.setSpanContext(ROOT_CONTEXT, localSpanContext);

      const result = extractTraceContext({ traceparent: traceparent() }, localContext);
      const spanContext = trace.getSpanContext(result);

      expect(spanContext.traceId).toBe(VALID_TRACE_ID);
      expect(spanContext.traceId).not.toBe(localSpanContext.traceId);
      expect(spanContext.isRemote).toBe(true);
    });

    it('leaves a pre-existing local context untouched when _meta has no valid traceparent', () => {
      const localSpanContext = {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      };
      const localContext = trace.setSpanContext(ROOT_CONTEXT, localSpanContext);

      const result = extractTraceContext({}, localContext);
      expect(result).toBe(localContext);
      expect(trace.getSpanContext(result).traceId).toBe(localSpanContext.traceId);
    });
  });

  describe('defaults baseContext to context.active()', () => {
    it('uses context.active() when baseContext is omitted', () => {
      expect(extractTraceContext(undefined)).toBe(context.active());
    });
  });

  describe('never throws for hostile input', () => {
    it('does not throw when meta is a getter that throws', () => {
      const hostile = {
        get traceparent() {
          throw new Error('boom');
        },
      };
      expect(() => extractTraceContext(hostile)).not.toThrow();
    });

    it('never throws across a batch of malformed inputs', () => {
      const inputs = [{}, null, undefined, '', 0, NaN, [], Symbol('x'), new Map(), new Set(), { traceparent: {} }];
      for (const input of inputs) {
        expect(() => extractTraceContext(input)).not.toThrow();
      }
    });
  });

  describe('diagnostics — no warn spam for the common "no traceparent" case', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not call diag.warn for absent or malformed _meta', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      extractTraceContext(undefined);
      extractTraceContext({});
      extractTraceContext({ traceparent: 'garbage' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('logs at debug level, not warn, when extraction itself throws', () => {
      const debugSpy = vi.spyOn(diag, 'debug').mockImplementation(() => {});
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const hostile = {
        get traceparent() {
          throw new Error('boom');
        },
      };

      extractTraceContext(hostile);

      expect(debugSpy).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe('__parseTraceParentForTests (internal W3C traceparent parser)', () => {
  it('parses a well-formed traceparent', () => {
    expect(__parseTraceParentForTests(traceparent())).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: VALID_PARENT_ID,
      traceFlags: 1,
    });
  });

  it('returns null for malformed input', () => {
    expect(__parseTraceParentForTests('not-valid')).toBeNull();
  });
});
