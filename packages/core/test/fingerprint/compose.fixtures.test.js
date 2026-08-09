import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '../../src/fingerprint/compose.js';

/**
 * Regression fixtures for ADR 007 (docs/adr/007-protocol-error-channel.md):
 * the ADR decided the new `channel` dimension (classifyFailureChannel(),
 * src/fingerprint/classify/channel.js) stays OUT of computeFingerprint()'s
 * hash input — it's a separate, additive span attribute
 * (mcp.failure.channel), never part of FingerprintInputs. That means every
 * fingerprint computeFingerprint() produced in the published v0.6.1 release
 * must still produce the exact same fingerprint after ADR 007's Phase 1-3
 * work, byte-for-byte, even for inputs that are now ALSO run through
 * classifyFailureChannel() elsewhere (src/instrument.js).
 *
 * PROVENANCE: these fixture values are not just "whatever the code produces
 * today" — they were captured by extracting the actual, published v0.6.1
 * git tag's src/fingerprint/ tree in isolation and running its
 * computeFingerprint() directly, independent of this working tree:
 *
 *   rm -rf /tmp/v0.6.1-fingerprint && mkdir -p /tmp/v0.6.1-fingerprint
 *   git archive v0.6.1 src/fingerprint | tar -x -C /tmp/v0.6.1-fingerprint
 *   cd /tmp/v0.6.1-fingerprint && node --input-type=module -e "..."
 *
 * A `git diff v0.6.1 -- <path>` was also confirmed empty for every file
 * computeFingerprint() touches (compose.js, hash.js, normalize/*,
 * classify/*.js, types.d.ts) — none of them have changed since v0.6.1, so
 * these values are expected to match by construction, not coincidence. This
 * test is what makes that fact verifiable and continuously enforced, rather
 * than an unverified assertion.
 *
 * If this test ever fails, computeFingerprint()'s hash input changed —
 * which, per ADR 007, is exactly the breaking change for existing
 * fingerprint-based alerts/dashboards this work was required not to make.
 */
describe('computeFingerprint — fingerprint-stability fixtures, verified against the published v0.6.1 tag', () => {
  it('isError: true tool-error result fingerprint is unchanged', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'invalid input: missing field "email"' }] };
    const failure = computeFingerprint(result, { toolName: 'some-tool', origin: 'tool_error', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: 'ee14198d8cab113c',
      signature: 'MCPToolError@anon:?',
      category: 'validation',
      origin: 'tool_error',
      inputs: {
        errorClass: 'MCPToolError',
        category: 'validation',
        origin: 'tool_error',
        toolName: 'some-tool',
        normalizedMessage: 'invalid input: missing field "email"',
        stackSignature: '',
      },
    });
  });

  it('thrown validation-shaped error fingerprint is unchanged', () => {
    const err = { name: 'ValidationError', message: 'missing required field: email' };
    const failure = computeFingerprint(err, { toolName: 'some-tool', origin: 'thrown', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: '5db67de72cde761d',
      signature: 'ValidationError@anon:?',
      category: 'validation',
      origin: 'thrown',
      inputs: {
        errorClass: 'ValidationError',
        category: 'validation',
        origin: 'thrown',
        toolName: 'some-tool',
        normalizedMessage: 'missing required field: email',
        stackSignature: '',
      },
    });
  });

  it('a thrown protocol-shaped (McpError-like, "not found") error fingerprint is unchanged', () => {
    // Same shape a real McpError would have when caught in instrument.js's
    // thrown branch: .code plus a message the SDK already prefixed with
    // "MCP error {code}: " (see classify/channel.js's docblock). This is
    // exactly the kind of failure Phase 2/3 makes newly visible via
    // mcp.failure.channel ('protocol.not_found') -- its fingerprint must
    // still be untouched.
    const err = { name: 'McpError', message: 'MCP error -32602: Tool some-tool not found', code: -32602 };
    const failure = computeFingerprint(err, { toolName: 'some-tool', origin: 'thrown', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: '1ca638595791ce2f',
      signature: 'McpError@anon:?',
      category: 'internal',
      origin: 'thrown',
      inputs: {
        errorClass: 'McpError',
        category: 'internal',
        origin: 'thrown',
        toolName: 'some-tool',
        normalizedMessage: 'MCP error -<NUM>: Tool some-tool not found',
        stackSignature: '',
      },
    });
  });

  it('a thrown protocol-shaped (McpError-like, input validation) error fingerprint is unchanged', () => {
    // classifies as mcp.failure.channel: 'protocol.input' (Phase 3) --
    // fingerprint must be identical regardless.
    const err = {
      name: 'McpError',
      message: 'MCP error -32602: Input validation error: Invalid arguments for tool foo: bad shape',
      code: -32602,
    };
    const failure = computeFingerprint(err, { toolName: 'foo', origin: 'thrown', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: '8ce01d49cf02f0c9',
      signature: 'McpError@anon:?',
      category: 'validation',
      origin: 'thrown',
      inputs: {
        errorClass: 'McpError',
        category: 'validation',
        origin: 'thrown',
        toolName: 'foo',
        normalizedMessage: 'MCP error -<NUM>: Input validation error: Invalid arguments for tool foo: bad shape',
        stackSignature: '',
      },
    });
  });

  it('a thrown protocol-shaped (McpError-like, output validation) error fingerprint is unchanged', () => {
    // classifies as mcp.failure.channel: 'protocol.output' (Phase 3,
    // excluded from thrash detection) -- fingerprint must be identical
    // regardless of that exclusion.
    const err = {
      name: 'McpError',
      message: 'MCP error -32602: Output validation error: Tool foo has an output schema but no structured content was provided',
      code: -32602,
    };
    const failure = computeFingerprint(err, { toolName: 'foo', origin: 'thrown', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: 'a3a9a8596c2fbe13',
      signature: 'McpError@anon:?',
      category: 'internal',
      origin: 'thrown',
      inputs: {
        errorClass: 'McpError',
        category: 'internal',
        origin: 'thrown',
        toolName: 'foo',
        normalizedMessage: 'MCP error -<NUM>: Output validation error: Tool foo has an output schema but no structured content was provided',
        stackSignature: '',
      },
    });
  });

  it('a McpServer-disguised (isError: true) output-validation failure fingerprint is unchanged', () => {
    // This is the exact shape recoverDisguisedProtocolFailure() (Phase 3
    // verification fix) reads content[0].text from to recover
    // mcp.failure.channel: 'protocol.output' even though isError: true --
    // the recovery logic lives entirely in classify/channel.js, never
    // touches computeFingerprint()'s inputs, so the fingerprint must be
    // identical to what v0.6.1 already produced for this same object shape.
    const result = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Output validation error: Tool foo has an output schema but no structured content was provided',
        },
      ],
    };
    const failure = computeFingerprint(result, { toolName: 'foo', origin: 'tool_error', cwd: '/fixed/cwd' });

    expect(failure).toEqual({
      fingerprint: '80d017d10ecf82de',
      signature: 'MCPToolError@anon:?',
      category: 'internal',
      origin: 'tool_error',
      inputs: {
        errorClass: 'MCPToolError',
        category: 'internal',
        origin: 'tool_error',
        toolName: 'foo',
        normalizedMessage: 'MCP error -<NUM>: Output validation error: Tool foo has an output schema but no structured content was provided',
        stackSignature: '',
      },
    });
  });
});
