import { describe, it, expect } from 'vitest';
import { computeSummary } from '../src/summary.js';
import { SpanBuffer } from '../src/span-buffer.js';

/** @param {Partial<import('opentel-mcp-contract').SerializedSpan>} overrides */
function span(overrides) {
  return {
    id: 'id',
    traceId: 'trace',
    name: 'tools/call echo',
    startTimeMs: 0,
    durationMs: 1,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

describe('computeSummary', () => {
  it('observationState is null when instrumentedServer has no getObservationState()', () => {
    const buffer = new SpanBuffer({ capacity: 10 });
    const result = computeSummary({ instrumentedServer: {}, buffer });
    expect(result.observationState).toBeNull();
  });

  it('observationState is read verbatim from getObservationState() when attached', () => {
    const observationState = { toolOutcome: { success: 3, failure: 1, unknown: 0 }, observationIntegrity: 'UNKNOWN' };
    const buffer = new SpanBuffer({ capacity: 10 });
    const instrumentedServer = { getObservationState: () => observationState };
    const result = computeSummary({ instrumentedServer, buffer });
    expect(result.observationState).toEqual(observationState);
  });

  it('AGGREGATION CORRECTNESS: buffered counts split success / error (thrown or protocol) / silentFailure exactly', () => {
    const buffer = new SpanBuffer({ capacity: 10 });
    buffer.push(span({ status: 'OK' })); // success
    buffer.push(span({ status: 'OK' })); // success
    buffer.push(span({ status: 'ERROR', errorType: 'TypeError' })); // thrown -> error
    buffer.push(span({ status: 'ERROR', errorType: 'tool_error' })); // silent failure
    buffer.push(span({ status: 'ERROR', errorType: 'tool_error' })); // silent failure

    const result = computeSummary({ instrumentedServer: {}, buffer });
    expect(result.buffered).toEqual({ total: 5, success: 2, error: 1, silentFailure: 2 });
  });

  it('an errorType of tool_error always wins classification into silentFailure, even if status were somehow not ERROR', () => {
    const buffer = new SpanBuffer({ capacity: 10 });
    buffer.push(span({ status: 'OK', errorType: 'tool_error' }));
    const result = computeSummary({ instrumentedServer: {}, buffer });
    expect(result.buffered).toEqual({ total: 1, success: 0, error: 0, silentFailure: 1 });
  });

  it('empty buffer summarizes to all-zero counts, not an error', () => {
    const buffer = new SpanBuffer({ capacity: 10 });
    const result = computeSummary({ instrumentedServer: {}, buffer });
    expect(result.buffered).toEqual({ total: 0, success: 0, error: 0, silentFailure: 0 });
  });

  it('buffered counts reflect only the CURRENT buffer window, capped by capacity, not a lifetime total', () => {
    const buffer = new SpanBuffer({ capacity: 2 });
    buffer.push(span({ status: 'OK' }));
    buffer.push(span({ status: 'OK' }));
    buffer.push(span({ status: 'ERROR', errorType: 'tool_error' })); // evicts the first success
    const result = computeSummary({ instrumentedServer: {}, buffer });
    expect(result.buffered).toEqual({ total: 2, success: 1, error: 0, silentFailure: 1 });
  });
});
