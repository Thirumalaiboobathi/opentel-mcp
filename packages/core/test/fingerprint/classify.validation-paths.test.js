import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { extractValidationPaths } from '../../src/fingerprint/classify/validation-paths.js';

const require = createRequire(import.meta.url);

/**
 * Reads the installed @modelcontextprotocol/sdk's own version, deliberately
 * NOT via `import '@modelcontextprotocol/sdk/package.json'`: the SDK's own
 * `exports` map defines a `"./*"` wildcard that intercepts that subpath and
 * redirects it to a decoy `dist/esm/package.json` containing only
 * `{"type":"module"}` -- confirmed empirically, a direct subpath import
 * silently resolves `.version` to `undefined`, no error at all (the exact
 * "wrong answer with nothing failing" failure mode this pin test exists to
 * avoid, one level down the stack). Instead, resolves a real subpath this
 * file already imports (`types.js`) through Node's actual module
 * resolution, then walks up parent directories to the nearest
 * `package.json` whose `name` matches -- this doesn't hardcode the SDK's
 * internal dist layout, only that `types.js` lives somewhere inside the
 * installed package directory.
 *
 * @returns {string | undefined}
 */
function readInstalledSdkVersion() {
  let dir = dirname(require.resolve('@modelcontextprotocol/sdk/types.js'));
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@modelcontextprotocol/sdk') return pkg.version;
    } catch {
      // Not the package root yet -- keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Pins the installed SDK version this module's two rendering-format
 * assumptions were verified against, per ADR 007/009's discipline for
 * message-shape-coupled classifiers (`docs/adr/007-protocol-error-channel.md`,
 * "-32602 disambiguation and its fragility"). This is deliberately an
 * exact-equality check, not a range check: `getParseErrorMessage()`
 * (`@modelcontextprotocol/sdk`'s `server/zod-compat.js`) has already
 * changed its rendering once between 1.29.0 and 1.30.0 (see ADR 009's
 * addendum) with no major-version bump and no deprecation notice, so
 * "within the same major" is not evidence the format held. A version bump
 * failing this test is the intended, loud signal to re-run the empirical
 * checks in ADR 009's addendum against the new version -- both formats
 * this file tests -- and only then move the pin, rather than the failure
 * mode this test exists to prevent: extractValidationPaths() silently
 * degrading back to `[]` with nothing failing at all.
 */
it("pins the installed @modelcontextprotocol/sdk version this file's two rendering formats were verified against", () => {
  expect(readInstalledSdkVersion()).toBe('1.30.0');
});

/** Registers a single tool named 'my-tool' with the given Zod input schema on a fresh McpServer. */
function createServerWithTool(inputSchema) {
  const mcpServer = new McpServer({ name: 'test-server', version: '0.0.0' });
  mcpServer.registerTool(
    'my-tool',
    { description: 'test tool', inputSchema },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
  return mcpServer;
}

/** Invokes 'my-tool' with the given arguments, bypassing the need for a live transport/connection. */
function callTool(mcpServer, args) {
  const handler = mcpServer.server._requestHandlers.get('tools/call');
  return handler({ method: 'tools/call', params: { name: 'my-tool', arguments: args } }, { requestId: 1 });
}

describe('extractValidationPaths — real McpServer / real Zod (isError: true, disguised) — exercises whichever format the pinned SDK version above actually renders (currently SDK 1.30.0\'s rendered "<message> at <path>" format, NOT the JSON array)', () => {
  it('extracts a single failing field', async () => {
    const mcpServer = createServerWithTool({ email: z.string().email() });
    const result = await callTool(mcpServer, { email: 'not-an-email' });

    expect(extractValidationPaths(result)).toEqual(['email']);
  });

  it('extracts multiple failing fields, in issue order', async () => {
    const mcpServer = createServerWithTool({ email: z.string().email(), age: z.number() });
    const result = await callTool(mcpServer, { email: 'not-an-email', age: 'not-a-number' });

    expect(extractValidationPaths(result)).toEqual(['email', 'age']);
  });

  it('dot-joins a nested path', async () => {
    const mcpServer = createServerWithTool({ user: z.object({ profile: z.object({ age: z.number() }) }) });
    const result = await callTool(mcpServer, { user: { profile: { age: 'not-a-number' } } });

    expect(extractValidationPaths(result)).toEqual(['user.profile.age']);
  });

  it('returns [] for a genuine business-logic isError: true failure with no embedded JSON', async () => {
    const result = { isError: true, content: [{ type: 'text', text: 'upstream service unavailable' }] };
    expect(extractValidationPaths(result)).toEqual([]);
  });
});

describe('extractValidationPaths — thrown McpError (low-level Server path)', () => {
  it('extracts a single failing field from a real thrown McpError', () => {
    const err = new McpError(
      ErrorCode.InvalidParams,
      'Input validation error: Invalid arguments for tool foo: [{"code":"invalid_type","path":["email"],"message":"bad"}]',
    );
    expect(extractValidationPaths(err)).toEqual(['email']);
  });

  it('returns [] for a plain thrown Error with no JSON at all', () => {
    expect(extractValidationPaths(new Error('boom'))).toEqual([]);
  });
});

describe('extractValidationPaths — SDK 1.30.0+ rendered format ("<message> at <path>", synthetic — exercised for real above via the McpServer describe block)', () => {
  it('extracts a single failing field', () => {
    const err = new McpError(
      ErrorCode.InvalidParams,
      'Input validation error: Invalid arguments for tool foo: Invalid email address at email',
    );
    expect(extractValidationPaths(err)).toEqual(['email']);
  });

  it('extracts multiple failing fields, in issue order', () => {
    const text =
      'MCP error -32602: Input validation error: Invalid arguments for tool my-tool: Invalid email address at email\nInvalid input: expected number, received string at age';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['email', 'age']);
  });

  it('dot-joins a nested path', () => {
    const text = 'Input validation error: Invalid arguments for tool foo: Invalid input at user.profile.age';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['user.profile.age']);
  });

  it("normalizes a bracketed array-index path to dots, matching the JSON path's join('.') convention", () => {
    const text = 'Input validation error: Invalid arguments for tool foo: Invalid input at items[3].name';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['items.3.name']);
  });

  it('works for the output-validation marker too, not just input', () => {
    const text =
      'MCP error -32602: Output validation error: Invalid structured content for tool foo: Invalid input at value';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['value']);
  });

  it('a root-level issue (no " at " suffix at all) contributes no path entry, not a bogus one', () => {
    const text =
      'Input validation error: Invalid arguments for tool foo: Value must be a positive number\nInvalid input at count';
    // First line is a root-level issue (no path) -- only the second line's
    // "count" should surface, not a fabricated entry for the first.
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['count']);
  });

  it('a line whose own message text happens to contain " at " followed by prose (not a path) is skipped, not misread', () => {
    const text = 'Input validation error: Invalid arguments for tool foo: Number must be at least 5';
    // "least 5" contains a space, so it fails RENDERED_DOT_PATH_RE and is
    // correctly not mistaken for a field path -- this is a genuine
    // root-level issue whose message merely contains the substring " at ".
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });

  it('a message mixing a recognisable path-bearing line with an unrecognisable one extracts only the recognisable one', () => {
    const text =
      'Input validation error: Invalid arguments for tool foo: Number must be at least 5\nInvalid input at age';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['age']);
  });

  it('never attempts rendered-format parsing on text without the input/output validation marker (would otherwise false-positive on ordinary prose)', () => {
    const text = 'Please look at the docs for details';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });
});

describe('extractValidationPaths — defensive degradation (never guesses, never throws)', () => {
  it('returns [] for malformed input', () => {
    expect(extractValidationPaths(null)).toEqual([]);
    expect(extractValidationPaths(undefined)).toEqual([]);
    expect(extractValidationPaths('a string')).toEqual([]);
    expect(extractValidationPaths(42)).toEqual([]);
    expect(extractValidationPaths({})).toEqual([]);
  });

  it('returns [] for a JSON array that parses but is not Zod-issue-shaped', () => {
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text: '["just", "some", "strings"]' }] })).toEqual(
      [],
    );
    expect(
      extractValidationPaths({
        isError: true,
        content: [{ type: 'text', text: '[{"foo":"bar"}]' }], // no path, no message
      }),
    ).toEqual([]);
  });

  it('returns [] (not a partial result) when only SOME array elements look Zod-issue-shaped', () => {
    const text = '[{"path":["email"],"message":"bad"},{"unrelated":true}]';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });

  it('returns [] for unbalanced brackets rather than a truncated guess', () => {
    const text = 'Input validation error: [{"path":["email"],"message":"bad"}';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });

  it('does not mistake a bracket inside a string VALUE for the end of the array', () => {
    // The issue's own message contains a literal "]" before the array's
    // real closing bracket -- the string-aware scanner must not stop early.
    const text =
      '[{"path":["choice"],"message":"expected one of [a, b, c]"},{"path":["other"],"message":"also bad"}]';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual(['choice', 'other']);
  });

  it('never throws on a hostile content accessor', () => {
    const hostile = {
      isError: true,
      get content() {
        throw new Error('accessor blew up');
      },
    };
    expect(() => extractValidationPaths(hostile)).not.toThrow();
    expect(extractValidationPaths(hostile)).toEqual([]);
  });

  it('returns [] when path array elements are not strings/numbers', () => {
    const text = '[{"path":[{"nested":"object"}],"message":"bad"}]';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });

  it('returns [] for an empty path array', () => {
    const text = '[{"path":[],"message":"bad"}]';
    expect(extractValidationPaths({ isError: true, content: [{ type: 'text', text }] })).toEqual([]);
  });
});
