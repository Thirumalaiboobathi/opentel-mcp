import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { computeFingerprint } from '../src/fingerprint/compose.js';
import { ATTR_ERROR_TYPE, MCP_METHOD_NAME_TOOLS_LIST } from '../src/attributes.js';

/** Fresh, unconnected low-level Server — every test builds its own. */
function createServer(name = 'test-server') {
  return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
}

function invokeToolCall(server, params, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/call');
  return handler({ method: 'tools/call', params }, extra);
}

function invokeToolsList(server, params = {}, extra = { requestId: 1 }) {
  const handler = server._requestHandlers.get('tools/list');
  return handler({ method: 'tools/list', params }, extra);
}

/** Builds an Error with a fully controlled message + stack — real Error.stack capture points at THIS test
 * file's own lines, which is useless for asserting on specific normalization behavior, so every test that
 * cares about message/stack content overrides both explicitly, the same pattern
 * test/fingerprint/compose.test.js's stackWithFrame() already establishes for this codebase. */
function buildError({ name = 'Error', message = 'boom', stack } = {}) {
  const err = new Error(message);
  err.name = name;
  if (stack !== undefined) err.stack = stack;
  return err;
}

function exceptionEvent(span) {
  return span.events.find((e) => e.name === 'exception');
}

let memoryExporter;
let provider;

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  provider.register({ contextManager: null, propagator: null });
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  memoryExporter.reset();
});

describe('errorRecording.mode — ADR 019 Part 1 (docs/adr/019-raw-content-on-spans.md)', () => {
  describe('default ("full") is byte-identical to pre-v0.13.0 behavior', () => {
    it('does not require the errorRecording option at all — omitting it behaves exactly like { mode: "full" }', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ name: 'TypeError', message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('boom');
      const event = exceptionEvent(span);
      expect(event).toBeDefined();
      expect(event.attributes['exception.type']).toBe('TypeError');
      expect(event.attributes['exception.message']).toBe('boom');
    });

    it('an explicit { mode: "full" } produces the exact same span state as omitting the option', async () => {
      const withDefault = createServer();
      instrumentMcpServer(withDefault, { serviceName: 'svc' });
      withDefault.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ name: 'RangeError', message: 'user@example.com not found' });
      });
      await invokeToolCall(withDefault, { name: 'echo', arguments: {} }).catch(() => {});
      const [defaultSpan] = memoryExporter.getFinishedSpans();
      memoryExporter.reset();

      const withExplicitFull = createServer();
      instrumentMcpServer(withExplicitFull, { serviceName: 'svc', errorRecording: { mode: 'full' } });
      withExplicitFull.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ name: 'RangeError', message: 'user@example.com not found' });
      });
      await invokeToolCall(withExplicitFull, { name: 'echo', arguments: {} }).catch(() => {});
      const [explicitSpan] = memoryExporter.getFinishedSpans();

      // 'full' mode never scrubs — the raw email survives verbatim in both cases, proving the explicit
      // option didn't silently take a different, safer code path than the default.
      expect(explicitSpan.status.message).toBe(defaultSpan.status.message);
      expect(explicitSpan.status.message).toBe('user@example.com not found');
      expect(exceptionEvent(explicitSpan).attributes['exception.message']).toBe(
        exceptionEvent(defaultSpan).attributes['exception.message'],
      );
    });

    it('"full" mode carries the raw, unnormalized message verbatim (an email is not scrubbed)', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'full' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.message).toBe('user jane@example.com not found');
      expect(exceptionEvent(span).attributes['exception.message']).toBe('user jane@example.com not found');
    });
  });

  describe('"normalized" mode', () => {
    it('strips an email from the exception message and status description', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.message).toBe('user <EMAIL> not found');
      expect(span.status.message).not.toContain('jane@example.com');
      const event = exceptionEvent(span);
      expect(event.attributes['exception.message']).toBe('user <EMAIL> not found');
      expect(event.attributes['exception.message']).not.toContain('jane@example.com');
    });

    it('strips an absolute filesystem path (the cwd prefix) from the exception stacktrace, keeping fn/file/line', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      const cwd = process.cwd();
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({
          message: 'boom',
          stack: `Error: boom\n    at handleThing (${cwd}/fake/src/handler.js:42:7)`,
        });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const stacktrace = exceptionEvent(span).attributes['exception.stacktrace'];
      expect(stacktrace).toBeDefined();
      // The cwd prefix (an absolute path whose leading segment can be a real
      // OS username or home directory — ADR 019 Part 1) must not survive...
      expect(stacktrace).not.toContain(cwd);
      // ...but the function name, relative file, and line number — the
      // actual diagnostic content a stack trace exists to provide — must.
      expect(stacktrace).toContain('handleThing');
      expect(stacktrace).toContain('fake/src/handler.js');
      expect(stacktrace).toContain('42');
    });

    it('does not mutate the original thrown error object', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      const originalMessage = 'user jane@example.com not found';
      const originalStack = `Error: boom\n    at handleThing (${process.cwd()}/fake/src/handler.js:42:7)`;
      let thrown;
      server.setRequestHandler(CallToolRequestSchema, async () => {
        thrown = buildError({ message: originalMessage, stack: originalStack });
        throw thrown;
      });

      const rejection = invokeToolCall(server, { name: 'echo', arguments: {} }).catch((e) => e);
      const caught = await rejection;

      expect(caught).toBe(thrown);
      expect(thrown.message).toBe(originalMessage);
      expect(thrown.stack).toBe(originalStack);
    });

    it('caps exception.type at 128 characters, same as error.type', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ name: 'A'.repeat(200), message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(exceptionEvent(span).attributes['exception.type']).toHaveLength(128);
      expect(span.attributes[ATTR_ERROR_TYPE]).toHaveLength(128);
    });

    it('still sets the ERROR status code and the exception event fires', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(exceptionEvent(span)).toBeDefined();
    });

    it('the span\'s exception.message and computeFingerprint()\'s normalizedMessage come from the same computation — cannot drift apart', async () => {
      // A thrown STRING, not an Error instance, is exactly the shape the
      // pre-consolidation `recordThrownException()` mishandled: its old,
      // independent `err?.message` read returned undefined (a string has
      // no `.message` property), silently omitting `exception.message`
      // from the span, while `computeFingerprint()`'s own `coerceError()`
      // already special-cased a thrown string and hashed real content
      // into `mcp.failure.fingerprint` regardless — same `err`, two call
      // sites, two different answers. Both now go through
      // `normalizeException()` (fingerprint/normalize/exception.js), so
      // this asserts they can't disagree: not "happen to produce the
      // same string today," but literally the same computation.
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      const thrown = 'upstream lookup failed for user jane.doe@example.com';
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw thrown;
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const spanMessage = exceptionEvent(span).attributes['exception.message'];
      expect(spanMessage).toBeDefined();
      expect(spanMessage).not.toContain('jane.doe@example.com');

      // The exact err value the handler threw, run through the real
      // fingerprint pipeline directly — must be byte-identical to what
      // landed on the span above.
      const fingerprintResult = computeFingerprint(thrown, { toolName: 'echo', origin: 'thrown' });
      expect(fingerprintResult.inputs.normalizedMessage).toBe(spanMessage);
      expect(fingerprintResult.inputs.normalizedMessage).toBe('upstream lookup failed for user <EMAIL>');
    });
  });

  describe('"none" mode', () => {
    it('records neither an exception event nor a status message', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(exceptionEvent(span)).toBeUndefined();
      expect(span.status.message).toBeUndefined();
    });

    it('still sets the ERROR status code', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('still sets error.type, capped, even though the exception event is skipped', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ name: 'TypeError', message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.attributes[ATTR_ERROR_TYPE]).toBe('TypeError');
    });

    it('a tool-level isError: true failure (no thrown Error at all) is unaffected by this option', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      const toolResult = { isError: true, content: [{ type: 'text', text: 'tool blew up' }] };
      server.setRequestHandler(CallToolRequestSchema, async () => toolResult);

      const result = await invokeToolCall(server, { name: 'echo', arguments: {} });

      expect(result).toEqual(toolResult);
      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(exceptionEvent(span)).toBeUndefined();
    });
  });

  describe('invalid errorRecording.mode falls back silently to "full"', () => {
    it('an unrecognized mode string behaves exactly like "full", never throws', async () => {
      const server = createServer();
      expect(() => instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalised' } })).not.toThrow();
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      // Falls back to 'full': the raw, unscrubbed email survives.
      expect(span.status.message).toBe('user jane@example.com not found');
    });
  });

  describe('applies to both thrown paths: tools/call AND tools/list', () => {
    it('"normalized" mode scrubs the message on a thrown tools/list handler too', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolsList(server).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
      expect(span.status.message).toBe('user <EMAIL> not found');
      expect(exceptionEvent(span).attributes['exception.message']).toBe('user <EMAIL> not found');
    });

    it('"none" mode records neither event nor message on a thrown tools/list handler', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolsList(server).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(exceptionEvent(span)).toBeUndefined();
      expect(span.status.message).toBeUndefined();
    });

    it('"full" mode (default) on tools/list is byte-identical to pre-v0.13.0 behavior', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'backend unavailable' });
      });

      await invokeToolsList(server).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans().filter((s) => s.name === MCP_METHOD_NAME_TOOLS_LIST);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('backend unavailable');
      expect(exceptionEvent(span)).toBeDefined();
    });

    it('the thrown error still propagates to the caller regardless of mode', async () => {
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw new Error('backend unavailable');
      });

      await expect(invokeToolsList(server)).rejects.toThrow('backend unavailable');
    });
  });

  describe('OTEL_MCP_ERROR_RECORDING_MODE environment variable', () => {
    const ENV_KEY = 'OTEL_MCP_ERROR_RECORDING_MODE';
    let savedEnv;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    it('selects "normalized" mode end-to-end through instrumentMcpServer() when no explicit option is passed', async () => {
      process.env[ENV_KEY] = 'normalized';
      const server = createServer();
      instrumentMcpServer(server, { serviceName: 'svc' });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.message).toBe('user <EMAIL> not found');
    });
  });
});
