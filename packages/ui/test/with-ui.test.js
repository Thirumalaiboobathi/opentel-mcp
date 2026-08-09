import { describe, it, expect, afterEach, vi } from 'vitest';
import { trace, diag, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { withUI } from '../src/with-ui.js';

/** @type {{ close: () => Promise<void> } | null} */
let handle = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  trace.disable();
});

describe('withUI', () => {
  it(
    'RELIABLE PATH: spans reach the dashboard over the OTLP/HTTP JSON receiver when a real ' +
      "server is instrumented with exporterUrl pointing at withUI()'s own URL -- this is the " +
      "actual, tested end-to-end integration mode, using opentel-mcp core's own, already-shipping " +
      'OTLP export mechanism (verified: @opentelemetry/sdk-trace 2.x has no public dynamic ' +
      'SpanProcessor-attach API -- see server.js/with-ui.js docblocks)',
    async () => {
      handle = await withUI({}, { port: 0 });

      // Simulates instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl: `${handle.url}/v1/traces` })
      // -- this IS the real OTLPTraceExporter opentel-mcp core's own
      // dependency tree ships, pointed at the dashboard's receiver.
      const exporter = new OTLPTraceExporter({ url: `${handle.url}/v1/traces` });
      const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
      provider.register();

      const tracer = trace.getTracer('test');
      tracer.startSpan('tools/call echo').end();

      // BatchSpanProcessor batches on a timer -- force it out immediately
      // rather than waiting on the default schedule.
      await provider.forceFlush();

      // Give the receiving end's request/response cycle a tick to land.
      await vi.waitFor(() => expect(handle.collector.buffer.size).toBe(1), { timeout: 2000 });
      expect(handle.collector.buffer.toArray()[0].name).toBe('tools/call echo');

      await provider.shutdown();
    },
  );

  it('BEST-EFFORT PATH: attaches directly when the registered provider happens to expose addSpanProcessor (proves withUI()\'s own logic, independent of what the installed real SDK supports)', async () => {
    // trace.setGlobalTracerProvider() sets this as the DELEGATE of the
    // real global ProxyTracerProvider -- trace.getTracerProvider() still
    // returns that real proxy, and resolveAttachableProvider() unwraps it
    // via .getDelegate() to reach this fake directly. No extra proxy
    // layer needed here.
    /** @type {import('@opentelemetry/sdk-trace').SpanProcessor[]} */
    const attached = [];
    const fakeDelegate = {
      addSpanProcessor: (p) => attached.push(p),
      getTracer: () => ({ startSpan: () => ({ end() {} }) }),
    };
    trace.setGlobalTracerProvider(fakeDelegate);

    handle = await withUI({}, { port: 0 });

    expect(attached).toEqual([handle.collector]);
  });

  it('starts the server successfully even when dynamic attach is not available -- never throws, degrades to the OTLP-only path', async () => {
    const warnSpy = vi.fn();
    diag.setLogger({ warn: warnSpy, error: () => {}, info: () => {}, debug: () => {}, verbose: () => {} }, DiagLogLevel.WARN);

    handle = await withUI({}, { port: 0 });
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/v1/traces'));

    // The dashboard is still fully functional via HTTP.
    const res = await fetch(`${handle.url}/api/meta`);
    expect(res.status).toBe(200);

    diag.disable();
  });

  it('respects bufferCapacity and statelessTransport options', async () => {
    handle = await withUI(
      { transport: { start() {}, get sessionId() { return 's'; } } },
      { port: 0, bufferCapacity: 3, statelessTransport: true },
    );

    expect(handle.collector.buffer.capacity).toBe(3);
    const meta = await (await fetch(`${handle.url}/api/meta`)).json();
    expect(meta.detectors.thrashDetection.status).toBe('unavailable');
  });

  it('close() shuts the HTTP server down', async () => {
    handle = await withUI({}, { port: 0 });
    const { url } = handle;
    await handle.close();
    handle = null;

    await expect(fetch(url)).rejects.toThrow();
  });
});
