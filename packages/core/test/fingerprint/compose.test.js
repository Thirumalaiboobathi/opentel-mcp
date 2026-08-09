import { describe, it, expect, vi } from 'vitest';
import { computeFingerprint } from '../../src/fingerprint/compose.js';

const CTX = { origin: 'thrown' };

function stackWithFrame(file, line, fn = 'doThing') {
  return `Error: msg\n    at ${fn} (${file}:${line}:1)`;
}

describe('computeFingerprint', () => {
  it('produces the same fingerprint for two errors on the same code path but different UUIDs', () => {
    const stack = stackWithFrame('/home/thiru/proj/src/x.js', 12);
    const errA = new Error('User a3f4c8e2-1234-5678-9abc-def012345678 not found');
    errA.stack = stack;
    const errB = new Error('User f1e2d3c4-9999-8888-7777-666655554444 not found');
    errB.stack = stack;

    const resultA = computeFingerprint(errA, CTX);
    const resultB = computeFingerprint(errB, CTX);

    expect(resultA.fingerprint).toBe(resultB.fingerprint);
  });

  it('produces different fingerprints for the same message at different call sites', () => {
    const errA = new Error('Something went wrong');
    errA.stack = stackWithFrame('/home/thiru/proj/src/x.js', 12);
    const errB = new Error('Something went wrong');
    errB.stack = stackWithFrame('/home/thiru/proj/src/y.js', 20);

    const resultA = computeFingerprint(errA, CTX);
    const resultB = computeFingerprint(errB, CTX);

    expect(resultA.fingerprint).not.toBe(resultB.fingerprint);
  });

  it('handles a string err without throwing, producing a valid result', () => {
    let result;
    expect(() => {
      result = computeFingerprint('plain string failure', CTX);
    }).not.toThrow();
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.inputs.errorClass).toBe('Error');
  });

  it('handles a plain object err without throwing, producing a valid result', () => {
    let result;
    expect(() => {
      result = computeFingerprint({ weird: 'shape' }, CTX);
    }).not.toThrow();
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns the exact FALLBACK result for a null err', () => {
    const result = computeFingerprint(null, CTX);
    expect(result).toEqual({
      fingerprint: '0000000000000000',
      signature: 'unfingerprintable',
      category: 'unknown',
      origin: CTX.origin,
      inputs: {
        errorClass: '',
        category: 'unknown',
        origin: CTX.origin,
        toolName: null,
        normalizedMessage: '',
        stackSignature: '',
      },
    });
  });

  it('returns the exact FALLBACK result for an undefined err', () => {
    const result = computeFingerprint(undefined, CTX);
    expect(result.fingerprint).toBe('0000000000000000');
    expect(result.signature).toBe('unfingerprintable');
    expect(result.category).toBe('unknown');
  });

  it('extracts name and message from a CallToolResult with isError=true', () => {
    const ctx = { origin: 'tool_error' };
    const err = { isError: true, content: [{ type: 'text', text: 'Invalid email foo@bar.com' }] };

    const result = computeFingerprint(err, ctx);

    expect(result.origin).toBe('tool_error');
    expect(result.inputs.errorClass).toBe('MCPToolError');
    expect(result.inputs.normalizedMessage).toBe('Invalid email <EMAIL>');
  });

  it('does not throw when a CallToolResult is missing its content array', () => {
    const ctx = { origin: 'tool_error' };
    let result;
    expect(() => {
      result = computeFingerprint({ isError: true }, ctx);
    }).not.toThrow();
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('overrides category to "dependency" when internal + top frame is in node_modules', () => {
    const err = new Error('nothing special');
    err.name = 'WeirdCustomError';
    err.stack = stackWithFrame('/x/node_modules/some-pkg/lib/index.js', 10, 'run');

    const result = computeFingerprint(err, CTX);

    expect(result.category).toBe('dependency');
    expect(result.inputs.category).toBe('dependency');
  });

  it('does not override a non-internal category even when top frame is in node_modules', () => {
    const err = new Error('took too long');
    err.name = 'TimeoutError';
    err.stack = stackWithFrame('/x/node_modules/some-pkg/lib/index.js', 10, 'run');

    const result = computeFingerprint(err, CTX);

    expect(result.category).toBe('timeout');
  });

  it('does not override "internal" when there are no stack frames at all', () => {
    const err = new Error('nothing special');
    err.name = 'WeirdCustomError';
    err.stack = undefined;

    const result = computeFingerprint(err, CTX);

    expect(result.category).toBe('internal');
  });

  it('uses a custom classifiers list via opts.classifiers', () => {
    const custom = { name: 'custom', match: () => 'auth' };
    const err = new Error('whatever');

    const result = computeFingerprint(err, CTX, { classifiers: [custom] });

    expect(result.category).toBe('auth');
  });

  it('respects a custom opts.stackFrames count', () => {
    const err = new Error('msg');
    err.stack = [
      'Error: msg',
      '    at a (/home/thiru/proj/src/a.js:1:1)',
      '    at b (/home/thiru/proj/src/b.js:2:2)',
      '    at c (/home/thiru/proj/src/c.js:3:3)',
      '    at d (/home/thiru/proj/src/d.js:4:4)',
    ].join('\n');

    const result = computeFingerprint(err, { origin: 'thrown', cwd: '/home/thiru/proj' }, { stackFrames: 2 });

    expect(result.inputs.stackSignature.split('|')).toHaveLength(2);
    expect(result.inputs.stackSignature).toBe('a@src/a.js:1|b@src/b.js:2');
  });

  it('produces a signature no longer than 60 chars even for a very long error class name', () => {
    const err = new Error('boom');
    err.name = 'A'.repeat(200);
    err.stack = stackWithFrame('/home/thiru/proj/src/x.js', 12);

    const result = computeFingerprint(err, CTX);

    expect(result.signature.length).toBeLessThanOrEqual(60);
  });

  it('builds "TypeError@anon:<line>" for an anonymous top frame', () => {
    const err = new TypeError('boom');
    err.stack = 'TypeError: boom\n    at /home/thiru/proj/src/x.js:10:5';

    const result = computeFingerprint(err, CTX);

    expect(result.signature).toBe('TypeError@anon:10');
  });

  it('returns FALLBACK without throwing when normalizeMessage throws internally', async () => {
    vi.resetModules();
    vi.doMock('../../src/fingerprint/normalize/message.js', () => ({
      normalizeMessage: () => {
        throw new Error('boom from normalizeMessage');
      },
    }));

    const { computeFingerprint: computeFingerprintMocked } = await import('../../src/fingerprint/compose.js');

    let result;
    expect(() => {
      result = computeFingerprintMocked(new Error('whatever'), CTX);
    }).not.toThrow();
    expect(result.fingerprint).toBe('0000000000000000');
    expect(result.signature).toBe('unfingerprintable');

    vi.doUnmock('../../src/fingerprint/normalize/message.js');
    vi.resetModules();
  });
});
