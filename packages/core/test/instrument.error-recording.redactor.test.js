import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, diag, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { computeFingerprint } from '../src/fingerprint/compose.js';
import { ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';
import { __resetRedactorNoOpWarnedForTests } from '../src/error-recording/config.js';

/**
 * ADR 020 (docs/adr/020-redactor-hook.md), v0.14.0 Phase 2: integration
 * tests for the redactor hook wired into recordThrownException() through
 * the public instrumentMcpServer() entry point. Phase 1's
 * test/error-recording/redactor.test.js already covers applyRedactor()'s
 * own unit-level contract (ordering, failure modes, capping); this file
 * is specifically about the WIRING — the one place Decision 3's
 * fingerprint isolation could actually break, since computeFingerprint()
 * and recordThrownException() are two independent call sites reading the
 * same `err` a few lines apart in the same catch block.
 */

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
  // The Decision 6 mode-mismatch warning (src/error-recording/config.js)
  // is a once-per-process flag by design — reset it per test here so
  // tests in this file that deliberately trigger it (mode !== 'normalized'
  // + a redactor) don't consume the one-time budget for each other.
  __resetRedactorNoOpWarnedForTests();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  memoryExporter.reset();
});

describe('errorRecording.redactor — ADR 020 (docs/adr/020-redactor-hook.md), v0.14.0 Phase 2', () => {
  describe('a working redactor', () => {
    it("reaches the span, and this library's own patterns still run over its output", async () => {
      const server = createServer();
      const redactor = ({ message, stack }) => ({
        message: message.replace('SECRET_TOKEN_XYZ', '[REDACTED]'),
        stack,
      });
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'failed for SECRET_TOKEN_XYZ, contact jane@example.com' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const message = exceptionEvent(span).attributes['exception.message'];
      // The redactor's own scrub (a shape our built-in patterns don't
      // know about) survived...
      expect(message).toContain('[REDACTED]');
      expect(message).not.toContain('SECRET_TOKEN_XYZ');
      // ...and normalizeMessage() still ran on the redactor's OUTPUT,
      // scrubbing the email our own patterns DO know about — proving the
      // redactor ran first, feeding this library's pipeline, not the
      // reverse (Decision 2).
      expect(message).toContain('<EMAIL>');
      expect(message).not.toContain('jane@example.com');
      expect(span.status.message).toBe(message);
    });

    it('redacts stack content too, in the same call', async () => {
      const server = createServer();
      const cwd = process.cwd();
      const redactor = ({ message, stack }) => ({
        message,
        stack: stack?.replace('acme-corp', '[TENANT]'),
      });
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({
          message: 'boom',
          stack: `Error: boom\n    at handleThing (${cwd}/customers/acme-corp/handler.js:42:7)`,
        });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const stacktrace = exceptionEvent(span).attributes['exception.stacktrace'];
      expect(stacktrace).toContain('[TENANT]');
      expect(stacktrace).not.toContain('acme-corp');
      expect(stacktrace).toContain('handleThing');
      expect(stacktrace).toContain('42');
    });

    it('is called exactly once per thrown error, not once per field', async () => {
      const server = createServer();
      const redactor = vi.fn(({ message, stack }) => ({ message, stack }));
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom', stack: 'Error: boom\n    at f (/x/y.js:1:1)' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      expect(redactor).toHaveBeenCalledTimes(1);
    });

    it('does not mutate the original thrown error object', async () => {
      const server = createServer();
      const redactor = ({ message, stack }) => ({ message: message.toUpperCase(), stack });
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      const originalMessage = 'user jane@example.com not found';
      let thrown;
      server.setRequestHandler(CallToolRequestSchema, async () => {
        thrown = buildError({ message: originalMessage });
        throw thrown;
      });

      const caught = await invokeToolCall(server, { name: 'echo', arguments: {} }).catch((e) => e);

      expect(caught).toBe(thrown);
      expect(thrown.message).toBe(originalMessage);
    });
  });

  describe('a throwing/misbehaving redactor (Decision 4)', () => {
    it('falls back to "none"-equivalent span state and warns once', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => {
        throw new Error('redactor bug');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      // 'none'-equivalent: no exception event, no status message — same
      // as errorRecording.mode: 'none' produces (see the sibling
      // instrument.error-recording.test.js suite's own assertions).
      expect(exceptionEvent(span)).toBeUndefined();
      expect(span.status.message).toBeUndefined();

      const failureWarnings = warnSpy.mock.calls.filter(([msg]) => /errorRecording redactor/.test(msg));
      expect(failureWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('a non-string message return also falls back to "none"-equivalent', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => ({ message: 42, stack: undefined });
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(exceptionEvent(span)).toBeUndefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(warnSpy.mock.calls.filter(([msg]) => /errorRecording redactor/.test(msg))).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('never falls back to raw/unredacted content — the original message never reaches the span', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => {
        throw new Error('boom');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'super-secret-content-should-never-appear-on-span' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const spanText = JSON.stringify(span.attributes) + JSON.stringify(span.status) + JSON.stringify(span.events);
      expect(spanText).not.toContain('super-secret-content-should-never-appear-on-span');
      warnSpy.mockRestore();
    });

    it('warns once per instrumentMcpServer() call, not once per failing call', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => {
        throw new Error('boom');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});
      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});
      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      expect(warnSpy.mock.calls.filter(([msg]) => /errorRecording redactor/.test(msg))).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('a fresh instrumentMcpServer() call gets its own warning budget', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const redactor = () => {
        throw new Error('boom');
      };

      const serverA = createServer('a');
      instrumentMcpServer(serverA, { serviceName: 'svc-a', errorRecording: { mode: 'normalized', redactor } });
      serverA.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });
      await invokeToolCall(serverA, { name: 'echo', arguments: {} }).catch(() => {});

      const serverB = createServer('b');
      instrumentMcpServer(serverB, { serviceName: 'svc-b', errorRecording: { mode: 'normalized', redactor } });
      serverB.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });
      await invokeToolCall(serverB, { name: 'echo', arguments: {} }).catch(() => {});

      expect(warnSpy.mock.calls.filter(([msg]) => /errorRecording redactor/.test(msg))).toHaveLength(2);
      warnSpy.mockRestore();
    });
  });

  describe('Decision 3 — computeFingerprint() is unaffected, through the public entry point', () => {
    it('mcp.failure.fingerprint is byte-identical with vs. without a redactor configured', async () => {
      const message = 'failed for user@example.com, id ACCT-123456789';
      const stack = 'Error: failed\n    at handler (/opt/customers/acme-corp/handler.js:42:9)';

      const withoutRedactor = createServer('without');
      instrumentMcpServer(withoutRedactor, { serviceName: 'svc', errorRecording: { mode: 'normalized' } });
      withoutRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message, stack });
      });
      await invokeToolCall(withoutRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWithout] = memoryExporter.getFinishedSpans();
      memoryExporter.reset();

      const withRedactor = createServer('with');
      const redactor = ({ message: m, stack: s }) => ({
        message: m.replace('user@example.com', '[USER]').replace('ACCT-123456789', '[ACCOUNT]'),
        stack: s?.replace('acme-corp', '[TENANT]'),
      });
      instrumentMcpServer(withRedactor, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      withRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message, stack });
      });
      await invokeToolCall(withRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWith] = memoryExporter.getFinishedSpans();

      // Sanity: the redactor really did change what landed on the span,
      // so a passing assertion below isn't vacuous.
      expect(exceptionEvent(spanWith).attributes['exception.message']).not.toBe(
        exceptionEvent(spanWithout).attributes['exception.message'],
      );
      expect(exceptionEvent(spanWith).attributes['exception.message']).toContain('[USER]');

      // The load-bearing assertion: the fingerprint itself never moved.
      expect(spanWith.attributes[ATTRIBUTE_KEYS.FINGERPRINT]).toBe(spanWithout.attributes[ATTRIBUTE_KEYS.FINGERPRINT]);

      // Cross-check against computeFingerprint() called directly on the
      // same content — confirms the span attribute reflects the real,
      // unredacted computation, not a coincidence of this test's inputs.
      const directFingerprint = computeFingerprint(buildError({ message, stack }), { toolName: 'echo', origin: 'thrown' });
      expect(spanWith.attributes[ATTRIBUTE_KEYS.FINGERPRINT]).toBe(directFingerprint.fingerprint);
    });

    it('a failing redactor still leaves the fingerprint intact, unaffected by the fallback', async () => {
      const message = 'boom for user@example.com';
      // Fixed, explicit stack (rather than relying on `new Error()`'s own
      // call-site capture) so the thrown error and the directly-computed
      // comparison fingerprint below are guaranteed byte-identical inputs,
      // not just "happen to share a message."
      const stack = 'Error: boom\n    at handler (/x/y.js:1:1)';
      const server = createServer();
      const redactor = () => {
        throw new Error('redactor bug');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message, stack });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      const directFingerprint = computeFingerprint(buildError({ message, stack }), { toolName: 'echo', origin: 'thrown' });
      expect(span.attributes[ATTRIBUTE_KEYS.FINGERPRINT]).toBe(directFingerprint.fingerprint);
    });
  });

  describe('"full" and "none" modes ignore the redactor entirely', () => {
    it('"full" mode is byte-identical with and without a redactor configured', async () => {
      const redactor = vi.fn(({ message, stack }) => ({ message: message.toUpperCase(), stack }));

      const withoutRedactor = createServer('without');
      instrumentMcpServer(withoutRedactor, { serviceName: 'svc', errorRecording: { mode: 'full' } });
      withoutRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });
      await invokeToolCall(withoutRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWithout] = memoryExporter.getFinishedSpans();
      memoryExporter.reset();

      const withRedactor = createServer('with');
      instrumentMcpServer(withRedactor, { serviceName: 'svc', errorRecording: { mode: 'full', redactor } });
      withRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'user jane@example.com not found' });
      });
      await invokeToolCall(withRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWith] = memoryExporter.getFinishedSpans();

      expect(redactor).not.toHaveBeenCalled();
      expect(spanWith.status.message).toBe(spanWithout.status.message);
      expect(spanWith.status.message).toBe('user jane@example.com not found');
      expect(exceptionEvent(spanWith).attributes['exception.message']).toBe(
        exceptionEvent(spanWithout).attributes['exception.message'],
      );
    });

    it('"none" mode is byte-identical with and without a redactor configured', async () => {
      const redactor = vi.fn(({ message, stack }) => ({ message: message.toUpperCase(), stack }));

      const withoutRedactor = createServer('without');
      instrumentMcpServer(withoutRedactor, { serviceName: 'svc', errorRecording: { mode: 'none' } });
      withoutRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });
      await invokeToolCall(withoutRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWithout] = memoryExporter.getFinishedSpans();
      memoryExporter.reset();

      const withRedactor = createServer('with');
      instrumentMcpServer(withRedactor, { serviceName: 'svc', errorRecording: { mode: 'none', redactor } });
      withRedactor.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });
      await invokeToolCall(withRedactor, { name: 'echo', arguments: {} }).catch(() => {});
      const [spanWith] = memoryExporter.getFinishedSpans();

      expect(redactor).not.toHaveBeenCalled();
      expect(spanWith.status.code).toBe(spanWithout.status.code);
      expect(spanWith.status.message).toBeUndefined();
      expect(spanWithout.status.message).toBeUndefined();
      expect(exceptionEvent(spanWith)).toBeUndefined();
      expect(exceptionEvent(spanWithout)).toBeUndefined();
    });
  });

  describe('applies to both thrown paths: tools/call AND tools/list', () => {
    it('a working redactor also runs on a thrown tools/list handler', async () => {
      const server = createServer();
      const redactor = ({ message, stack }) => ({ message: message.replace('SECRET', '[REDACTED]'), stack });
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'SECRET leaked' });
      });

      await invokeToolsList(server).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(exceptionEvent(span).attributes['exception.message']).toBe('[REDACTED] leaked');
    });

    it('a throwing redactor produces "none"-equivalent state on a thrown tools/list handler too', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => {
        throw new Error('boom');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolsList(server).catch(() => {});

      const [span] = memoryExporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(exceptionEvent(span)).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('the same errorRecordingState is shared across tools/call and tools/list — one warning budget per instrumentMcpServer() call', async () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => {
        throw new Error('boom');
      };
      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { mode: 'normalized', redactor } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw buildError({ message: 'boom' });
      });

      await invokeToolCall(server, { name: 'echo', arguments: {} }).catch(() => {});
      await invokeToolsList(server).catch(() => {});

      expect(warnSpy.mock.calls.filter(([msg]) => /errorRecording redactor/.test(msg))).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe('misconfiguration: redactor configured but mode is not "normalized" (Decision 6)', () => {
    it('warns once at instrumentMcpServer() setup time when mode defaults to "full"', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const server = createServer();
      const redactor = () => ({ message: 'x', stack: undefined });

      instrumentMcpServer(server, { serviceName: 'svc', errorRecording: { redactor } });

      expect(warnSpy.mock.calls.filter(([msg]) => /errorRecording\.redactor is configured/.test(msg))).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });
});
