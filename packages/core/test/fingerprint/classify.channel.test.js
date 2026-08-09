import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { classifyFailureChannel } from '../../src/fingerprint/classify/channel.js';

describe('classifyFailureChannel — execution channel', () => {
  it('classifies isError: true CallToolResult as execution', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    expect(classifyFailureChannel(result)).toBe('execution');
  });

  it('classifies as execution even when a stray top-level code property is present', () => {
    // isError: true is definitionally a JSON-RPC success. A top-level
    // `code` property is never inspected in this branch at all — only
    // content[0].text is (see recoverDisguisedProtocolFailure()) — and an
    // empty content array gives it nothing to recover from.
    const result = { isError: true, code: -32602, content: [] };
    expect(classifyFailureChannel(result)).toBe('execution');
  });
});

describe('classifyFailureChannel — disguised protocol failure recovery (McpServer isError: true wrapping)', () => {
  it('recovers protocol.not_found from a disguised -32601 (bare code, no message)', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'MCP error -32601: Method not found' }] };
    expect(classifyFailureChannel(result)).toBe('protocol.not_found');
  });

  it('recovers protocol.not_found from a disguised "tool not found" -32602', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool foo not found' }] };
    expect(classifyFailureChannel(result)).toBe('protocol.not_found');
  });

  it('recovers protocol.input from a disguised input-validation -32602', () => {
    const result = {
      isError: true,
      content: [{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool foo: x' }],
    };
    expect(classifyFailureChannel(result)).toBe('protocol.input');
  });

  it('recovers protocol.output from a disguised output-validation -32602', () => {
    const result = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Output validation error: Tool foo has an output schema but no structured content was provided',
        },
      ],
    };
    expect(classifyFailureChannel(result)).toBe('protocol.output');
  });

  describe('defensive degradation when the wrapper format is absent or has changed', () => {
    it('degrades to execution for wording that looks protocol-ish but has no "MCP error N:" wrapper at all', () => {
      // Proves the recovery step requires the exact wrapper -- it does not
      // fall back to loosely matching "not found"/"disabled" wording the
      // way the genuine-protocol-error path does, since without the
      // wrapper there is no confirmed JSON-RPC code to key off.
      const result = { isError: true, content: [{ type: 'text', text: 'Tool foo not found' }] };
      expect(classifyFailureChannel(result)).toBe('execution');
    });

    it('degrades to execution when the wrapper wording changes (simulated SDK change: missing "MCP")', () => {
      const result = { isError: true, content: [{ type: 'text', text: 'Error code -32602: Tool foo not found' }] };
      expect(classifyFailureChannel(result)).toBe('execution');
    });

    it('degrades to execution when the wrapper punctuation changes (simulated SDK change: dash instead of colon)', () => {
      const result = { isError: true, content: [{ type: 'text', text: 'MCP error -32602 - Tool foo not found' }] };
      expect(classifyFailureChannel(result)).toBe('execution');
    });

    it('degrades to execution when the wrapper has no code digits at all (simulated SDK change)', () => {
      const result = { isError: true, content: [{ type: 'text', text: 'MCP error: Tool foo not found' }] };
      expect(classifyFailureChannel(result)).toBe('execution');
    });

    it('degrades to execution for missing/malformed content shapes', () => {
      expect(classifyFailureChannel({ isError: true })).toBe('execution'); // no content at all
      expect(classifyFailureChannel({ isError: true, content: 'not-an-array' })).toBe('execution');
      expect(classifyFailureChannel({ isError: true, content: [] })).toBe('execution');
      expect(classifyFailureChannel({ isError: true, content: [{ type: 'text' }] })).toBe('execution'); // no text
      expect(classifyFailureChannel({ isError: true, content: [{ type: 'text', text: 42 }] })).toBe('execution'); // non-string text
      expect(classifyFailureChannel({ isError: true, content: ['not-an-object'] })).toBe('execution');
    });

    it('never throws even when content access itself throws (degrades to unknown, not execution — content access failing means the isError:true shape itself could not be confirmed safe to read)', () => {
      const hostile = {
        isError: true,
        get content() {
          throw new Error('accessor blew up');
        },
      };
      expect(() => classifyFailureChannel(hostile)).not.toThrow();
      expect(classifyFailureChannel(hostile)).toBe('unknown');
    });
  });
});

describe('classifyFailureChannel — assessed risk: a genuine tool message that happens to start with "MCP error N:"', () => {
  // A tool proxying/forwarding a downstream MCP call's error text verbatim
  // could plausibly produce a message starting with "MCP error {code}: ".
  // This is a real, if narrow, misclassification risk -- documented here
  // as CURRENT, INTENTIONAL behavior (not a bug), not silently left
  // undiscoverable. See ADR 007's addendum for the full assessment: for
  // any code other than -32601/-32602, the practical impact is cosmetic
  // (mcp.failure.channel: 'protocol.other' carries the same thrash
  // threshold as 'execution'). The sharper case is a forwarded -32602
  // "Output validation error:" message, which would be excluded from
  // thrash entirely even though it's a genuine, repeatable execution
  // failure from this tool's own perspective.
  it('a forwarded/echoed message starting with "MCP error N:" for a non-protocol code classifies as protocol.other, not execution', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'MCP error 4: rate limited by upstream API' }] };
    expect(classifyFailureChannel(result)).toBe('protocol.other');
  });

  it('a forwarded downstream output-validation message is recovered as protocol.output, even though it is this tool\'s own genuine failure', () => {
    // This is the sharpest version of the risk: this specific
    // misclassification EXCLUDES the failure from thrash detection
    // entirely (ADR 007's exclusion), not merely relabels it.
    const result = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Output validation error: Tool downstream-tool has an output schema but no structured content was provided',
        },
      ],
    };
    expect(classifyFailureChannel(result)).toBe('protocol.output');
  });
});

describe('classifyFailureChannel — protocol.not_found', () => {
  it('classifies a raw -32601 MethodNotFound error object', () => {
    expect(classifyFailureChannel({ code: ErrorCode.MethodNotFound, message: 'Method not found' })).toBe(
      'protocol.not_found',
    );
  });

  it('classifies -32601 as not_found even without a message', () => {
    expect(classifyFailureChannel({ code: -32601 })).toBe('protocol.not_found');
  });

  it('classifies a real McpError for "tool not found" (-32602) as not_found', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Tool foo not found');
    expect(classifyFailureChannel(err)).toBe('protocol.not_found');
  });

  it('classifies a real McpError for "tool disabled" (-32602) as not_found', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Tool foo disabled');
    expect(classifyFailureChannel(err)).toBe('protocol.not_found');
  });

  it('matches "not found"/"disabled" case-insensitively', () => {
    expect(classifyFailureChannel({ code: -32602, message: 'tool FOO NOT FOUND' })).toBe('protocol.not_found');
    expect(classifyFailureChannel({ code: -32602, message: 'tool FOO DISABLED' })).toBe('protocol.not_found');
  });
});

describe('classifyFailureChannel — protocol.input', () => {
  it('classifies a real McpError input-validation failure', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Input validation error: Invalid arguments for tool foo: bad shape');
    expect(classifyFailureChannel(err)).toBe('protocol.input');
  });

  it('classifies a plain wire-shaped -32602 input validation error', () => {
    expect(
      classifyFailureChannel({ code: -32602, message: 'Input validation error: Invalid arguments for tool foo: x' }),
    ).toBe('protocol.input');
  });
});

describe('classifyFailureChannel — protocol.output', () => {
  it('classifies a real McpError output-validation failure (missing structured content)', () => {
    const err = new McpError(
      ErrorCode.InvalidParams,
      'Output validation error: Tool foo has an output schema but no structured content was provided',
    );
    expect(classifyFailureChannel(err)).toBe('protocol.output');
  });

  it('classifies a real McpError output-validation failure (invalid structured content)', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Output validation error: Invalid structured content for tool foo: bad shape');
    expect(classifyFailureChannel(err)).toBe('protocol.output');
  });

  it('is not miscategorized as protocol.input just because its message contains "invalid"', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Output validation error: Invalid structured content for tool foo: x');
    expect(classifyFailureChannel(err)).toBe('protocol.output');
  });
});

describe('classifyFailureChannel — protocol.other', () => {
  it('classifies InternalError (-32603) as protocol.other', () => {
    expect(classifyFailureChannel({ code: ErrorCode.InternalError, message: 'Internal error' })).toBe(
      'protocol.other',
    );
  });

  it('classifies ParseError (-32700) as protocol.other', () => {
    expect(classifyFailureChannel({ code: ErrorCode.ParseError, message: 'Parse error' })).toBe('protocol.other');
  });

  it('classifies an unrecognized custom/non-standard error code as protocol.other', () => {
    expect(classifyFailureChannel({ code: 4000, message: 'application-defined error' })).toBe('protocol.other');
    expect(classifyFailureChannel({ code: -32000, message: 'server error range' })).toBe('protocol.other');
  });

  it('falls back to protocol.other for -32602 with no message at all', () => {
    expect(classifyFailureChannel({ code: -32602 })).toBe('protocol.other');
    expect(classifyFailureChannel({ code: -32602, message: undefined })).toBe('protocol.other');
  });

  it('falls back to protocol.other for -32602 with an empty message', () => {
    expect(classifyFailureChannel({ code: -32602, message: '' })).toBe('protocol.other');
  });

  it('falls back to protocol.other for -32602 with a non-string message', () => {
    expect(classifyFailureChannel({ code: -32602, message: 42 })).toBe('protocol.other');
    expect(classifyFailureChannel({ code: -32602, message: null })).toBe('protocol.other');
  });

  it('simulates an SDK wording change: -32602 with an unrecognized message shape falls back gracefully, not to a wrong specific answer', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'Argument schema mismatch for tool foo, see details');
    expect(classifyFailureChannel(err)).toBe('protocol.other');
  });
});

describe('classifyFailureChannel — unknown (cannot be determined)', () => {
  it('classifies null as unknown', () => {
    expect(classifyFailureChannel(null)).toBe('unknown');
  });

  it('classifies undefined as unknown', () => {
    expect(classifyFailureChannel(undefined)).toBe('unknown');
  });

  it('classifies primitives as unknown', () => {
    expect(classifyFailureChannel('some string')).toBe('unknown');
    expect(classifyFailureChannel(42)).toBe('unknown');
    expect(classifyFailureChannel(true)).toBe('unknown');
  });

  it('classifies an array as unknown', () => {
    expect(classifyFailureChannel([1, 2, 3])).toBe('unknown');
  });

  it('classifies an empty object as unknown', () => {
    expect(classifyFailureChannel({})).toBe('unknown');
  });

  it('classifies a plain thrown Error with no code and no isError as unknown', () => {
    expect(classifyFailureChannel(new Error('boom'))).toBe('unknown');
  });

  it('classifies isError: false with no code as unknown', () => {
    expect(classifyFailureChannel({ isError: false })).toBe('unknown');
  });

  it('classifies a truthy-but-not-strictly-true isError as unknown rather than guessing execution', () => {
    expect(classifyFailureChannel({ isError: 'true' })).toBe('unknown');
    expect(classifyFailureChannel({ isError: 1 })).toBe('unknown');
  });

  it('classifies a non-numeric code as unknown', () => {
    expect(classifyFailureChannel({ code: 'INVALID_PARAMS' })).toBe('unknown');
    expect(classifyFailureChannel({ code: null })).toBe('unknown');
  });

  it('classifies a non-integer numeric code as unknown', () => {
    expect(classifyFailureChannel({ code: -32602.5 })).toBe('unknown');
    expect(classifyFailureChannel({ code: NaN })).toBe('unknown');
    expect(classifyFailureChannel({ code: Infinity })).toBe('unknown');
  });
});

describe('classifyFailureChannel — never throws', () => {
  it('does not throw when message access itself throws', () => {
    const hostile = {
      code: -32602,
      get message() {
        throw new Error('accessor blew up');
      },
    };
    expect(() => classifyFailureChannel(hostile)).not.toThrow();
    expect(classifyFailureChannel(hostile)).toBe('unknown');
  });

  it('does not throw when isError access itself throws', () => {
    const hostile = {
      get isError() {
        throw new Error('accessor blew up');
      },
    };
    expect(() => classifyFailureChannel(hostile)).not.toThrow();
    expect(classifyFailureChannel(hostile)).toBe('unknown');
  });
});
