import { describe, it, expect } from 'vitest';
import { normalizeMessage } from '../../src/fingerprint/normalize/message.js';

const CASES = [
  ['User a3f4c8e2-1234-5678-9abc-def012345678 not found', 'User <UUID> not found'],
  ['Email foo@bar.com invalid', 'Email <EMAIL> invalid'],
  ['Cannot reach 192.168.1.1:8080', 'Cannot reach <IP>:<PORT>'],
  ['Failed at 2026-07-24T10:30:00Z', 'Failed at <TS>'],
  ['Read /home/thiru/proj/file.js', 'Read <PATH>'],
  ['Order 42871 rejected', 'Order <NUM> rejected'],
  ['Retry 3 times', 'Retry 3 times'],
];

describe('normalizeMessage', () => {
  for (const [input, expected] of CASES) {
    it(`normalizes "${input}"`, () => {
      expect(normalizeMessage(input)).toBe(expected);
    });
  }

  it('is idempotent across all cases', () => {
    for (const [input] of CASES) {
      const once = normalizeMessage(input);
      const twice = normalizeMessage(once);
      expect(twice).toBe(once);
    }
  });

  it('does not throw on an empty string', () => {
    expect(() => normalizeMessage('')).not.toThrow();
    expect(normalizeMessage('')).toBe('');
  });

  it('does not throw on a 3000-char string', () => {
    const huge = 'x'.repeat(3000);
    expect(() => normalizeMessage(huge)).not.toThrow();
  });
});
