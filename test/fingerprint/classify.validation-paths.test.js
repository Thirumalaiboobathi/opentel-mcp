import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { extractValidationPaths } from '../../src/fingerprint/classify/validation-paths.js';

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

describe('extractValidationPaths — real McpServer / real Zod (isError: true, disguised)', () => {
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
