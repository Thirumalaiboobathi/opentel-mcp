import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { trace, metrics, context, diag, DiagLogLevel } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { __resetFlushOnExitWarnedForTests } from '../../src/config.js';
import {
  FLUSH_ON_EXIT_MAX_TIMEOUT_MS,
  resolveFlushTimeout,
  registerFlushOnExit,
  flushAll,
  __resetFlushOnExitForTests,
  __registeredCountForTests,
} from '../../src/flush-on-exit.js';

/**
 * ADR 024 (flushOnExit). Process-level behavior (beforeExit, signals,
 * re-raise, exit codes, the timeout cap) is tested in real child processes
 * (./fixture.mjs), because it's about how a process stops. Registration
 * bookkeeping and never-throw are tested in-process.
 */

const FIXTURE = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const FLUSH_MARKER = '[opentel-mcp metrics] mcp.tool.calls';
const POSIX = process.platform !== 'win32';

/**
 * @param {{ mode?: string, options?: object, env?: Record<string, string>, signal?: NodeJS.Signals }} spec
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string, msFromSignal: number | null }>}
 */
function runFixture({ mode = 'exit', options = {}, env = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_OPTIONS: JSON.stringify(options), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let signalledAt = null;
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.stdout.on('data', (chunk) => {
      if (signal && signalledAt === null && chunk.toString().includes('READY')) {
        signalledAt = Date.now();
        child.kill(signal);
      }
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture did not exit in time; stderr:\n${stderr}`));
    }, 15_000);
    child.on('exit', (code, exitSignal) => {
      clearTimeout(killer);
      resolve({ code, signal: exitSignal, stderr, msFromSignal: signalledAt === null ? null : Date.now() - signalledAt });
    });
  });
}

// Each case spawns a real Node process (and one waits 1.5 s on purpose),
// so allow well beyond vitest's 5 s default when the whole suite runs in
// parallel. runFixture() has its own 15 s kill switch.
describe('flushOnExit in a real process (ADR 024)', { timeout: 20_000 }, () => {
  it('beforeExit: flushes, and the process keeps its own exit code', async () => {
    const result = await runFixture({ mode: 'exit', env: { FIXTURE_EXIT_CODE: '3' } });
    expect(result.stderr).toContain(FLUSH_MARKER);
    expect(result.code).toBe(3);
  });

  it('control: with flushOnExit: false the same process exits without flushing (the bug this fixes)', async () => {
    const result = await runFixture({ mode: 'exit', options: { flushOnExit: false } });
    expect(result.stderr).not.toContain(FLUSH_MARKER);
    expect(result.code).toBe(0);
  });

  it.skipIf(!POSIX)('SIGTERM: flushes, then the process dies by SIGTERM (re-raised)', async () => {
    const result = await runFixture({ mode: 'keepalive', signal: 'SIGTERM' });
    expect(result.stderr).toContain(FLUSH_MARKER);
    expect(result.signal).toBe('SIGTERM');
  });

  it.skipIf(!POSIX)('SIGINT: flushes, then the process dies by SIGINT (re-raised)', async () => {
    const result = await runFixture({ mode: 'keepalive', signal: 'SIGINT' });
    expect(result.stderr).toContain(FLUSH_MARKER);
    expect(result.signal).toBe('SIGINT');
  });

  it.skipIf(!POSIX)('control: SIGTERM with flushOnExit: false kills immediately without flushing', async () => {
    const result = await runFixture({ mode: 'keepalive', options: { flushOnExit: false }, signal: 'SIGTERM' });
    expect(result.stderr).not.toContain(FLUSH_MARKER);
    expect(result.signal).toBe('SIGTERM');
  });

  it.skipIf(!POSIX)("host handler respected: flushes but doesn't re-raise; the host's own exit (7) wins", async () => {
    const result = await runFixture({ mode: 'host-handler', signal: 'SIGTERM' });
    expect(result.stderr).toContain('HOST HANDLER');
    expect(result.stderr).toContain(FLUSH_MARKER);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(7);
  });

  it.skipIf(!POSIX)(
    `the flush is capped at ${FLUSH_ON_EXIT_MAX_TIMEOUT_MS} ms: an OTLP endpoint that never answers can't hold up SIGTERM`,
    async () => {
      // Accepts connections and never responds: the BatchSpanProcessor's
      // export (and so provider.shutdown()) hangs until the exporter's own
      // 10 s timeout, far past the cap.
      const sockets = [];
      const blackhole = createServer((socket) => sockets.push(socket));
      await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
      const { port } = blackhole.address();
      try {
        const result = await runFixture({
          mode: 'keepalive',
          options: { exporterUrl: `http://127.0.0.1:${port}/v1/traces` },
          signal: 'SIGTERM',
        });
        expect(result.signal).toBe('SIGTERM');
        // Cap plus generous scheduling tolerance; without the cap this would take ~10 s.
        expect(result.msFromSignal).toBeLessThan(FLUSH_ON_EXIT_MAX_TIMEOUT_MS + 1500);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => blackhole.close(resolve));
      }
    },
    20_000,
  );

  it('explicit shutdown() twice, then exit: no double shutdown, no errors', async () => {
    const result = await runFixture({ mode: 'exit', env: { FIXTURE_EXPLICIT_SHUTDOWN: '1' } });
    expect(result.stderr).toContain('EXPLICIT SHUTDOWN DONE');
    // Flushed exactly once: the metric line appears once.
    expect(result.stderr.split(FLUSH_MARKER).length - 1).toBe(1);
    expect(result.stderr).not.toMatch(/shutdown may only be called once|already shutdown/i);
    expect(result.code).toBe(0);
  });
});

describe('flushOnExit registration (in-process)', () => {
  const listenerCounts = () => ({
    beforeExit: process.listenerCount('beforeExit'),
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
  });

  afterEach(() => {
    __resetFlushOnExitForTests();
    __resetFlushOnExitWarnedForTests();
    trace.disable();
    metrics.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
  });

  it('resolveFlushTimeout: default and maximum 1000 ms; only lowers it', () => {
    expect(resolveFlushTimeout(undefined)).toBe(1000);
    expect(resolveFlushTimeout(250)).toBe(250);
    expect(resolveFlushTimeout(5000)).toBe(1000);
    for (const bad of [0, -5, Number.NaN, Infinity, '500', null]) expect(resolveFlushTimeout(bad)).toBe(1000);
  });

  it('default ON under setupNodeSdk: true: one listener set per process, however many servers', async () => {
    const before = listenerCounts();
    const a = instrumentMcpServer(new McpServer({ name: 'a', version: '0' }), { serviceName: 'a', setupNodeSdk: true });
    const b = instrumentMcpServer(new McpServer({ name: 'b', version: '0' }), { serviceName: 'b', setupNodeSdk: true });
    expect(listenerCounts()).toEqual({ beforeExit: before.beforeExit + 1, SIGTERM: before.SIGTERM + 1, SIGINT: before.SIGINT + 1 });
    expect(__registeredCountForTests()).toBe(2);

    await a.shutdown();
    expect(__registeredCountForTests()).toBe(1);
    expect(listenerCounts().SIGTERM).toBe(before.SIGTERM + 1);
    // Last one out removes the listeners: signal behavior is back to what it was.
    await b.shutdown();
    expect(listenerCounts()).toEqual(before);
  });

  it('flushOnExit: false installs nothing', () => {
    const before = listenerCounts();
    instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), { serviceName: 'x', setupNodeSdk: true, flushOnExit: false });
    expect(listenerCounts()).toEqual(before);
    expect(__registeredCountForTests()).toBe(0);
  });

  it('setupNodeSdk: false: never installs anything, even when asked, and warns once', () => {
    const warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
    const before = listenerCounts();
    instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), { flushOnExit: true });
    instrumentMcpServer(new McpServer({ name: 'y', version: '0' }), { flushOnExit: { timeoutMs: 200 } });
    expect(listenerCounts()).toEqual(before);
    const flushWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('flushOnExit'));
    expect(flushWarnings).toHaveLength(1);
  });

  it('no double shutdown: explicit shutdown() twice plus a process-level flush shut the provider down once', async () => {
    const spy = vi.spyOn(NodeTracerProvider.prototype, 'shutdown');
    const server = instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), { serviceName: 'x', setupNodeSdk: true });
    const first = server.shutdown();
    const second = server.shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second, flushAll()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a process-level flush followed by an explicit shutdown() also shuts down once', async () => {
    const spy = vi.spyOn(NodeTracerProvider.prototype, 'shutdown');
    const server = instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), { serviceName: 'x', setupNodeSdk: true });
    await flushAll();
    await server.shutdown();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never throws: a shutdown that throws synchronously or rejects still lets flushAll() resolve', async () => {
    registerFlushOnExit(() => {
      throw new Error('sync boom');
    }, 100);
    registerFlushOnExit(() => Promise.reject(new Error('async boom')), 100);
    await expect(flushAll()).resolves.toBeUndefined();
  });

  it("never throws: if process listeners can't be installed, instrumenting still succeeds and warns", () => {
    const warn = vi.fn();
    diag.setLogger({ warn, error() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
    vi.spyOn(process, 'on').mockImplementation(() => {
      throw new Error('process.on unavailable');
    });
    expect(() =>
      instrumentMcpServer(new McpServer({ name: 'x', version: '0' }), { serviceName: 'x', setupNodeSdk: true }),
    ).not.toThrow();
    expect(__registeredCountForTests()).toBe(0);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('flushOnExit could not install'))).toBe(true);
  });
});
