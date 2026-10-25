import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from '../src/fingerprint/normalize/secrets.js';
import { normalizeMessage } from '../src/fingerprint/normalize/message.js';
import { computeFingerprint } from '../src/fingerprint/compose.js';
import { classifyFailureChannel } from '../src/fingerprint/classify/channel.js';
import { toSpanAttributes, ATTRIBUTE_KEYS } from '../src/fingerprint/attributes.js';
import { CONFORMANCE_DIR, buildPatterns, buildAll, serialize, recordedException } from '../scripts/gen-conformance.mjs';

/**
 * ADR 028 Decision 6: the language-neutral fixtures in <repo>/conformance are
 * generated from this package and asserted here against the unmodified core.
 * The Python port asserts the same files. A failure means core's behavior or
 * a regex changed: regenerate with `node packages/core/scripts/gen-conformance.mjs`
 * and bring the Python port along.
 */
function load(rel) {
  return JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, rel), 'utf8'));
}

const jsCases = (file) => load(file).cases.filter((c) => c.languages.includes('js'));

describe('conformance fixtures (ADR 028)', () => {
  it('normalize.json', () => {
    const cases = jsCases('cases/normalize.json');
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      expect(scrubSecrets(c.input.raw), c.id).toBe(c.expect.scrubbed);
      expect(normalizeMessage(c.input.raw), c.id).toBe(c.expect.normalizedMessage);
    }
  });

  it('tool-error.json', () => {
    const cases = jsCases('cases/tool-error.json');
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      const fp = computeFingerprint(c.input.result, c.ctx);
      const channel = classifyFailureChannel(c.input.result);
      expect(fp.fingerprint, c.id).toBe(c.expect.fingerprint);
      expect(fp.signature, c.id).toBe(c.expect.signature);
      expect(fp.category, c.id).toBe(c.expect.category);
      expect(fp.origin, c.id).toBe(c.expect.origin);
      expect(fp.inputs.errorClass, c.id).toBe(c.expect.errorClass);
      expect(fp.inputs.normalizedMessage, c.id).toBe(c.expect.normalizedMessage);
      expect(fp.inputs.stackSignature, c.id).toBe(c.expect.stackSignature);
      expect(channel, c.id).toBe(c.expect.channel);
      expect({ ...toSpanAttributes(fp), [ATTRIBUTE_KEYS.CHANNEL]: channel }, c.id).toEqual(c.expect.attributes);
    }
  });

  it('channel.json', () => {
    for (const c of jsCases('cases/channel.json')) {
      expect(classifyFailureChannel(c.input.failure), c.id).toBe(c.expect.channel);
    }
  });

  it('classify.json', () => {
    for (const c of jsCases('cases/classify.json')) {
      const fp = computeFingerprint(c.input.error, c.ctx);
      expect(fp.fingerprint, c.id).toBe(c.expect.fingerprint);
      expect(fp.signature, c.id).toBe(c.expect.signature);
      expect(fp.category, c.id).toBe(c.expect.category);
      expect(fp.inputs.errorClass, c.id).toBe(c.expect.errorClass);
      expect(fp.inputs.normalizedMessage, c.id).toBe(c.expect.normalizedMessage);
      expect(classifyFailureChannel(c.input.error), c.id).toBe(c.expect.channel);
    }
  });

  it('error-recording.json', async () => {
    for (const c of jsCases('cases/error-recording.json')) {
      const { mode, error } = c.input;
      const r = await recordedException(mode, {
        name: error.name ?? undefined,
        message: error.message,
        stack: error.stack ?? undefined,
        code: error.code ?? undefined,
      });
      const ea = r.eventAttributes;
      const actual = {
        errorType: r.errorType,
        status: r.statusCode,
        statusMessage: r.statusMessage,
        event: ea
          ? {
              type: ea['exception.type'] ?? null,
              message: ea['exception.message'] ?? null,
              ...(mode === 'full' ? { stacktrace: ea['exception.stacktrace'] ?? null } : {}),
            }
          : null,
      };
      expect(actual, c.id).toEqual(c.expect);
    }
  });

  it('patterns.json matches the live regex tables (a regex edit must be regenerated)', () => {
    expect(buildPatterns()).toEqual(load('patterns.json'));
  });

  it('every committed fixture file is up to date with core', async () => {
    const files = await buildAll();
    for (const [rel, obj] of Object.entries(files)) {
      expect(serialize(obj), rel).toBe(readFileSync(path.join(CONFORMANCE_DIR, rel), 'utf8'));
    }
  });
});
