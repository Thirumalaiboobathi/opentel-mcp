import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { CollectorSpanProcessor } from '../src/collector-span-processor.js';
import { MAX_OTLP_BODY_BYTES, MAX_DISCARDED_BODY_BYTES, isAllowedHost, isSameOrigin } from '../src/request-guard.js';
import { buildContentSecurityPolicy, extractInlineBlocks } from '../src/csp.js';
import { main } from '../bin/opentel-mcp-ui.js';
import { withUI } from '../src/with-ui.js';

/** v0.3.0 security hardening: items B4-B7 and B9 (B8 is in web/App.test.tsx). */

const SPA = `<!doctype html><html><head><script type="module">const s = "<script>"; console.log(s)</script><style>body{color:red}</style></head><body><div id="root"></div></body></html>`;

const otlpBody = (toolName = 'echo') =>
  JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: `tools/call ${toolName}`,
                spanId: 'aa',
                traceId: 'bb',
                startTimeUnixNano: '1000000',
                endTimeUnixNano: '2000000',
                attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: toolName } }],
              },
            ],
          },
        ],
      },
    ],
  });

/**
 * A raw HTTP request, so Host/Origin/framing are exactly what the test says.
 *
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(port, { method = 'GET', path = '/', headers = {}, body, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, setHost }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server;
let collector;
let port;

beforeEach(async () => {
  collector = new CollectorSpanProcessor();
  server = createServer({ instrumentedServer: null, collector, spaHtml: SPA });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const json = { 'Content-Type': 'application/json' };

describe('B4: binds to loopback only', () => {
  it('the CLI listens on 127.0.0.1', async () => {
    const cli = main(['--port=0']);
    await new Promise((r) => cli.once('listening', r));
    try {
      expect(cli.address().address).toBe('127.0.0.1');
    } finally {
      await new Promise((r) => cli.close(r));
    }
  });

  it('withUI() listens on 127.0.0.1', async () => {
    const ui = await withUI({}, { port: 0 });
    try {
      expect(ui.server.address().address).toBe('127.0.0.1');
    } finally {
      await new Promise((r) => ui.server.close(r));
    }
  });
});

describe('B5: cross-site requests are refused; server-to-server OTLP still works', () => {
  it('server-to-server OTLP (no Origin, no Sec-Fetch-*) is accepted', async () => {
    const res = await request(port, { method: 'POST', path: '/v1/traces', headers: json, body: otlpBody() });
    expect(res.status).toBe(200);
    expect(collector.buffer.size).toBe(1);
  });

  it('a foreign page POSTing spans is refused (403) and nothing is ingested', async () => {
    for (const headers of [
      { ...json, Origin: 'https://evil.example' },
      { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      { ...json, Origin: 'http://localhost:3000' }, // another local app: same-site, but not this origin
      { ...json, Origin: 'null' }, // sandboxed iframe / file://
    ]) {
      const res = await request(port, { method: 'POST', path: '/v1/traces', headers, body: otlpBody('injected') });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(collector.buffer.size).toBe(0);
  });

  it('a cross-site request without an Origin header (Sec-Fetch-Site: cross-site) is refused', async () => {
    const res = await request(port, { path: '/api/spans/history', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('a foreign page reading /api/* is refused, and no CORS header is ever sent', async () => {
    for (const path of ['/api/spans/history', '/api/summary', '/api/meta', '/api/spans']) {
      const res = await request(port, { path, headers: { Origin: 'https://evil.example' } });
      expect(res.status, path).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it("the dashboard's own origin (any loopback spelling) is allowed", async () => {
    for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
      const res = await request(port, { path: '/api/summary', headers: { Origin: origin } });
      expect(res.status, origin).toBe(200);
    }
    const same = await request(port, { path: '/api/meta', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(same.status).toBe(200);
  });

  it('following a link to the dashboard from another site still works', async () => {
    const res = await request(port, { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
    expect(res.status).toBe(200);
  });
});

describe('B6: DNS rebinding (Host header validation)', () => {
  it('a foreign Host is refused on every route', async () => {
    for (const path of ['/', '/api/spans/history', '/api/meta', '/v1/traces']) {
      const method = path === '/v1/traces' ? 'POST' : 'GET';
      const res = await request(port, { method, path, headers: { ...json, Host: `evil.example:${port}` }, body: method === 'POST' ? otlpBody() : undefined });
      expect(res.status, path).toBe(403);
    }
    expect(collector.buffer.size).toBe(0);
  });

  it('loopback names on this port are accepted', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      const res = await request(port, { path: '/api/summary', headers: { Host: host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('a loopback name on a different port is refused', async () => {
    const res = await request(port, { path: '/api/summary', headers: { Host: `localhost:${port + 1}` } });
    expect(res.status).toBe(403);
  });

  it("a request with no Host header never reaches the handler: Node's HTTP/1.1 server rejects it (400)", async () => {
    const res = await request(port, { path: '/api/summary', setHost: false });
    expect(res.status).toBe(400);
  });

  it('isAllowedHost / isSameOrigin edge cases', () => {
    expect(isAllowedHost('localhost', 80)).toBe(true);
    expect(isAllowedHost('localhost', 4319)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.example:4319', 4319)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:4319', 4319)).toBe(false);
    expect(isAllowedHost('[::1]:4319', 4319)).toBe(true);
    expect(isAllowedHost('0.0.0.0:4319', 4319)).toBe(false);
    expect(isAllowedHost('localhost:4319:1', 4319)).toBe(false);
    expect(isSameOrigin('https://localhost:4319', 4319)).toBe(false);
    expect(isSameOrigin('http://localhost:4319', 4319)).toBe(true);
    expect(isSameOrigin('not a url', 4319)).toBe(false);
  });
});

describe('B7: OTLP receiver limits', () => {
  /**
   * Streams `totalBytes` of body (declared up front via Content-Length when
   * `declare` is set, chunked otherwise) and resolves with the status the
   * client saw, or 'socket' if the connection failed before a response.
   */
  function upload(totalBytes, { declare = false } = {}) {
    return new Promise((resolve) => {
      const headers = { ...json, ...(declare ? { 'Content-Length': String(totalBytes) } : {}) };
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/traces', headers }, (r) => {
        r.resume();
        resolve({ status: r.statusCode });
      });
      req.on('error', () => resolve({ status: 'socket' }));
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < totalBytes) {
          const piece = sent + chunk.length <= totalBytes ? chunk : chunk.subarray(0, totalBytes - sent);
          sent += piece.length;
          if (!req.write(piece)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
  }

  // These two assert 413 strictly: the server answers, then reads and
  // discards the rest of the upload instead of closing mid-write, so the
  // client always gets to read the response. (Closing raced the 413
  // against EPIPE/ECONNRESET, which failed CI on Node 20 and on Windows.)
  it('rejects a body whose declared Content-Length is over the limit with 413', async () => {
    const res = await upload(MAX_OTLP_BODY_BYTES + 1, { declare: true });
    expect(res.status).toBe(413);
    expect(collector.buffer.size).toBe(0);
    expect((await request(port, { path: '/api/summary' })).status).toBe(200);
  });

  it('rejects an oversized chunked body with 413, without buffering it, and keeps serving', async () => {
    const res = await upload(12 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(collector.buffer.size).toBe(0);
    expect((await request(port, { path: '/api/summary' })).status).toBe(200);
  });

  it('cuts off a sender that keeps going far past the limit, and keeps serving', async () => {
    // The 413 may or may not be read before the cut; either is fine here.
    // What matters is that the server stops reading and stays up.
    const res = await upload(MAX_DISCARDED_BODY_BYTES + 8 * 1024 * 1024);
    expect([413, 'socket']).toContain(res.status);
    expect((await request(port, { path: '/api/summary' })).status).toBe(200);
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['protobuf', 'application/x-protobuf'],
    ['form', 'application/x-www-form-urlencoded'],
    ['missing', undefined],
  ])('rejects a %s content type with 415 and a clear message', async (_label, type) => {
    const res = await request(port, { method: 'POST', path: '/v1/traces', headers: type ? { 'Content-Type': type } : {}, body: otlpBody() });
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error).toMatch(/application\/json/);
    expect(collector.buffer.size).toBe(0);
  });

  it('accepts application/json with parameters', async () => {
    const res = await request(port, { method: 'POST', path: '/v1/traces', headers: { 'Content-Type': 'Application/JSON; charset=utf-8' }, body: otlpBody() });
    expect(res.status).toBe(200);
  });

  const deep = (n) => '['.repeat(n) + ']'.repeat(n);
  it.each([
    ['not JSON', '{"resourceSpans": ['],
    ['empty body', ''],
    ['a number', '42'],
    ['resourceSpans not a list', '{"resourceSpans": 5}'],
    ['attributes as a string', '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"tools/call x","attributes":"oops"}]}]}]}'],
    ['bad timestamp', '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"tools/call x","startTimeUnixNano":"soon"}]}]}]}'],
    ['deeply nested JSON', deep(100_000)],
    [
      'deeply nested arrayValue',
      `{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"tools/call x","attributes":[{"key":"k","value":${'{"arrayValue":{"values":['.repeat(5_000)}{}${']}}'.repeat(5_000)}}]}]}]}]}`,
    ],
  ])('a malformed payload (%s) never crashes the server', async (_label, body) => {
    const res = await request(port, { method: 'POST', path: '/v1/traces', headers: json, body });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(500);
    expect((await request(port, { path: '/api/summary' })).status).toBe(200);
  });

  it('an aborted mid-body request never crashes the server', async () => {
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"resourceSp`);
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await request(port, { path: '/api/summary' })).status).toBe(200);
  });
});

describe('B9: Content-Security-Policy on the dashboard page', () => {
  const sha = (t) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`;

  it('allows exactly the inline script and style being served, by hash, with no unsafe-inline', async () => {
    const res = await request(port, { path: '/' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain(`script-src ${sha('const s = "<script>"; console.log(s)')}`);
    expect(csp).toContain(`style-src ${sha('body{color:red}')}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('skips over markup-like text inside a script body and ignores external scripts', () => {
    const { scripts, styles } = extractInlineBlocks(
      '<script src="x.js"></script><script>a("<style>")</script><STYLE media="all">p{}</STYLE><script type="module">b()</script>',
    );
    expect(scripts).toEqual(['a("<style>")', 'b()']);
    expect(styles).toEqual(['p{}']);
  });

  it('hashes CRLF (Windows line endings) the way browsers do, as LF', () => {
    const crlf = '<script>\r\nconst a = 1;\r\nconst b = 2;\r</script><style>\r\np{}\r\n</style>';
    const lf = '<script>\nconst a = 1;\nconst b = 2;\n</script><style>\np{}\n</style>';
    expect(buildContentSecurityPolicy(crlf)).toBe(buildContentSecurityPolicy(lf));
    expect(buildContentSecurityPolicy(crlf)).toContain(sha('\nconst a = 1;\nconst b = 2;\n'));
  });

  it("a page with no inline blocks gets script-src 'none'", () => {
    expect(buildContentSecurityPolicy('<p>hi</p>')).toContain("script-src 'none'");
  });

  it('every response carries nosniff and same-origin resource policy', async () => {
    const res = await request(port, { path: '/api/meta' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
