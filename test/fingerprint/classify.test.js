import { describe, it, expect } from 'vitest';
import validation from '../../src/fingerprint/classify/validation.js';
import timeout from '../../src/fingerprint/classify/timeout.js';
import network from '../../src/fingerprint/classify/network.js';
import auth from '../../src/fingerprint/classify/auth.js';
import dependency from '../../src/fingerprint/classify/dependency.js';
import serialization from '../../src/fingerprint/classify/serialization.js';
import internal from '../../src/fingerprint/classify/internal.js';
import { DEFAULT_CLASSIFIERS, runClassifiers } from '../../src/fingerprint/classify/index.js';

const CTX = { origin: 'thrown' };

describe('validation classifier', () => {
  it('matches known validation-library error names', () => {
    expect(validation.match({ name: 'ZodError', message: 'bad input' }, CTX)).toBe('validation');
  });

  it('does not match unrelated errors', () => {
    expect(validation.match({ name: 'TypeError', message: 'x is not a function' }, CTX)).toBeNull();
  });

  it('matches via constructor name ending in ValidationError', () => {
    class FooValidationError extends Error {}
    const err = new FooValidationError('bad shape');
    expect(validation.match(err, CTX)).toBe('validation');
  });
});

describe('timeout classifier', () => {
  it('matches known timeout error names', () => {
    expect(timeout.match({ name: 'TimeoutError', message: 'took too long' }, CTX)).toBe('timeout');
  });

  it('does not match unrelated errors', () => {
    expect(timeout.match({ name: 'TypeError', message: 'oops' }, CTX)).toBeNull();
  });

  it('matches via ESOCKETTIMEDOUT code', () => {
    expect(timeout.match({ code: 'ESOCKETTIMEDOUT', message: 'socket died' }, CTX)).toBe('timeout');
  });
});

describe('network classifier', () => {
  it('matches known network error codes', () => {
    expect(network.match({ code: 'ECONNREFUSED', message: 'nope' }, CTX)).toBe('network');
  });

  it('does not match unrelated errors', () => {
    expect(network.match({ code: 'EACCES', message: 'permission denied' }, CTX)).toBeNull();
  });

  it('matches via FetchError name', () => {
    expect(network.match({ name: 'FetchError', message: 'request failed' }, CTX)).toBe('network');
  });
});

describe('auth classifier', () => {
  it('matches status 401', () => {
    expect(auth.match({ status: 401, message: 'nope' }, CTX)).toBe('auth');
  });

  it('does not match unrelated errors', () => {
    expect(auth.match({ status: 500, message: 'server exploded' }, CTX)).toBeNull();
  });

  it('matches via statusCode 403 (distinct from status)', () => {
    expect(auth.match({ statusCode: 403, message: 'nope' }, CTX)).toBe('auth');
  });
});

describe('dependency classifier', () => {
  it('matches known datastore error names', () => {
    expect(dependency.match({ name: 'MongoError', message: 'connection lost' }, CTX)).toBe('dependency');
  });

  it('does not match unrelated errors', () => {
    expect(dependency.match({ name: 'TypeError', message: 'x' }, CTX)).toBeNull();
  });

  it('matches an unlisted name via known-prefix + Error suffix', () => {
    expect(dependency.match({ name: 'RedisTimeoutError', message: 'x' }, CTX)).toBe('dependency');
  });
});

describe('serialization classifier', () => {
  it('matches SyntaxError with a JSON-referencing message', () => {
    expect(serialization.match({ name: 'SyntaxError', message: 'Unexpected end of JSON input' }, CTX)).toBe(
      'serialization',
    );
  });

  it('does not match unrelated errors', () => {
    expect(serialization.match({ name: 'TypeError', message: 'x is not a function' }, CTX)).toBeNull();
  });

  it('matches "unexpected token" wording regardless of error name', () => {
    expect(serialization.match({ name: 'Error', message: 'Unexpected token < in position 0' }, CTX)).toBe(
      'serialization',
    );
  });
});

describe('internal classifier', () => {
  it('always returns "internal", never null', () => {
    expect(internal.match({ name: 'AnythingAtAll' }, CTX)).toBe('internal');
    expect(internal.match(null, CTX)).toBe('internal');
    expect(internal.match(undefined, CTX)).toBe('internal');
    expect(internal.match('some string', CTX)).toBe('internal');
    expect(internal.match({}, CTX)).toBe('internal');
  });
});

describe('DEFAULT_CLASSIFIERS / runClassifiers', () => {
  it('is frozen and ordered validation -> timeout -> network -> auth -> dependency -> serialization -> internal', () => {
    expect(Object.isFrozen(DEFAULT_CLASSIFIERS)).toBe(true);
    expect(DEFAULT_CLASSIFIERS.map((c) => c.name)).toEqual([
      'validation',
      'timeout',
      'network',
      'auth',
      'dependency',
      'serialization',
      'internal',
    ]);
  });

  it('gives timeout precedence over network when both signals are present', () => {
    const err = { code: 'ETIMEDOUT', message: 'network error' };
    expect(runClassifiers(err, CTX)).toBe('timeout');
  });

  it('classifies a ZodError with validation wording as validation, not double-matched', () => {
    const err = { name: 'ZodError', message: 'must be a string' };
    expect(runClassifiers(err, CTX)).toBe('validation');
  });

  it('never throws and returns a valid category for null/undefined/string/plain-object err', () => {
    for (const err of [null, undefined, 'boom', {}, { random: 'shape' }]) {
      let result;
      expect(() => {
        result = runClassifiers(err, CTX);
      }).not.toThrow();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('falls back to "internal" when nothing more specific matches', () => {
    expect(runClassifiers({ name: 'Whatever', message: 'no signal here' }, CTX)).toBe('internal');
  });

  it('lets a custom classifier prepended ahead of the defaults win', () => {
    const custom = {
      name: 'custom-marker',
      match: (err) => (err?.marker === 'special' ? 'network' : null),
    };
    const err = { marker: 'special', name: 'ZodError', message: 'must be a string' };

    expect(runClassifiers(err, CTX, [custom, ...DEFAULT_CLASSIFIERS])).toBe('network');
  });
});
