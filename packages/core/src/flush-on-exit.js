/**
 * @module flush-on-exit
 *
 * ADR 024 (docs/adr/024-flush-on-exit.md): flush the providers this
 * library owns (setupNodeSdk: true) when the process is about to stop.
 *
 * MCP clients built on the SDK's StdioClientTransport stop a server by
 * closing stdin, then SIGTERM 2 s later, then SIGKILL 2 s after that
 * (@modelcontextprotocol/sdk client/stdio.js close()). `beforeExit` only
 * covers the first step, and only when nothing else holds the loop open.
 *
 * One listener set per PROCESS, not per instrumented server: per-instance
 * listeners would each see the others as "the host's own handler" and none
 * would ever re-raise. Every instrumented server registers its memoized
 * shutdown() here; the listeners flush them all.
 *
 * - beforeExit: flush once. The process then exits on its own with
 *   whatever process.exitCode already was; nothing here changes it. No
 *   process.exit() call: a host's own beforeExit work must not be cut short.
 * - SIGTERM / SIGINT: remove our listener for that signal first (so a
 *   second signal takes Node's default and kills immediately), flush
 *   bounded by the timeout, then re-raise the same signal ONLY if no other
 *   listener for it remains. Installing a signal listener removes Node's
 *   default "exit on signal"; re-raising with no listeners restores it, so
 *   the parent sees the same death-by-signal it would have without us. If
 *   the host has its own listener, the host owns the exit.
 * - The flush wait is capped (FLUSH_ON_EXIT_MAX_TIMEOUT_MS) with an
 *   unref'd timer, so it never holds the process open by itself.
 *
 * Listeners are removed again once no server is registered (every
 * instrumented server shut down), so an explicitly shut-down process has
 * exactly the signal behavior it had before instrumenting.
 *
 * Never throws: everything that touches `process` is guarded.
 */

import { diag } from '@opentelemetry/api';

/** Upper bound on how long a stop waits for telemetry to flush (ADR 024). */
export const FLUSH_ON_EXIT_MAX_TIMEOUT_MS = 1000;

const SIGNALS = /** @type {const} */ (['SIGTERM', 'SIGINT']);

/** @type {Map<() => Promise<void>, number>} memoized shutdown -> its timeout */
const registered = new Map();

/** @type {{ beforeExit: (() => void) | null, SIGTERM: (() => void) | null, SIGINT: (() => void) | null }} */
const listeners = { beforeExit: null, SIGTERM: null, SIGINT: null };

let warnedInstallFailed = false;

/**
 * Clamps a user-supplied timeout into (0, FLUSH_ON_EXIT_MAX_TIMEOUT_MS].
 * Anything that isn't a positive finite number gets the maximum.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function resolveFlushTimeout(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(value, FLUSH_ON_EXIT_MAX_TIMEOUT_MS);
  }
  return FLUSH_ON_EXIT_MAX_TIMEOUT_MS;
}

/**
 * Runs every registered shutdown once, in parallel, and resolves when all
 * settle or the longest registered timeout elapses, whichever is first.
 * Never rejects.
 *
 * @returns {Promise<void>}
 */
export function flushAll() {
  const entries = [...registered];
  registered.clear();
  if (entries.length === 0) return Promise.resolve();

  const timeoutMs = Math.max(...entries.map(([, ms]) => ms));
  const work = Promise.allSettled(
    entries.map(([shutdown]) => {
      try {
        return Promise.resolve(shutdown());
      } catch (err) {
        return Promise.reject(err);
      }
    }),
  );

  return new Promise((resolve) => {
    let timer;
    try {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    } catch {
      // No timers available: fall back to waiting for the work itself.
    }
    work.then(() => {
      if (timer) clearTimeout(timer);
      resolve();
    });
  });
}

function onBeforeExit() {
  // Fires again once our own flush settles and the loop drains: nothing
  // registered by then, so this returns and the process exits normally.
  if (registered.size === 0) return;
  flushAll().then(uninstallIfIdle, uninstallIfIdle);
}

/** @param {'SIGTERM' | 'SIGINT'} signal */
function makeSignalListener(signal) {
  const listener = () => {
    try {
      process.removeListener(signal, listener);
    } catch {
      // ignore
    }
    listeners[signal] = null;
    flushAll().then(() => {
      try {
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
          return;
        }
        uninstallIfIdle();
      } catch (err) {
        diag.debug(`opentel-mcp: flushOnExit could not re-raise ${signal}: ${err?.message ?? err}`);
      }
    });
  };
  return listener;
}

function install() {
  try {
    if (!listeners.beforeExit) {
      listeners.beforeExit = onBeforeExit;
      process.on('beforeExit', onBeforeExit);
    }
    for (const signal of SIGNALS) {
      if (!listeners[signal]) {
        const listener = makeSignalListener(signal);
        listeners[signal] = listener;
        process.on(signal, listener);
      }
    }
    return true;
  } catch (err) {
    uninstall();
    if (!warnedInstallFailed) {
      warnedInstallFailed = true;
      diag.warn(
        `opentel-mcp: flushOnExit could not install process listeners (${err?.message ?? err}); ` +
          'telemetry will not be flushed automatically on exit. Call `await server.shutdown()` yourself.',
      );
    }
    return false;
  }
}

function uninstall() {
  try {
    if (listeners.beforeExit) process.removeListener('beforeExit', listeners.beforeExit);
    for (const signal of SIGNALS) {
      if (listeners[signal]) process.removeListener(signal, listeners[signal]);
    }
  } catch {
    // ignore
  }
  listeners.beforeExit = null;
  listeners.SIGTERM = null;
  listeners.SIGINT = null;
}

function uninstallIfIdle() {
  if (registered.size === 0) uninstall();
}

/**
 * Registers one instrumented server's memoized shutdown(). Returns an
 * unregister function (idempotent). Never throws.
 *
 * @param {() => Promise<void>} shutdown
 * @param {number} timeoutMs already resolved via resolveFlushTimeout()
 * @returns {() => void}
 */
export function registerFlushOnExit(shutdown, timeoutMs) {
  try {
    registered.set(shutdown, timeoutMs);
    if (!install()) registered.delete(shutdown);
  } catch {
    // never throw
  }
  return () => {
    try {
      registered.delete(shutdown);
      uninstallIfIdle();
    } catch {
      // never throw
    }
  };
}

/** Test-only: drop every registration and listener. Not part of the public API. */
export function __resetFlushOnExitForTests() {
  registered.clear();
  uninstall();
  warnedInstallFailed = false;
}

/** Test-only: how many servers are registered. Not part of the public API. */
export function __registeredCountForTests() {
  return registered.size;
}
