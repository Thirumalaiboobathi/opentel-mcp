import { describe, it, expect, vi, afterEach } from 'vitest';
import { main, USAGE } from '../bin/opentel-mcp-ui.js';

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
});
