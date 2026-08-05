import { describe, it, expect } from 'vitest';
import { BoundedMap } from '../../src/schema-drift/store.js';

describe('BoundedMap', () => {
  it('returns undefined for a key that was never set', () => {
    const store = new BoundedMap(10);
    expect(store.get('missing')).toBeUndefined();
  });

  it('set() then get() round-trips the value', () => {
    const store = new BoundedMap(10);
    store.set('a', 42);
    expect(store.get('a')).toBe(42);
  });

  it('delete() removes an entry and returns true; returns false for a missing key', () => {
    const store = new BoundedMap(10);
    store.set('a', 1);
    expect(store.delete('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.delete('a')).toBe(false);
  });

  it('size reflects the current entry count', () => {
    const store = new BoundedMap(10);
    expect(store.size).toBe(0);
    store.set('a', 1);
    store.set('b', 2);
    expect(store.size).toBe(2);
    store.delete('a');
    expect(store.size).toBe(1);
  });

  it('evicts the least-recently-used entry once maxSize is exceeded', () => {
    const store = new BoundedMap(2);
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);

    expect(store.size).toBe(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBe(2);
    expect(store.get('c')).toBe(3);
  });

  it('get() refreshes an entry to the most-recently-used position, protecting it from eviction', () => {
    const store = new BoundedMap(2);
    store.set('a', 1);
    store.set('b', 2);
    store.get('a'); // 'a' is now MRU; 'b' is now LRU
    store.set('c', 3); // should evict 'b', not 'a'

    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBe(3);
  });

  it('re-setting an existing key updates its value and moves it to the MRU position', () => {
    const store = new BoundedMap(2);
    store.set('a', 1);
    store.set('b', 2);
    store.set('a', 100); // 'a' updated and now MRU; 'b' is now LRU
    store.set('c', 3); // should evict 'b'

    expect(store.get('a')).toBe(100);
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBe(3);
  });

  it('never exceeds maxSize across many insertions', () => {
    const store = new BoundedMap(5);
    for (let i = 0; i < 500; i++) {
      store.set(`key-${i}`, i);
      expect(store.size).toBeLessThanOrEqual(5);
    }
    expect(store.size).toBe(5);
  });
});
