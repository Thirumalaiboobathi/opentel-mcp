import { describe, it, expect } from 'vitest';
import { SpanBuffer, DEFAULT_SPAN_BUFFER_CAPACITY } from '../src/span-buffer.js';

/** @param {number} n @returns {import('../src/types.d.ts').SerializedSpan} */
function fakeSpan(n) {
  return {
    id: `span-${n}`,
    traceId: `trace-${n}`,
    name: 'tools/call echo',
    startTimeMs: n,
    durationMs: 1,
    status: 'OK',
    attributes: {},
  };
}

describe('SpanBuffer', () => {
  it('defaults to a capacity of 1000', () => {
    const buffer = new SpanBuffer();
    expect(buffer.capacity).toBe(1000);
    expect(DEFAULT_SPAN_BUFFER_CAPACITY).toBe(1000);
  });

  it('is configurable via the capacity option', () => {
    const buffer = new SpanBuffer({ capacity: 5 });
    expect(buffer.capacity).toBe(5);
  });

  it('rejects a non-positive-integer capacity', () => {
    expect(() => new SpanBuffer({ capacity: 0 })).toThrow(RangeError);
    expect(() => new SpanBuffer({ capacity: -1 })).toThrow(RangeError);
    expect(() => new SpanBuffer({ capacity: 1.5 })).toThrow(RangeError);
  });

  it('size grows with each push until capacity, then stays capped', () => {
    const buffer = new SpanBuffer({ capacity: 3 });
    expect(buffer.size).toBe(0);
    buffer.push(fakeSpan(1));
    expect(buffer.size).toBe(1);
    buffer.push(fakeSpan(2));
    buffer.push(fakeSpan(3));
    expect(buffer.size).toBe(3);
    buffer.push(fakeSpan(4));
    expect(buffer.size).toBe(3); // never exceeds capacity
  });

  it('toArray() returns entries oldest-first, in push order, before wrapping', () => {
    const buffer = new SpanBuffer({ capacity: 5 });
    buffer.push(fakeSpan(1));
    buffer.push(fakeSpan(2));
    buffer.push(fakeSpan(3));
    expect(buffer.toArray().map((s) => s.id)).toEqual(['span-1', 'span-2', 'span-3']);
  });

  it('EVICTION: past capacity, the OLDEST entry is evicted for each new push, never the newest', () => {
    const buffer = new SpanBuffer({ capacity: 3 });
    for (let i = 1; i <= 5; i++) buffer.push(fakeSpan(i));
    // 1 and 2 were evicted; 3, 4, 5 remain, oldest-first.
    expect(buffer.toArray().map((s) => s.id)).toEqual(['span-3', 'span-4', 'span-5']);
    expect(buffer.size).toBe(3);
  });

  it('EVICTION: bounded memory holds under heavy sustained load, far past capacity', () => {
    const buffer = new SpanBuffer({ capacity: 10 });
    for (let i = 1; i <= 10_000; i++) buffer.push(fakeSpan(i));
    expect(buffer.size).toBe(10);
    expect(buffer.totalPushed).toBe(10_000);
    // The 10 most recent, and only the 10 most recent, survive.
    expect(buffer.toArray().map((s) => s.id)).toEqual([
      'span-9991',
      'span-9992',
      'span-9993',
      'span-9994',
      'span-9995',
      'span-9996',
      'span-9997',
      'span-9998',
      'span-9999',
      'span-10000',
    ]);
  });

  it('totalPushed is a lifetime counter, independent of eviction and of clear()', () => {
    const buffer = new SpanBuffer({ capacity: 2 });
    buffer.push(fakeSpan(1));
    buffer.push(fakeSpan(2));
    buffer.push(fakeSpan(3));
    expect(buffer.totalPushed).toBe(3);
    buffer.clear();
    expect(buffer.totalPushed).toBe(3);
    expect(buffer.size).toBe(0);
  });

  it('toArray() is a snapshot -- mutating the returned array does not affect the buffer', () => {
    const buffer = new SpanBuffer({ capacity: 3 });
    buffer.push(fakeSpan(1));
    const snapshot = buffer.toArray();
    snapshot.push(fakeSpan(99));
    expect(buffer.toArray()).toHaveLength(1);
  });

  it('clear() empties the buffer but leaves capacity unchanged', () => {
    const buffer = new SpanBuffer({ capacity: 3 });
    buffer.push(fakeSpan(1));
    buffer.push(fakeSpan(2));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.capacity).toBe(3);
    buffer.push(fakeSpan(3));
    expect(buffer.toArray().map((s) => s.id)).toEqual(['span-3']);
  });
});
