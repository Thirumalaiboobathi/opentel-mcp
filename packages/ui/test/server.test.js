import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';

/** @param {Partial<import('../src/types.d.ts').SerializedSpan>} overrides */
function span(overrides) {
  return {
    id: 'id',
    traceId: 'trace',
    name: 'tools/call echo',
    startTimeMs: 1_700_000_000_000,
    durationMs: 1,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

/** @type {import('node:http').Server} */
let httpServer;
/** @type {CollectorSpanProcessor} */
let collector;
/** @type {string} */
let baseUrl;

function startServer(options = {}) {
  collector = new CollectorSpanProcessor({ capacity: options.capacity ?? 10 });
  httpServer = createServer({ instrumentedServer: options.instrumentedServer ?? {}, collector, ...options });
  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      baseUrl = `http://localhost:${httpServer.address().port}`;
      resolve();
    });
  });
}

afterEach(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

describe('createServer -- routes serve valid JSON with no frontend present', () => {
  beforeEach(() => startServer());

  it('GET / serves HTML (the placeholder stub, since no SPA bundle is wired yet)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('opentel-mcp-ui');
  });

  it('GET /api/spans/history returns valid JSON: {spans, capacity, size}', async () => {
    collector.ingestSerializedSpan(span({ id: 'a' }));
    collector.ingestSerializedSpan(span({ id: 'b' }));

    const res = await fetch(`${baseUrl}/api/spans/history`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ spans: [span({ id: 'a' }), span({ id: 'b' })], capacity: 10, size: 2 });
  });

  it('GET /api/summary returns valid JSON matching computeSummary()', async () => {
    collector.ingestSerializedSpan(span({ status: 'OK' }));
    collector.ingestSerializedSpan(span({ status: 'ERROR', errorType: 'tool_error' }));

    const res = await fetch(`${baseUrl}/api/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observationState).toBeNull();
    expect(body.buffered).toEqual({ total: 2, success: 1, error: 0, silentFailure: 1 });
  });

  it('GET /api/meta returns valid JSON with core/ui version, transport, buffer, and all four detectors', async () => {
    const res = await fetch(`${baseUrl}/api/meta`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.coreVersion).toBe('string');
    expect(typeof body.uiVersion).toBe('string');
    expect(body.transport).toHaveProperty('shape');
    expect(body.buffer).toEqual({ capacity: 10, size: 0, totalPushed: 0 });
    expect(body.detectors).toHaveProperty('thrashDetection');
    expect(body.detectors).toHaveProperty('costTracking');
    expect(body.detectors).toHaveProperty('schemaDrift');
    expect(body.detectors).toHaveProperty('toolOutcome');
    expect(body.detectors.thrashDetection).toHaveProperty('status');
    expect(body.detectors.thrashDetection).toHaveProperty('reason');
  });

  it('unknown route returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  it('non-GET request returns 405 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/summary`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('createServer -- /api/meta reflects BOTH transport modes end-to-end over real HTTP', () => {
  it('stdio-shaped (single-connection) transport: thrash detection reports live', async () => {
    await startServer({ instrumentedServer: { transport: { start() {} } } });
    const body = await (await fetch(`${baseUrl}/api/meta`)).json();
    expect(body.transport.shape).toBe('single-connection');
    expect(body.detectors.thrashDetection.status).toBe('live');
  });

  it('explicitly-asserted stateless HTTP transport: thrash detection reports unavailable, citing ADR 012', async () => {
    await startServer({
      instrumentedServer: {
        transport: {
          start() {},
          get sessionId() {
            return 's';
          },
        },
      },
      statelessTransport: true,
    });
    const body = await (await fetch(`${baseUrl}/api/meta`)).json();
    expect(body.transport.shape).toBe('session-oriented');
    expect(body.detectors.thrashDetection.status).toBe('unavailable');
    expect(body.detectors.thrashDetection.reason).toContain('ADR 012');
  });
});

describe('createServer -- GET /api/spans (SSE)', () => {
  beforeEach(() => startServer());

  it('streams newly-ingested spans live as SSE events', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/spans`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Read the retry: preamble.
    let buffered = '';
    buffered += decoder.decode((await reader.read()).value);

    collector.ingestSerializedSpan(span({ id: 'live-1' }));

    // Read until we see the event we just ingested.
    while (!buffered.includes('live-1')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value);
    }

    expect(buffered).toContain('id: 1');
    expect(buffered).toContain('"id":"live-1"');

    controller.abort();
  });

  it('RECONNECT: a client reconnecting with Last-Event-ID replays only spans it missed, from the buffer', async () => {
    collector.ingestSerializedSpan(span({ id: 'missed-1' }));
    collector.ingestSerializedSpan(span({ id: 'missed-2' }));
    // Client "saw" seq 1 already (missed-1); reconnects expecting seq 2+.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/spans?lastEventId=1`, { signal: controller.signal });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (!buffered.includes('missed-2')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value);
    }

    expect(buffered).toContain('missed-2');
    expect(buffered).not.toContain('missed-1');

    controller.abort();
  });

  it('RECONNECT: a brand-new client (no Last-Event-ID) gets the full current buffer replayed first', async () => {
    collector.ingestSerializedSpan(span({ id: 'history-1' }));
    collector.ingestSerializedSpan(span({ id: 'history-2' }));

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/spans`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (!buffered.includes('history-2')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value);
    }

    expect(buffered).toContain('history-1');
    expect(buffered).toContain('history-2');

    controller.abort();
  });

  it('disconnecting a client unsubscribes it (no listener leak) -- ingesting after close does not throw', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/spans`, { signal: controller.signal });
    // Drain the preamble so the connection is fully established server-side.
    await res.body.getReader().read();
    controller.abort();

    // Give the server a tick to process the 'close' event.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(() => collector.ingestSerializedSpan(span({ id: 'after-close' }))).not.toThrow();
  });
});
