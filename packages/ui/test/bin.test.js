import { describe, it, expect, vi, afterEach } from 'vitest';
import { main, USAGE } from '../bin/opentel-mcp-ui.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('node:http').Server | undefined} */
let server;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

describe('bin/opentel-mcp-ui.js main() -- ADR 022 (v0.1.0 publish)', () => {
  it('--help prints usage and starts no server', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = main(['--help']);
    expect(result).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(USAGE);
    logSpy.mockRestore();
  });

  it('-h is the same as --help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['-h'])).toBeUndefined();
    logSpy.mockRestore();
  });

  it('--demo starts a real server, bound to loopback only, reporting demo: true over /api/meta', async () => {
    server = main(['--demo', '--port=0']);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    expect(address.address).toBe('127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/meta`);
    const body = await res.json();
    expect(body.demo).toBe(true);
    expect(body.detectors.thrashDetection.reason).toContain('--demo mode');
  });

  it('an invalid --port value degrades to the default instead of throwing (ERR_SOCKET_BAD_PORT otherwise)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      server = main(['--port=not-a-number', '--demo']);
    }).not.toThrow();
    await new Promise((resolve) => server.once('listening', resolve));
    expect(server.address().port).toBe(4319);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring invalid --port value'));
    errorSpy.mockRestore();
  });

  it('starts when invoked through a node_modules/.bin-style symlink -- not just the real file path (regression: the main-module guard must compare realpaths, not raw argv[1])', async () => {
    const binTarget = fileURLToPath(new URL('../bin/opentel-mcp-ui.js', import.meta.url));
    const linkDir = mkdtempSync(join(tmpdir(), 'opentel-mcp-ui-bin-link-'));
    const linkPath = join(linkDir, 'opentel-mcp-ui');
    symlinkSync(binTarget, linkPath);

    try {
      const child = spawn('node', [linkPath, '--demo', '--port=0'], {
        cwd: dirname(binTarget),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk.toString()));
      child.stderr.on('data', (chunk) => (output += chunk.toString()));

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for startup log; output so far:\n${output}`)), 5000);
        const check = () => {
          if (output.includes('dashboard listening at')) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on('data', check);
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (!output.includes('dashboard listening at')) {
            reject(new Error(`process exited (code ${code}) before starting; output:\n${output}`));
          }
        });
      });

      child.kill();
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

describe('startup log', () => {
  it('--port=0 prints the port actually bound, not 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      server = main(['--port=0']);
      await new Promise((resolve) => server.once('listening', resolve));
      // The listen callback that logs runs right after 'listening'.
      await new Promise((resolve) => setImmediate(resolve));
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(port).toBeGreaterThan(0);
      expect(output).toContain(`dashboard listening at http://localhost:${port}`);
      expect(output).toContain(`receiver at http://localhost:${port}/v1/traces`);
      expect(output).not.toContain('localhost:0');
    } finally {
      log.mockRestore();
    }
  });

  it("the setup hint names every option core requires with setupNodeSdk (serviceName included)", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      server = main(['--port=0']);
      await new Promise((resolve) => server.once('listening', resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(output).toMatch(/instrumentMcpServer\(server, \{ serviceName: '[^']+', setupNodeSdk: true, exporterUrl: 'http:\/\/localhost:\d+\/v1\/traces' \}\)/);
    } finally {
      log.mockRestore();
    }
  });
});
