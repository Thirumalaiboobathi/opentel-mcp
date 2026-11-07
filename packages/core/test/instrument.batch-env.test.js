import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { trace, context, propagation } from '@opentelemetry/api';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpServer } from '../src/instrument.js';

// The sdk-trace BatchSpanProcessor ignores OTEL_BSP_* on its own; core reads
// them so the dev-mode OTLP path keeps honoring the spec's tuning variables.
describe('setupNodeSdk OTLP batch processor honors OTEL_BSP_* env', () => {
  let receiver;
  let instrumented;
  afterEach(async () => {
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
    await instrumented?.shutdown();
    await new Promise((r) => (receiver ? receiver.close(r) : r()));
    receiver?.closeAllConnections?.();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('exports well before the 5s default when OTEL_BSP_SCHEDULE_DELAY is small', async () => {
    let hits = 0;
    receiver = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits++;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    process.env.OTEL_BSP_SCHEDULE_DELAY = "50";
    instrumented = instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), {
      serviceName: 'x',
      setupNodeSdk: true,
      flushOnExit: false,
      exporterUrl: `http://127.0.0.1:${receiver.address().port}/v1/traces`,
    });
    trace.getTracer('t').startSpan('s').end();
    const start = Date.now();
    while (hits === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 25));
    expect(hits).toBeGreaterThan(0);
  });
});
