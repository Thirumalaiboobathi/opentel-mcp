import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server as V1Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as V2Server } from '@modelcontextprotocol/server';
import { instrumentMcpServer, MAX_FULL_EXCEPTION_MESSAGE_LENGTH, MAX_FULL_EXCEPTION_STACK_LENGTH } from '../src/instrument.js';
import { scrubSecrets, SECRET_PLACEHOLDER } from '../src/fingerprint/normalize/secrets.js';
import { normalizeMessage } from '../src/fingerprint/normalize/message.js';
import { computeFingerprint } from '../src/fingerprint/compose.js';

/**
 * v0.17.0 security hardening, items B1 (exception content in 'full' mode)
 * and B2 (credential formats the scrubber missed).
 *
 * Every credential here is fake AND assembled at runtime: prefixes are
 * split ('gh' + 'p_') and bodies come from fakeSecret(), so no
 * secret-shaped string appears contiguously in this file. Secret scanners
 * (GitHub push protection included) flag such strings whether or not
 * they're real.
 */

const ALNUM = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY';
const UPPER_DIGITS = 'Q7XK2M9WZ4RT6PLV8NBC';

/** `prefix` followed by `length` deterministic filler characters from `alphabet`. */
function fakeSecret(prefix, length, alphabet = ALNUM) {
  return prefix + alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}

const F = {
  bearer: fakeSecret('', 27),
  bearerLower: fakeSecret('', 21),
  basic: fakeSecret('', 26),
  akia: fakeSecret('AK' + 'IA', 16, UPPER_DIGITS),
  asia: fakeSecret('AS' + 'IA', 16, UPPER_DIGITS),
  awsSecret: fakeSecret('', 40),
  sk: fakeSecret('s' + 'k-', 32),
  skProj: fakeSecret('', 30),
  skAnt: fakeSecret('', 24),
  stripe: fakeSecret('', 24),
  ghp: fakeSecret('gh' + 'p_', 36),
  githubPat: fakeSecret('', 32),
  slackB: fakeSecret('', 24),
  slackP: fakeSecret('', 10),
  google: fakeSecret('AI' + 'za', 35),
  jwtSig: fakeSecret('', 43),
  urlPw: 'hunter' + '2pw',
  urlPwStack: 's3cr3t' + 'pw',
  queryToken: fakeSecret('tok_', 12),
  queryApiKey: fakeSecret('', 12),
  accessToken: fakeSecret('ya' + '29.', 10),
  password: 'hunter' + '2',
  clientSecret: 'sh-very-' + 'secret-value',
  colonSecret: 'hunter' + '2x9',
};

// [label, text, the raw secret that must not survive]
const SECRETS = [
  ['Bearer token', `request failed: Authorization: Bearer ${F.bearer}`, F.bearer],
  ['lower-case bearer', `auth header was bearer ${F.bearerLower}`, F.bearerLower],
  ['Basic auth', `proxy rejected Basic ${F.basic}==`, F.basic],
  ['AWS access key id', `AccessDenied for key ${F.akia} in us-east-1`, F.akia],
  ['AWS temporary key id', `expired session key ${F.asia}`, F.asia],
  ['AWS secret assignment', `aws_secret_access_key=${F.awsSecret}`, F.awsSecret],
  ['OpenAI sk-', `invalid key ${F.sk}`, F.sk],
  ['OpenAI sk-proj-', `invalid key ${'s' + 'k-proj-'}${F.skProj}`, F.skProj],
  ['Anthropic sk-ant-', `bad key ${'s' + 'k-ant-api03-'}${F.skAnt}-${fakeSecret('', 9)}`, F.skAnt],
  ['Stripe', `stripe: ${'s' + 'k_live_'}${F.stripe}`, F.stripe],
  ['GitHub ghp_', `GitHub said 401 for ${F.ghp}`, F.ghp],
  ['GitHub fine-grained', `${'github' + '_pat_'}11${fakeSecret('', 20, UPPER_DIGITS)}_${F.githubPat} rejected`, F.githubPat],
  ['Slack xoxb-', `slack token ${'xo' + 'xb-'}123456789012-1234567890123-${F.slackB} rejected`, F.slackB],
  ['Slack xoxp-', `${'xo' + 'xp-'}2222222222-3333333333-${F.slackP} expired`, F.slackP],
  ['Google API key', `key ${F.google} invalid`, F.google],
  ['JWT', `jwt expired: ${['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxIn0', F.jwtSig].join('.')}`, F.jwtSig],
  ['URL credentials', `connect ECONNREFUSED postgres://admin:${F.urlPw}@db.internal:5432/app`, F.urlPw],
  ['URL credentials in a stack frame', `at fetch (https://user:${F.urlPwStack}@api.example.com/v1/x)`, F.urlPwStack],
  ['?token= query param', `GET /v1/items?id=42&token=${F.queryToken}&page=2 failed`, F.queryToken],
  ['?api_key= query param', `GET /search?q=cats&api_key=${F.queryApiKey} failed`, F.queryApiKey],
  ['&access_token= query param', `GET /me?access_token=${F.accessToken}&x=1`, F.accessToken],
  ['password= assignment', `config error: password=${F.password} is not valid`, F.password],
  ['quoted JSON secret', `${JSON.stringify({ client_secret: F.clientSecret })} rejected`, F.clientSecret],
  ['secret: value with a digit', `secret: ${F.colonSecret} rejected`, F.colonSecret],
];

// Ordinary text that must come through untouched. The two sk--containing
// lines are split only so the source has no sk--shaped run.
const NOT_SECRETS = [
  'Bearer token missing',
  'token expired',
  'invalid password',
  'password: required',
  'secret santa',
  'tokenizer=bpe failed',
  'user 550e8400-e29b-41d4-a716-446655440000 not found',
  'commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
  'ta' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz failed',
  'see https://example.com/docs?page=2&sort=asc',
  'contact admin@example.com',
  'auth: permission denied',
  'sig mismatch',
  'Basic validation failed',
  "Cannot read properties of undefined (reading 'token')",
  'expected api_key to be a string',
  'a' + 'sk-' + 'me-anything-thread-123456789012 not found',
  'at Object.<anonymous> (/srv/app/tools/search.js:42:13)',
];

describe('scrubSecrets (B2)', () => {
  it.each(SECRETS)('%s is replaced', (_label, text, secret) => {
    const out = scrubSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(SECRET_PLACEHOLDER);
  });

  it.each(NOT_SECRETS)('leaves ordinary text alone: %s', (text) => {
    expect(scrubSecrets(text)).toBe(text);
  });

  it('keeps the context around a secret readable', () => {
    expect(scrubSecrets(`GET /v1/items?id=42&token=${'abc' + '123def'}&page=2 failed`)).toBe('GET /v1/items?id=42&token=<SECRET>&page=2 failed');
    expect(scrubSecrets(`connect postgres://admin:${'pw' + '123'}@db:5432/app`)).toBe('connect postgres://<SECRET>@db:5432/app');
  });

  it('normalizeMessage (normalized mode, fingerprinting) scrubs every format too', () => {
    for (const [, text, secret] of SECRETS) expect(normalizeMessage(text)).not.toContain(secret);
  });

  it('two errors differing only by their leaked token now share a fingerprint', () => {
    // One call site, so the stack signature is identical and only the token differs.
    const [a, b] = ['aaaaaaaaaaaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbbbbbbbbbbb2'].map((token) =>
      computeFingerprint(new Error(`auth failed with Bearer ${token}`), { origin: 'thrown' }),
    );
    expect(a.inputs.normalizedMessage).toBe('auth failed with Bearer <SECRET>');
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("errorRecording 'full' mode: credentials scrubbed, lengths capped (B1)", () => {
  let exporter;
  let provider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register({ contextManager: null, propagator: null });
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  async function throwFrom(err, options = {}, sdk = 'v1') {
    const server =
      sdk === 'v1'
        ? new V1Server({ name: 't', version: '0' }, { capabilities: { tools: {} } })
        : new V2Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    instrumentMcpServer(server, options);
    const handler = async () => {
      throw err;
    };
    if (sdk === 'v1') server.setRequestHandler(CallToolRequestSchema, handler);
    else server.setRequestHandler('tools/call', handler);
    const ctx =
      sdk === 'v1'
        ? { requestId: 1 }
        : {
            mcpReq: { id: 1, method: 'tools/call', signal: new AbortController().signal, requestState: () => undefined, send: async () => {}, notify: async () => {} },
          };
    await server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name: 't', arguments: {} } }, ctx).catch(() => {});
    const span = exporter.getFinishedSpans().at(-1);
    const event = span.events.find((e) => e.name === 'exception');
    return { span, event };
  }

  const leaky = () => {
    const err = new Error(
      `upstream 401 for user 550e8400-e29b-41d4-a716-446655440000 at https://admin:${F.urlPw}@api.example.com/v1 with Bearer ${F.bearer}`,
    );
    err.stack = `${err.message}\n    at callUpstream (/srv/app/tools/upstream.js:42:13)\n    at handler (/srv/app/node_modules/sdk@1.2.3/index.js:7:1)`;
    return err;
  };

  for (const sdk of ['v1', 'v2']) {
    it(`${sdk}: message, stack and status are scrubbed; ids, paths and line numbers are kept`, async () => {
      const { span, event } = await throwFrom(leaky(), {}, sdk);
      const msg = event.attributes['exception.message'];
      const stack = event.attributes['exception.stacktrace'];
      for (const text of [msg, stack, span.status.message]) {
        expect(text).not.toContain(F.urlPw);
        expect(text).not.toContain(F.bearer);
        expect(text).toContain('<SECRET>');
      }
      // 'full' stays more detailed than 'normalized': these survive.
      expect(msg).toContain('550e8400-e29b-41d4-a716-446655440000');
      expect(msg).toContain('api.example.com/v1');
      expect(stack).toContain('/srv/app/tools/upstream.js:42:13');
      expect(event.attributes['exception.type']).toBe('Error');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });
  }

  it("'normalized' mode is still the less detailed one", async () => {
    const { event } = await throwFrom(leaky(), { errorRecording: { mode: 'normalized' } });
    const msg = event.attributes['exception.message'];
    expect(msg).not.toContain(F.urlPw);
    expect(msg).not.toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('an ordinary error is recorded exactly as before', async () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'id')");
    const { span, event } = await throwFrom(err);
    expect(event.attributes['exception.message']).toBe(err.message);
    expect(event.attributes['exception.stacktrace']).toBe(err.stack);
    expect(event.attributes['exception.type']).toBe('TypeError');
    expect(span.status.message).toBe(err.message);
  });

  it('caps a huge message and stack, with a visible marker', async () => {
    const err = new Error('x'.repeat(100_000));
    err.stack = `Error: ${'y'.repeat(100_000)}`;
    const { span, event } = await throwFrom(err);
    const msg = event.attributes['exception.message'];
    const stack = event.attributes['exception.stacktrace'];
    expect(msg.length).toBeLessThan(MAX_FULL_EXCEPTION_MESSAGE_LENGTH + 40);
    expect(msg).toMatch(/…\[truncated by opentel-mcp\]$/);
    expect(stack.length).toBeLessThan(MAX_FULL_EXCEPTION_STACK_LENGTH + 40);
    expect(span.status.message).toBe(msg);
  });

  it('caps exception.type from err.code like err.name', async () => {
    const err = new Error('boom');
    err.code = 'E'.repeat(1_000);
    const { event } = await throwFrom(err);
    expect(event.attributes['exception.type'].length).toBe(128);
  });

  it('a thrown string is scrubbed too', async () => {
    const { event } = await throwFrom(`failed with api_key=${F.queryApiKey}`);
    expect(event.attributes['exception.message']).toBe('failed with api_key=<SECRET>');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an empty object', {}],
    ['an object with a throwing getter', Object.defineProperty({}, 'message', { get: () => { throw new Error('getter'); } })],
  ])('never throws for %s', async (_label, value) => {
    const { span } = await throwFrom(value);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('tools/list errors get the same treatment', async () => {
    const server = new V1Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    instrumentMcpServer(server, { schemaDrift: { enabled: true } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      throw new Error(`registry fetch failed: https://ci:${'tok3n' + 'value'}@registry.example.com`);
    });
    await server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} }, { requestId: 1 }).catch(() => {});
    const event = exporter.getFinishedSpans().at(-1).events.find((e) => e.name === 'exception');
    expect(event.attributes['exception.message']).toBe('registry fetch failed: https://<SECRET>@registry.example.com');
  });
});
