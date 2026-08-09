import { describe, it, expect } from 'vitest';
import { hashInputs } from '../../src/fingerprint/hash.js';

describe('hashInputs', () => {
  it('is deterministic: same input always produces the same hash', () => {
    const input = 'v1|TypeError|internal|thrown|null|Cannot read <UUID>|foo@bar.js:12';
    const first = hashInputs(input);
    for (let i = 0; i < 10; i++) {
      expect(hashInputs(input)).toBe(first);
    }
  });

  it('produces different hashes for different inputs (100 random pairs)', () => {
    for (let i = 0; i < 100; i++) {
      const a = `v1|input-${Math.random()}-a`;
      const b = `v1|input-${Math.random()}-b`;
      expect(hashInputs(a)).not.toBe(hashInputs(b));
    }
  });

  it('returns exactly 16 lowercase hex characters', () => {
    const hash = hashInputs('v1|SomeError|internal|thrown|null|message|sig');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toHaveLength(16);
  });

  it('hashes the empty string to a stable, documented value', () => {
    // sha256('') = e3b0c44298fc1c14... — well-known constant, truncated here.
    expect(hashInputs('')).toBe('e3b0c44298fc1c14');
  });
});
