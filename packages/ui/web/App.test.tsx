// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SerializedSpan } from '../src/types.d.ts';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';
import type { MetaResponse, SummaryResponse } from './data/types';

/**
 * A real, rendered-DOM smoke test for the acceptance criteria this
 * environment has no browser to check visually. This can't substitute
 * for actually looking at it (see RUNLOG/HANDOFF for that caveat, stated
 * plainly, not glossed over), but it's a stronger signal than "the build
 * succeeded" -- it renders the real component tree into jsdom, with a
 * fake fetch/EventSource standing in for the network, and asserts on the
 * resulting DOM and real click-handler effects.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function span(overrides: Partial<SerializedSpan>): SerializedSpan {
  return {
    id: 'id',
    traceId: 'trace',
    name: 'tools/call echo',
    startTimeMs: 1_700_000_000_000,
    durationMs: 5,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

function metaWith(overrides: Partial<MetaResponse['detectors']> = {}): MetaResponse {
  const live = { status: 'live' as const, reason: 'live' };
  return {
    coreVersion: '0.9.0',
    uiVersion: '0.1.0',
    transport: { shape: 'single-connection' },
    buffer: { capacity: 1000, size: 0, totalPushed: 0 },
    detectors: {
      thrashDetection: live,
      costTracking: live,
      schemaDrift: live,
      toolOutcome: live,
      ...overrides,
    },
  };
}

function summaryFor(spans: SerializedSpan[]): SummaryResponse {
  const buffered = { total: spans.length, success: 0, error: 0, silentFailure: 0 };
  for (const s of spans) {
    if (s.errorType === 'tool_error') buffered.silentFailure++;
    else if (s.status === 'ERROR') buffered.error++;
    else buffered.success++;
  }
  return { observationState: null, buffered };
}

/** A fake EventSource that never auto-connects to anything -- tests drive it manually via `emit()`. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(span: SerializedSpan) {
    this.onmessage?.({ data: JSON.stringify(span) });
  }
  close() {}
}

let backendState: { spans: SerializedSpan[]; meta: MetaResponse } = { spans: [], meta: metaWith() };

/** Updates what the mocked fetch() returns WITHOUT touching the EventSource stub -- used mid-test, after the component already opened its one SSE connection, to simulate the backend's state changing (e.g. after a new span arrives). */
function setBackendData(spans: SerializedSpan[], meta: MetaResponse) {
  backendState = { spans, meta };
}

function mockBackend(spans: SerializedSpan[], meta: MetaResponse) {
  setBackendData(spans, meta);
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/spans/history') {
      return { ok: true, json: async () => ({ spans: backendState.spans, capacity: 1000, size: backendState.spans.length }) };
    }
    if (url === '/api/summary') {
      return { ok: true, json: async () => summaryFor(backendState.spans) };
    }
    if (url === '/api/meta') {
      return { ok: true, json: async () => backendState.meta };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  // `vi.fn()`'s inferred type doesn't structurally match the real `fetch`
  // signature (Response has many more members than this mock needs) --
  // narrowing that away here is the standard shape for a fetch mock, not
  // a type-safety gap in the app code under test.
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  mockBackend([], metaWith());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function renderApp() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    // Flush the microtask queue so the initial Promise.all() fetch in
    // useDashboardData resolves before assertions run.
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe('App shell (no spans yet)', () => {
  it('renders the empty state when there is nothing to show', async () => {
    const el = await renderApp();
    expect(el.textContent).toContain('Waiting for spans');
  });

  it('renders a fixed sidebar with branding and a theme toggle', async () => {
    const el = await renderApp();
    expect(el.querySelector('.sidebar')).not.toBeNull();
    expect(el.textContent).toContain('opentel-mcp');
    expect(el.querySelector('.theme-toggle')).not.toBeNull();
  });

  it('DARK-FIRST: defaults to dark theme with no saved preference', async () => {
    await renderApp();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('theme toggle actually flips data-theme and persists it', async () => {
    const el = await renderApp();
    const toggle = el.querySelector<HTMLButtonElement>('.theme-toggle')!;

    act(() => toggle.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('opentel-mcp-ui:theme')).toBe('light');

    act(() => toggle.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('respects a previously-saved theme preference on next load', async () => {
    window.localStorage.setItem('opentel-mcp-ui:theme', 'light');
    await renderApp();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('App with spans: observation matrix', () => {
  it('ACCEPTANCE: matrix counts match /api/summary\'s buffered bucket exactly', async () => {
    const spans = [
      span({ id: '1', status: 'OK' }),
      span({ id: '2', status: 'OK' }),
      span({ id: '3', status: 'ERROR', errorType: 'TypeError' }),
      span({ id: '4', status: 'ERROR', errorType: 'tool_error' }),
      span({ id: '5', status: 'ERROR', errorType: 'tool_error' }),
    ];
    mockBackend(spans, metaWith());
    const el = await renderApp();

    const counts = Array.from(el.querySelectorAll('.matrix-count')).map((n) => n.textContent);
    // successVisible=2, successMissed=0(—), failureVisible=1, failureMissed=2
    expect(counts).toEqual(['2', '—', '1', '2']);
  });

  it('ACCEPTANCE: clicking a matrix cell filters the feed below to that cell', async () => {
    const spans = [
      span({ id: '1', toolName: 'search', status: 'OK' }),
      span({ id: '2', toolName: 'broken', status: 'ERROR', errorType: 'TypeError' }),
    ];
    mockBackend(spans, metaWith());
    const el = await renderApp();

    // Default view (no cell selected) is the silent-failure feed -- empty here.
    expect(el.textContent).toContain('No spans in this category yet.');

    const failureVisibleCell = el.querySelectorAll('.matrix-cell')[2] as HTMLButtonElement; // row FAILURE, col visible
    act(() => failureVisibleCell.click());

    expect(el.textContent).toContain('Failures visible to standard OTel');
    expect(el.textContent).toContain('broken');
    expect(el.textContent).not.toContain('search');
  });

  it('the successMissed cell renders an em-dash, not a bare 0, and is visually distinct', async () => {
    mockBackend([span({ id: '1', status: 'OK' })], metaWith());
    const el = await renderApp();
    const emptyCell = el.querySelector('.matrix-cell-empty');
    expect(emptyCell?.querySelector('.matrix-count')?.textContent).toBe('—');
  });

  it('the failureMissed cell (the product) gets distinct styling from the other three', async () => {
    mockBackend([span({ id: '1', errorType: 'tool_error', status: 'ERROR' })], metaWith());
    const el = await renderApp();
    expect(el.querySelector('.matrix-cell-product')).not.toBeNull();
  });
});

describe('App with spans: detector banner', () => {
  it("ACCEPTANCE: reflects a STATEFUL (single-connection) transport as fully live", async () => {
    mockBackend([span({ id: '1' })], metaWith());
    const el = await renderApp();
    expect(el.textContent).toContain('All four in-memory trackers live');
  });

  it('ACCEPTANCE: reflects a STATELESS transport, citing ADR 012, using /api/meta\'s reason text verbatim', async () => {
    const meta = metaWith({
      thrashDetection: { status: 'unavailable', reason: 'Thrash detection unavailable — stateless HTTP transport. (ADR 012)' },
    });
    mockBackend([span({ id: '1' })], meta);
    const el = await renderApp();
    expect(el.textContent).toContain('Thrash detection unavailable — stateless HTTP transport. (ADR 012)');
  });

  it('does not flatten an "unknown" detector status into "unavailable" styling/copy', async () => {
    const meta = metaWith({
      thrashDetection: { status: 'unknown', reason: 'Thrash detection may be unavailable — unconfirmed.' },
    });
    mockBackend([span({ id: '1' })], meta);
    const el = await renderApp();
    const line = el.querySelector('.detector-banner-unknown');
    expect(line).not.toBeNull();
    expect(el.querySelector('.detector-banner-unavailable')).toBeNull();
  });
});

describe('App: live SSE updates', () => {
  it('a span arriving over SSE updates the matrix without a page reload', async () => {
    mockBackend([], metaWith());
    const el = await renderApp();

    const newSpan = span({ id: 'live-1', status: 'OK' });
    // Refresh the mocked /api/summary to reflect the new span before the
    // component's post-SSE-event refetch resolves -- WITHOUT re-stubbing
    // EventSource, since the component already opened its one connection.
    setBackendData([newSpan], metaWith());

    await act(async () => {
      FakeEventSource.instances[0]!.emit(newSpan);
      await Promise.resolve();
      await Promise.resolve();
    });

    const counts = Array.from(el.querySelectorAll('.matrix-count')).map((n) => n.textContent);
    expect(counts).toEqual(['1', '—', '0', '0']);
  });
});
