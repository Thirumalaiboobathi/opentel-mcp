import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeFingerprint } from '../../src/fingerprint/compose.js';
import { normalizeMessage } from '../../src/fingerprint/normalize/message.js';

/**
 * ADR 009 (docs/adr/009-field-level-convergence.md): "same field failing
 * repeatedly" vs. "a different field failing each attempt" (an agent
 * converging on a correct call) are ALREADY distinguished by
 * computeFingerprint() today -- as a side effect of hashing the full Zod
 * issues JSON (which embeds each failing field's `path`), not by any
 * deliberate design. Agent Thrash Detection's per-origin thresholds (ADR
 * 007 Phase 3) depend on this: a repeating same-field fingerprint is what
 * lets `protocol.input` failures accumulate toward `inputThreshold` at
 * all, and a changing fingerprint per attempt is what currently keeps a
 * converging agent from ever crossing it.
 *
 * THIS IS LOAD-BEARING BEHAVIOR, NOT INCIDENTAL. It depends entirely on
 * two things nothing in this codebase enforces: (1) Zod's ZodError
 * messages embedding `path` and not the specific invalid value tried, and
 * (2) normalizeMessage()'s stripping patterns never touching plain field
 * names. Either could change silently in a future Zod or SDK version, or
 * in this codebase's own normalize/patterns.js. If you are looking at a
 * failing test here, computeFingerprint() itself did not necessarily
 * break -- but the field-level distinction ADR 007 Phase 3's per-origin
 * thresholds quietly rely on may have, which is exactly why this file
 * exists.
 */

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

const CTX = { toolName: 'my-tool', origin: 'tool_error', cwd: '/fixed/cwd' };

describe('ADR 009: computeFingerprint() already distinguishes same-field vs. different-field validation failures', () => {
  it('the SAME field failing with DIFFERENT invalid values produces an IDENTICAL fingerprint across attempts', async () => {
    const mcpServer = createServerWithTool({ status: z.enum(['active', 'inactive', 'pending']) });

    const attempt1 = await callTool(mcpServer, { status: 'wrong-value-1' });
    const attempt2 = await callTool(mcpServer, { status: 'wrong-value-2' });
    expect(attempt1.isError).toBe(true);
    expect(attempt2.isError).toBe(true);

    const f1 = computeFingerprint(attempt1, CTX);
    const f2 = computeFingerprint(attempt2, CTX);

    // If this ever fails, Zod started echoing the actual invalid value into
    // its issue message -- which would make every distinct bad value its
    // own fingerprint, defeating same-field thrash accumulation entirely.
    expect(f1.fingerprint).toBe(f2.fingerprint);
  });

  it('the SAME field failing is stable across many distinct wrong values, not just a lucky pair', async () => {
    const mcpServer = createServerWithTool({ mode: z.literal('strict') });

    const results = await Promise.all(
      ['loose-1', 'loose-2', 'loose-3', 'completely-different'].map((v) => callTool(mcpServer, { mode: v })),
    );
    const fingerprints = results.map((r) => computeFingerprint(r, CTX).fingerprint);

    expect(new Set(fingerprints).size).toBe(1);
  });

  it('a DIFFERENT field failing on each attempt produces a DIFFERENT fingerprint every time', async () => {
    const mcpServer = createServerWithTool({ email: z.string().email(), age: z.number() });

    const emailFails = await callTool(mcpServer, { email: 'not-an-email', age: 30 });
    const ageFails = await callTool(mcpServer, { email: 'real@example.com', age: 'not-a-number' });
    expect(emailFails.isError).toBe(true);
    expect(ageFails.isError).toBe(true);

    const f1 = computeFingerprint(emailFails, CTX);
    const f2 = computeFingerprint(ageFails, CTX);

    // If this ever fails (fingerprints collapse to the same value), an
    // agent converging by fixing one field at a time would look
    // indistinguishable from an agent stuck on one ambiguous field --
    // exactly the false positive ADR 009 was investigating.
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it('custom .refine() failures on the same field are also stable across different invalid inputs', async () => {
    const mcpServer = createServerWithTool({
      note: z.string().refine((v) => v.startsWith('X'), { message: 'must start with X' }),
    });

    const attempt1 = await callTool(mcpServer, { note: 'hello-1' });
    const attempt2 = await callTool(mcpServer, { note: 'totally-different-2' });

    const f1 = computeFingerprint(attempt1, CTX);
    const f2 = computeFingerprint(attempt2, CTX);

    expect(f1.fingerprint).toBe(f2.fingerprint);
  });
});

describe('ADR 009: normalizeMessage() must never strip field names out of a Zod path array', () => {
  it('leaves a plain alphabetic path segment untouched', () => {
    const message = 'Input validation error: [{"path":["email"],"message":"Invalid email address"}]';
    expect(normalizeMessage(message)).toContain('"path":["email"]');
  });

  it('leaves a nested path untouched', () => {
    const message = '[{"path":["user","profile","age"],"message":"Expected number"}]';
    expect(normalizeMessage(message)).toContain('"path":["user","profile","age"]');
  });

  it('does not misclassify common field names as a UUID/email/timestamp/hex run/opaque id and replace them with a placeholder', () => {
    // Deliberately includes an underscore name and a camelCase name --
    // the two shapes most likely to accidentally brush up against the
    // opaque-quoted-id pattern (8-64 chars, mixed letters+digits) in
    // normalize/patterns.js.
    const fieldNames = ['email', 'age', 'status', 'mode', 'note', 'user_id', 'startDate'];
    for (const name of fieldNames) {
      const message = `[{"path":["${name}"],"message":"bad"}]`;
      expect(normalizeMessage(message)).toContain(`"${name}"`);
    }
  });
});
