// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SerializedSpan } from '../../src/types.d.ts';
import { buildDemoFixture } from '../../src/demo-fixture.js';
import { SecurityPanel } from './SecurityPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = root = null;
});

function render(spans: SerializedSpan[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<SecurityPanel spans={spans} />));
  return container;
}

const plain = (over: Partial<SerializedSpan> = {}): SerializedSpan => ({
  id: 'i', traceId: 't', name: 'tools/call echo', toolName: 'echo', startTimeMs: 1, durationMs: 1, status: 'OK', attributes: {}, ...over,
});

describe('SecurityPanel', () => {
  it('renders nothing for spans from an older core (no security signals): no panel, no empty box, no error', () => {
    const el = render([plain(), plain({ status: 'ERROR', errorType: 'tool_error', failureCategory: 'validation' })]);
    expect(el.innerHTML).toBe('');
    const empty = render([]);
    expect(empty.innerHTML).toBe('');
  });

  it('renders every section from the demo fixture, with the burst and the pin mismatch highlighted', () => {
    const el = render(buildDemoFixture());
    expect(el.querySelector('[data-testid="security-panel"]')).not.toBeNull();
    for (const id of ['security-integrity', 'security-leaks', 'security-auth', 'security-sensitive', 'security-skew']) {
      expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(el.querySelector('[data-testid="integrity-row-pin_mismatch"]')?.textContent).toContain('Pin mismatch');
    expect(el.querySelector('[data-testid="auth-burst-send_email"]')?.textContent).toContain('Burst');
    expect(el.querySelector('[data-testid="leak-row-read_file"]')?.textContent).toContain('aws_access_key_id');
    expect(el.querySelector('[data-testid="skew-row-get_quote"]')?.textContent).toContain('ahead');
    expect(el.textContent).toContain('Detection, not enforcement');
  });

  it('shows only 12-character hash prefixes, never a full hash', () => {
    const el = render(buildDemoFixture());
    const cells = [...el.querySelectorAll('td')].map((c) => c.textContent ?? '');
    expect(cells.filter((c) => /^[0-9a-f]{12}$/.test(c)).length).toBe(5); // 3 before/after pairs minus the added/removed blanks
    for (const c of cells) expect(c).not.toMatch(/[0-9a-f]{13,}/);
    expect(el.textContent).not.toContain('sha256:');
  });

  it('is read-only: no buttons, links, inputs, forms or handlers', () => {
    const el = render(buildDemoFixture());
    expect(el.querySelectorAll('button, a, input, select, textarea, form, [onclick]').length).toBe(0);
    expect(el.querySelectorAll('[role="button"], [tabindex]').length).toBe(0);
  });

  it('renders every value as text: hostile strings never become elements, and nothing uses innerHTML', () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const spans: SerializedSpan[] = [
      plain({
        name: 'tools/list',
        toolName: undefined,
        events: [
          { name: 'mcp.tool.integrity.pin_mismatch', timeMs: 5, attributes: { 'gen_ai.tool.name': evil, 'mcp.tool.integrity.expected_hash': evil, 'mcp.tool.integrity.actual_hash': 'javascript:alert(1)' } },
        ],
      }),
      plain({
        toolName: evil,
        status: 'ERROR',
        failureCategory: 'auth',
        attributes: { 'mcp.tool.secret_leak.detected': true, 'mcp.tool.secret_leak.types': [evil, 'jwt'], 'mcp.tool.freshness.clock_skew_ms': 2_000 },
        events: [{ name: 'mcp.audit.sensitive_call', attributes: { 'gen_ai.tool.name': evil, 'mcp.tool.outcome': 'success' } }],
      }),
      plain({ toolName: 'big', attributes: { 'mcp.tool.secret_leak.detected': true, 'mcp.tool.secret_leak.types': ['x'.repeat(10_000)] } }),
    ];
    const el = render(spans);
    expect(el.querySelectorAll('img, script, iframe, object, embed, svg, style').length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // The hostile text is present, but only as text content.
    expect(el.textContent).toContain('<img src=x');
    expect(el.textContent).not.toContain('x'.repeat(200));
  });
});
