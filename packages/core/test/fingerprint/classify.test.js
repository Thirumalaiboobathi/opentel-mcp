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

  it('matches known auth-library error names', () => {
    expect(auth.match({ name: 'UnauthorizedError', message: 'nope' }, CTX)).toBe('auth');
    expect(auth.match({ name: 'ForbiddenError', message: 'nope' }, CTX)).toBe('auth');
    expect(auth.match({ name: 'AuthError', message: 'nope' }, CTX)).toBe('auth');
  });

  // Pre-existing message wording -- never had a direct test before this
  // change (only status/name were exercised). Added here specifically to
  // confirm the broadened MESSAGE_RE didn't regress the original three
  // phrases while extending it.
  it('matches pre-existing message wording: unauthorized / forbidden / authenticate', () => {
    expect(auth.match({ message: 'Request was unauthorized' }, CTX)).toBe('auth');
    expect(auth.match({ message: 'Access to this resource is forbidden' }, CTX)).toBe('auth');
    expect(auth.match({ message: 'Failed to authenticate the request' }, CTX)).toBe('auth');
  });

  // New coverage: OS/CLI-style permission-denial phrasing (Unix, git, AWS
  // IAM, GCP -- see auth.js's own docblock for the researched sources).
  it('matches "permission denied" (Node fs / Unix / git-over-HTTPS wording)', () => {
    expect(auth.match({ message: "EACCES: permission denied, open '/etc/shadow'" }, CTX)).toBe('auth');
  });

  it('matches "Permission denied (publickey)" (git-over-SSH, OpenSSH\'s own wording)', () => {
    expect(auth.match({ message: 'git@github.com: Permission denied (publickey).' }, CTX)).toBe('auth');
  });

  it('matches "access denied" (AWS S3-style wording)', () => {
    expect(auth.match({ message: 'Access Denied' }, CTX)).toBe('auth');
  });

  it('matches "not authorized to perform" (AWS IAM explicit-deny wording)', () => {
    expect(
      auth.match(
        { message: 'User: arn:aws:iam::123456789012:user/bob is not authorized to perform: s3:PutObject' },
        CTX,
      ),
    ).toBe('auth');
  });

  it('matches "insufficient permissions"', () => {
    expect(auth.match({ message: 'Insufficient permissions to complete this operation' }, CTX)).toBe('auth');
  });

  it('matches the EACCES error code directly, independent of message wording', () => {
    expect(auth.match({ code: 'EACCES', message: 'some other wording entirely' }, CTX)).toBe('auth');
  });

  it('matches the EPERM error code directly, independent of message wording', () => {
    expect(auth.match({ code: 'EPERM', message: 'operation not permitted' }, CTX)).toBe('auth');
  });

  // FALSE POSITIVE GUARDS -- auth-adjacent wording that must NOT classify
  // as auth. All three are real, plausible application text, not just
  // contrived non-matches.
  it('does NOT match "user denied the permission request" -- application semantics about a permission prompt, not an auth failure', () => {
    expect(auth.match({ message: 'user denied the permission request' }, CTX)).toBeNull();
  });

  it('does NOT match "permission granted" -- the opposite outcome', () => {
    expect(auth.match({ message: 'permission granted' }, CTX)).toBeNull();
  });

  it('does NOT match "user is authorized to proceed" -- bare "authorized" without "not", a success statement', () => {
    expect(auth.match({ message: 'user is authorized to proceed' }, CTX)).toBeNull();
  });
});

describe('auth classifier: opentel-mcp-ui demo\'s real messages (packages/ui/demo/populate.js)', () => {
  // Verifies runClassifiers()'s end-to-end category for every distinct
  // silent-failure message the UI demo actually produces -- the same
  // messages that motivated this broadened pattern in the first place.
  // Only the permission-denied one is expected to change: the other four
  // land exactly where the original investigation found them.

  it('"Permission denied: cannot push to protected branch ..." now classifies as auth (was internal)', () => {
    const message = "Permission denied: cannot push to protected branch 'main' (require pull request review)";
    expect(runClassifiers({ name: 'MCPToolError', message }, CTX)).toBe('auth');
  });

  it('"File not found: ..." still classifies as internal -- no classifier covers "not found"', () => {
    expect(
      runClassifiers({ name: 'MCPToolError', message: 'File not found: src/config/missing-secrets.json' }, CTX),
    ).toBe('internal');
    expect(
      runClassifiers({ name: 'MCPToolError', message: 'File not found: docs/missing-changelog.md' }, CTX),
    ).toBe('internal');
  });

  it('"Query timeout after 30000ms: ..." still classifies as timeout, unaffected by the auth change', () => {
    const message = 'Query timeout after 30000ms: SELECT * FROM orders WHERE status = ...';
    expect(runClassifiers({ name: 'MCPToolError', message }, CTX)).toBe('timeout');
  });

  it('"Rate limited by Slack API ..." still classifies as internal -- no classifier covers rate limiting', () => {
    const message = 'Rate limited by Slack API — retry after 12s';
    expect(runClassifiers({ name: 'MCPToolError', message }, CTX)).toBe('internal');
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
