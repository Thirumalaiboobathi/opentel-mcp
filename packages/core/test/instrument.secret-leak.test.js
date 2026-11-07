import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { resolveSecretLeakConfig, scanResultForSecrets, DEFAULT_MAX_SCAN_BYTES } from '../src/secret-leak.js';
import { detectSecretTypes, scrubSecrets, SECRET_STEPS, SECRET_TYPES, MAX_DETECTED_MATCHES } from '../src/fingerprint/normalize/secrets.js';
import { SHAPES, createHarness, lastToolSpan } from './helpers/security-harness.js';

/** ADR 030. Every secret below is assembled at runtime so no scanner flags this file. */

const AWS = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const JWT = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.dummysignature', 'abc123'].join('');
const BEARER = 'Bearer ' + 'abcdefghijklmnop'.repeat(2);
const PROVIDER = 'sk-' + 'a1b2c3d4e5'.repeat(3);
const URL_CRED = 'https://' + 'user' + ':' + 'hunter22' + '@example.com/x';
const ASSIGN = 'pass' + 'word=' + 'hunter22xyz';
const text = (t) => ({ content: [{ type: 'text', text: t }] });

describe('detectSecretTypes / SECRET_STEPS types', () => {
  it('every step has a type from the closed set, and scrubbing is unchanged by it', () => {
    for (const step of SECRET_STEPS) expect(SECRET_TYPES).toContain(step.type);
    expect(scrubSecrets(`x ${AWS} y`)).toBe('x <SECRET> y');
  });

  it.each([
    ['url_credentials', URL_CRED],
    ['jwt', JWT],
    ['http_auth_credential', BEARER],
    ['aws_access_key_id', AWS],
    ['provider_api_key', PROVIDER],
    ['secret_assignment', ASSIGN],
  ])('detects %s', (type, sample) => {
    const found = detectSecretTypes(`before ${sample} after`);
    expect(found.types.has(type)).toBe(true);
    expect(found.count).toBeGreaterThanOrEqual(1);
  });

  it('plain text, UUIDs and hashes are not flagged', () => {
    const benign = 'The quick brown fox 123e4567-e89b-12d3-a456-426614174000 sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 token expired';
    expect(detectSecretTypes(benign)).toEqual({ types: new Set(), count: 0 });
  });

  it('does not disturb the shared global patterns (lastIndex stays 0)', () => {
    detectSecretTypes(`${AWS} ${AWS}`);
    for (const { pattern } of SECRET_STEPS) expect(pattern.lastIndex).toBe(0);
  });

  it('caps the count', () => {
    const many = `${AWS} `.repeat(MAX_DETECTED_MATCHES + 500);
    expect(detectSecretTypes(many).count).toBe(MAX_DETECTED_MATCHES);
  });

  it('returns only type names: no matched text anywhere in the result', () => {
    const found = detectSecretTypes(`x ${AWS} ${PROVIDER} ${JWT}`);
    const dump = JSON.stringify([...found.types]) + found.count;
    for (const s of [AWS, PROVIDER, JWT]) expect(dump).not.toContain(s);
  });
});

describe('resolveSecretLeakConfig', () => {
  let warn;
  beforeEach(() => {
    warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  });
  afterEach(() => diag.disable());

  it('defaults: off, 65536, no warning', () => {
    expect(resolveSecretLeakConfig(undefined)).toEqual({ enabled: false, maxScanBytes: DEFAULT_MAX_SCAN_BYTES });
    expect(warn).not.toHaveBeenCalled();
  });

  it('valid values are used', () => {
    expect(resolveSecretLeakConfig({ enabled: true, maxScanBytes: 100 })).toEqual({ enabled: true, maxScanBytes: 100 });
  });

  it.each([-1, 0, 1.5, Number.NaN, Infinity, '100', null])('maxScanBytes %j: one warning, default used', (bad) => {
    const c = resolveSecretLeakConfig({ enabled: true, maxScanBytes: bad });
    expect(c).toEqual({ enabled: true, maxScanBytes: DEFAULT_MAX_SCAN_BYTES });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['yes', 1, null, [], 'true'])('non-object value %j never enables and warns once', (bad) => {
    expect(resolveSecretLeakConfig(bad).enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('enabled: "yes" inside an object warns and stays off', () => {
    expect(resolveSecretLeakConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a throwing getter degrades to off without throwing', () => {
    const hostile = {
      get enabled() {
        throw new Error('boom');
      },
    };
    expect(resolveSecretLeakConfig(hostile).enabled).toBe(false);
  });
});

describe('scanResultForSecrets', () => {
  it('only scans text items; images, resources and structuredContent are ignored', () => {
    const r = {
      content: [
        { type: 'image', data: AWS, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'x://y', text: AWS } },
        { type: 'text', text: 'nothing here' },
      ],
      structuredContent: { k: AWS },
    };
    expect(scanResultForSecrets(r, 65536)).toEqual({ types: new Set(), count: 0, truncated: false });
  });

  it('scans every text item and merges types', () => {
    const r = { content: [{ type: 'text', text: AWS }, { type: 'text', text: JWT }] };
    const s = scanResultForSecrets(r, 65536);
    expect([...s.types].sort()).toEqual(['aws_access_key_id', 'jwt']);
  });

  it('returns null for results with no content array', () => {
    for (const r of [undefined, null, {}, { content: 'x' }, 5]) expect(scanResultForSecrets(r, 100)).toBeNull();
  });

  it('truncates at the budget instead of rejecting: a secret past the cap is not seen, scan_truncated is true', () => {
    const r = text('x'.repeat(999) + ' ' + AWS);
    const s = scanResultForSecrets(r, 1000);
    expect(s.truncated).toBe(true);
    expect(s.types.size).toBe(0);
    const whole = scanResultForSecrets(r, 2000);
    expect(whole.truncated).toBe(false);
    expect(whole.types.has('aws_access_key_id')).toBe(true);
  });

  it('the budget is shared across items: a later item is skipped once it is spent', () => {
    const r = { content: [{ type: 'text', text: 'y'.repeat(50) }, { type: 'text', text: AWS }] };
    const s = scanResultForSecrets(r, 50);
    expect(s.truncated).toBe(true);
    expect(s.types.size).toBe(0);
  });

  it('a secret straddling an internal window boundary is still found (windows overlap)', () => {
    const r = text('a '.repeat(2040) + AWS + ' tail');
    expect(scanResultForSecrets(r, 65536).types.has('aws_access_key_id')).toBe(true);
  });

  it('hostile shapes never throw: throwing getters, cyclic items, 100k empty strings, sparse arrays', () => {
    const getter = { get content() { throw new Error('boom'); } };
    expect(scanResultForSecrets(getter, 100)).toBeNull();
    const item = { type: 'text' };
    Object.defineProperty(item, 'text', { get() { throw new Error('boom'); } });
    expect(scanResultForSecrets({ content: [item, { type: 'text', text: AWS }] }, 100)).toBeNull();
    const cyc = { type: 'text', text: 'ok' };
    cyc.self = cyc;
    expect(scanResultForSecrets({ content: [cyc] }, 100)).toEqual({ types: new Set(), count: 0, truncated: false });
    const empties = { content: Array.from({ length: 100_000 }, () => ({ type: 'text', text: '' })) };
    expect(scanResultForSecrets(empties, 100).truncated).toBe(true);
    expect(scanResultForSecrets({ content: new Array(50) }, 100)).toEqual({ types: new Set(), count: 0, truncated: false });
  });
});

describe('performance at the cap', () => {
  it('a 64 KiB benign result is scanned in a small fraction of a second', () => {
    const r = text('lorem ipsum dolor sit amet '.repeat(3000).slice(0, DEFAULT_MAX_SCAN_BYTES));
    const t0 = performance.now();
    scanResultForSecrets(r, DEFAULT_MAX_SCAN_BYTES);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('adversarial 64 KiB inputs stay bounded: windowing keeps each superlinear pattern from running over the whole text', () => {
    const inputs = ['eyJaaaaa.'.repeat(8000), 'sk-'.repeat(25000), 'a://a:'.repeat(12000), 'password: '.repeat(7000), 'Bearer '.repeat(10000)];
    for (const input of inputs) {
      const t0 = performance.now();
      scanResultForSecrets(text(input), DEFAULT_MAX_SCAN_BYTES);
      expect(performance.now() - t0, `input starting ${input.slice(0, 12)}`).toBeLessThan(2_000);
    }
  });

  it('a result far above the cap completes (truncated, not rejected) and costs no more than the capped scan', () => {
    const huge = text('z'.repeat(20_000_000));
    const t0 = performance.now();
    const s = scanResultForSecrets(huge, DEFAULT_MAX_SCAN_BYTES);
    expect(s.truncated).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('secret leak detection on real spans', () => {
  let h;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.teardown());

  const ON = { secretLeakDetection: { enabled: true } };
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('successful result: attributes set, status stays OK, counter +1 labelled by tool only', async () => {
        const t = shape.build(ON, () => text(`key is ${AWS}`));
        await t.call();
        const span = lastToolSpan(h);
        expect(span.attributes['mcp.tool.secret_leak.detected']).toBe(true);
        expect(span.attributes['mcp.tool.secret_leak.types']).toEqual(['aws_access_key_id']);
        expect(span.attributes['mcp.tool.secret_leak.count']).toBe(1);
        expect('mcp.tool.secret_leak.scan_truncated' in span.attributes).toBe(false);
        expect(span.status.code).toBe(1); // OK, not ERROR
        const pts = await h.points('mcp.tool.secret_leaks');
        expect(pts).toHaveLength(1);
        expect(pts[0].value).toBe(1);
        expect(pts[0].attributes).toEqual({ 'gen_ai.tool.name': 'get_quote' });
      });

      it('isError result: detected too, and the ERROR status is untouched', async () => {
        const t = shape.build(ON, () => ({ isError: true, content: [{ type: 'text', text: `upstream said ${BEARER}` }] }));
        await t.call();
        const span = lastToolSpan(h);
        expect(span.attributes['mcp.tool.secret_leak.types']).toEqual(['http_auth_credential']);
        expect(span.status.code).toBe(2); // ERROR
        expect(span.attributes['error.type']).toBe('tool_error');
      });

      it('a clean result: no attributes, no counter', async () => {
        const t = shape.build(ON, () => text('all good'));
        await t.call();
        const attrs = lastToolSpan(h).attributes;
        expect(Object.keys(attrs).some((k) => k.startsWith('mcp.tool.secret_leak'))).toBe(false);
        expect(await h.points('mcp.tool.secret_leaks')).toEqual([]);
      });

      it('default off: a leaking result produces spans identical to 0.17 (no secret_leak attributes, no counter)', async () => {
        const t = shape.build({}, () => text(`key is ${AWS}`));
        await t.call();
        const attrs = lastToolSpan(h).attributes;
        expect(Object.keys(attrs).some((k) => k.startsWith('mcp.tool.secret_leak'))).toBe(false);
        expect(await h.points('mcp.tool.secret_leaks')).toEqual([]);
      });
    });
  }

  it('scan_truncated appears only when the cap cut the scan short', async () => {
    const t = SHAPES[2].build({ secretLeakDetection: { enabled: true, maxScanBytes: 100 } }, () => text('x'.repeat(500) + ' ' + AWS));
    await t.call();
    const attrs = lastToolSpan(h).attributes;
    expect(attrs['mcp.tool.secret_leak.scan_truncated']).toBe(true);
    expect('mcp.tool.secret_leak.detected' in attrs).toBe(false);
  });

  it('multiple types are sorted and deduplicated', async () => {
    const t = SHAPES[2].build(ON, () => text(`${JWT} ${AWS} ${AWS} ${ASSIGN}`));
    await t.call();
    expect(lastToolSpan(h).attributes['mcp.tool.secret_leak.types']).toEqual(['aws_access_key_id', 'jwt', 'secret_assignment']);
  });

  it('metrics disabled: attributes still set, no counter, no throw', async () => {
    const t = SHAPES[2].build({ ...ON, enableMetrics: false }, () => text(AWS));
    await expect(t.call()).resolves.toBeDefined();
    expect(lastToolSpan(h).attributes['mcp.tool.secret_leak.detected']).toBe(true);
  });

  it('canary: no matched secret, position or surrounding text reaches spans, events, metrics or logs', async () => {
    const SURROUND = 'CANARY-AROUND-5e7f';
    const secrets = [AWS, JWT, BEARER, PROVIDER, URL_CRED, ASSIGN];
    const t = SHAPES[2].build(ON, () => ({
      isError: true,
      content: [{ type: 'text', text: `${SURROUND} ${secrets.join(` ${SURROUND} `)} ${SURROUND}` }],
    }));
    await t.call('get_quote', { arg: SURROUND });
    const dump =
      JSON.stringify(h.spans().map((s) => [s.name, s.attributes, s.events, s.status, s.links])) +
      JSON.stringify(await h.allMetrics()) +
      h.diagLines.join('\n');
    for (const needle of [SURROUND, ...secrets, 'hunter22', 'abcdefghijklmnop', 'a1b2c3d4e5']) {
      expect(dump, `leaked ${needle.slice(0, 8)}…`).not.toContain(needle);
    }
  });
});
