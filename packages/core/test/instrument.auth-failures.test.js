import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SHAPES, createHarness } from './helpers/security-harness.js';

/** ADR 031: mcp.tool.auth_failures. */

const AUTH = 'auth';
const throwsAuth = () => {
  throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
};
const authIsError = () => ({ isError: true, content: [{ type: 'text', text: 'Access denied for this resource' }] });
const otherIsError = () => ({ isError: true, content: [{ type: 'text', text: 'something else went wrong' }] });

describe('mcp.tool.auth_failures (ADR 031)', () => {
  let h;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.teardown());

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('counts a silent (isError) auth failure, labelled by tool name only', async () => {
        const t = shape.build({}, authIsError);
        await t.call();
        const pts = await h.points('mcp.tool.auth_failures');
        expect(pts).toHaveLength(1);
        expect(pts[0].value).toBe(1);
        expect(pts[0].attributes).toEqual({ 'gen_ai.tool.name': 'get_quote' });
      });

      it('counts a thrown auth failure', async () => {
        const t = shape.build({}, throwsAuth);
        await t.call().catch(() => {});
        const span = h.spans().at(-1);
        // McpServer shapes convert a throwing callback into an isError result; either way it is an auth failure.
        expect(span.attributes['mcp.failure.category']).toBe(AUTH);
        const pts = await h.points('mcp.tool.auth_failures');
        expect(pts.map((p) => p.value)).toEqual([1]);
      });

      it('does not count other failures or successes', async () => {
        const t = shape.build({}, otherIsError);
        await t.call();
        const ok = shape.build({}, () => ({ content: [{ type: 'text', text: 'fine' }] }));
        await ok.call();
        expect(await h.points('mcp.tool.auth_failures')).toEqual([]);
      });

      it('accumulates per call', async () => {
        const t = shape.build({}, authIsError);
        await t.call();
        await t.call();
        await t.call();
        const pts = await h.points('mcp.tool.auth_failures');
        expect(pts.map((p) => p.value)).toEqual([3]);
      });
    });
  }

  it('is silent when fingerprinting is off (the category is never computed): documented limit', async () => {
    const t = SHAPES[2].build({ fingerprinting: false }, authIsError);
    await t.call();
    expect(await h.points('mcp.tool.auth_failures')).toEqual([]);
  });

  it('is silent when metrics are disabled, and never throws', async () => {
    const t = SHAPES[2].build({ enableMetrics: false }, authIsError);
    await expect(t.call()).resolves.toBeDefined();
    expect(await h.points('mcp.tool.auth_failures')).toEqual([]);
  });

  it('no argument, result or error text reaches the metric labels or diag', async () => {
    const CANARY = 'CANARY-AUTH-7f3a';
    const t = SHAPES[2].build({}, () => ({ isError: true, content: [{ type: 'text', text: `Access denied ${CANARY}` }] }));
    await t.call('get_quote', { secret: CANARY });
    const pts = await h.points('mcp.tool.auth_failures');
    expect(JSON.stringify(pts)).not.toContain(CANARY);
    expect(h.diagLines.join('\n')).not.toContain(CANARY);
  });

  it('a throwing getter on the error does not break the call', async () => {
    const hostile = {
      get status() {
        throw new Error('getter boom');
      },
    };
    const t = SHAPES[2].build({}, () => {
      throw hostile;
    });
    await expect(t.call()).rejects.toBe(hostile);
  });
});
