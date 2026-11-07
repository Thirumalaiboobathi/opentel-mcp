import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computeToolDefinitionHash } from '../src/tool-integrity/hash.js';
import { ToolIntegrityTracker } from '../src/tool-integrity/tracker.js';
import { detectSecretTypes } from '../src/fingerprint/normalize/secrets.js';
import { scanResultForSecrets } from '../src/secret-leak.js';
import { compileSensitiveTools } from '../src/sensitive-tools.js';
import { CONFORMANCE_DIR } from '../scripts/gen-conformance.mjs';
import { SHAPES, createHarness } from './helpers/security-harness.js';

/**
 * Shared fixtures for the v0.18 security signals (contract version 2, ADR 034 amendment). The Python port asserts
 * the same files, so a failure here means core changed: regenerate with gen-conformance.mjs and tell the port.
 */
const load = (rel) => JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, rel), 'utf8'));
const jsCases = (rel) => load(rel).cases.filter((c) => c.languages.includes('js'));

describe('security conformance fixtures (ADR 034 amendment)', () => {
  it('tool-hash.json', () => {
    const cases = jsCases('cases/tool-hash.json');
    expect(cases.length).toBeGreaterThan(80);
    for (const c of cases) {
      expect({ hash: computeToolDefinitionHash(JSON.parse(c.input.definitionJson)) }, c.id).toEqual(c.expect);
    }
  });

  it('secret-types.json', () => {
    const cases = jsCases('cases/secret-types.json');
    expect(cases.length).toBeGreaterThan(40);
    for (const c of cases) {
      const found = detectSecretTypes(c.input.text);
      expect({ types: [...found.types].sort(), count: found.count }, c.id).toEqual(c.expect);
    }
  });

  it('secret-scan.json', () => {
    const cases = jsCases('cases/secret-scan.json');
    expect(cases.length).toBeGreaterThan(40);
    for (const c of cases) {
      const scan = scanResultForSecrets(c.input.result, c.input.maxScanBytes);
      const actual = scan === null ? { scan: null } : { scan: { types: [...scan.types].sort(), count: scan.count, truncated: scan.truncated } };
      expect(actual, c.id).toEqual(c.expect);
    }
  });

  it('sensitive-tools.json', () => {
    const cases = jsCases('cases/sensitive-tools.json');
    expect(cases.length).toBeGreaterThan(30);
    for (const c of cases) {
      const m = compileSensitiveTools(c.input.patterns);
      expect({ size: m === null ? 0 : m.size, matches: c.input.names.map((n) => (m === null ? false : m.matches(n))) }, c.id).toEqual(c.expect);
    }
  });

  it('integrity-tracker.json', () => {
    const cases = jsCases('cases/integrity-tracker.json');
    expect(cases.length).toBeGreaterThan(25);
    for (const c of cases) {
      const tracker = new ToolIntegrityTracker(new Map(Object.entries(c.input.pins)));
      const steps = c.input.steps.map((s) => {
        const o = tracker.observe(s.tools, s.complete);
        return JSON.parse(JSON.stringify({ findings: o.findings, violationTools: o.violationTools, firstSnapshot: o.firstSnapshot }));
      });
      expect({ steps, hashes: tracker.getHashes() }, c.id).toEqual(c.expect);
    }
  });

  describe('auth.json (through a really instrumented server)', () => {
    let h;
    beforeEach(() => {
      h = createHarness();
    });
    afterEach(() => h.teardown());

    it('increments mcp.tool.auth_failures exactly when the fixture says so', async () => {
      const cases = jsCases('cases/auth.json');
      expect(cases.length).toBeGreaterThan(40);
      for (const c of cases) {
        const handler = () => {
          if (c.input.kind === 'result') return c.input.result;
          const e = c.input.error;
          throw Object.assign(new Error(e.message), { name: e.name, ...(e.code !== undefined ? { code: e.code } : {}), ...(e.status !== undefined ? { status: e.status } : {}), ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}) });
        };
        const t = SHAPES[2].build(c.input.options.fingerprinting === false ? { fingerprinting: false } : {}, handler);
        const before = (await h.points('mcp.tool.auth_failures')).reduce((n, p) => n + p.value, 0);
        await t.call().catch(() => {});
        const after = (await h.points('mcp.tool.auth_failures')).reduce((n, p) => n + p.value, 0);
        expect(after - before, c.id).toBe(c.expect.increments ? 1 : 0);
      }
    });
  });
});
