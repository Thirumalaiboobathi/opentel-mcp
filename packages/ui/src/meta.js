/**
 * @module meta
 *
 * Backs `/api/meta`: which detectors are structurally live vs.
 * unavailable in the current deployment shape, opentel-mcp core's own
 * version, and this dashboard's buffer capacity/fill. Load-bearing (see
 * README/RUNLOG) -- a consumer must be able to tell "zero loops detected
 * because nothing is looping" from "zero loops detected because the
 * detector structurally cannot accumulate state here" (ADR 012).
 *
 * ADR 012 is explicit that this is NOT thrash-detection-specific: all
 * four of opentel-mcp core's in-memory trackers (thrash detection, the
 * cost/budget tracker, schema drift detection, and the ToolOutcome
 * counter) are constructed fresh inside every `instrumentMcpServer()`
 * call and share the identical reset-under-stateless-HTTP root cause.
 * `describeInMemoryTrackerAvailability()` below is deliberately generic
 * over "which tracker" for that reason -- see `server.js`'s `/api/meta`
 * handler for where it's applied to all four.
 *
 * IMPORTANT — honesty boundary, read before changing this file:
 * `server.transport`'s SHAPE (does it expose a `sessionId` getter?) is a
 * real, structural signal, but it answers a narrower question than "is
 * in-memory tracking safe here." ADR 012's actual finding is about a
 * *usage pattern* -- a fresh `Server`/`McpServer` + `instrumentMcpServer()`
 * call constructed PER REQUEST -- not about transport class as such: one
 * long-lived `StreamableHTTPServerTransport` serving many sessions over
 * its lifetime has no such problem. `withUI()` is called ONCE, on
 * whatever single server object it's given -- it structurally cannot
 * observe whether OTHER server objects are being constructed and
 * discarded on other requests elsewhere in the host's process. So:
 * - `statelessTransport: true/false` (explicit, host-supplied) is
 *   ALWAYS trusted outright -- same "operator assertion beats silent
 *   guessing" posture ADR 012 itself recommends for
 *   `thrashDetection.assumeSingleSession`.
 * - `statelessTransport: 'auto'` (the default) falls back to the
 *   structural transport-shape check, but the resulting status is
 *   `'unknown'`, not `'unavailable'`, when the transport looks
 *   session-oriented -- correlated risk, not confirmed unavailability.
 *   Only a session-LESS transport (stdio-shaped: connected, no
 *   `sessionId`) or an explicit `false` yields a confident `'live'`.
 */

/**
 * @typedef {'live' | 'unavailable' | 'unknown'} DetectorAvailability
 */

/**
 * Structural transport-shape check -- exactly the technique opentel-mcp
 * core's own (internal, unexported) `isSingleConnectionTransport()`
 * uses (`instrument.js`): a transport with no `sessionId` property is
 * reliably single-connection (stdio); one that exposes `sessionId` is
 * session-oriented (StreamableHTTPServerTransport, SSEServerTransport).
 * `server.transport` is only populated after `server.connect(transport)`
 * runs, so this can only ever inspect whatever's true *right now* -- a
 * server the UI attaches to before it's connected reads as
 * "undeterminable," the same honest default core itself falls back to.
 *
 * @param {*} instrumentedServer - low-level `Server` or `McpServer`-shaped object.
 * @returns {{ transport: unknown, shape: 'single-connection' | 'session-oriented' | 'undeterminable' }}
 */
export function inspectTransport(instrumentedServer) {
  const transport = instrumentedServer?.transport ?? instrumentedServer?.server?.transport;
  if (!transport) return { transport: undefined, shape: 'undeterminable' };
  const shape = 'sessionId' in transport ? 'session-oriented' : 'single-connection';
  return { transport, shape };
}

/**
 * @param {string} trackerLabel - human-readable name for the reason string, e.g. "Thrash detection".
 * @param {{ instrumentedServer: *, statelessTransport?: boolean | 'auto', demo?: boolean }} options -
 *   `demo` (ADR 022, v0.1.0 publish): set only by the standalone CLI's own `--demo` flag
 *   (`bin/opentel-mcp-ui.js`) — never by `withUI()`, which can legitimately combine `demo: true`
 *   (seed fixture spans) with a REAL `instrumentedServer` whose connection state is still a genuine,
 *   checkable question. `demo` here means "there is no server object at all, not just one that
 *   hasn't connected yet" — a categorically different fact from every other branch below, so it's
 *   checked first and short-circuits them all rather than falling through to the generic
 *   `shape: 'undeterminable'` case (whose "re-check after the server connects" advice is actively
 *   wrong when there is no server that could ever connect).
 * @returns {{ status: DetectorAvailability, reason: string }}
 */
export function describeInMemoryTrackerAvailability(
  trackerLabel,
  { instrumentedServer, statelessTransport = 'auto', demo = false },
) {
  if (demo) {
    return {
      status: 'unknown',
      reason:
        `${trackerLabel} status not applicable — this is --demo mode, showing fixture spans rather than ` +
        "output from a live detector. Point a real instrumented server's exporterUrl at this dashboard " +
        "(see the README's quickstart) to see live tracker status.",
    };
  }

  if (statelessTransport === true) {
    return {
      status: 'unavailable',
      reason:
        `${trackerLabel} unavailable — stateless HTTP transport (asserted via statelessTransport: true). ` +
        'In-memory trackers are per-request and cannot accumulate cross-call state. (ADR 012)',
    };
  }

  if (statelessTransport === false) {
    return {
      status: 'live',
      reason: `${trackerLabel} live — statelessTransport: false asserts a long-lived instrumented instance.`,
    };
  }

  const { shape } = inspectTransport(instrumentedServer);

  if (shape === 'single-connection') {
    return {
      status: 'live',
      reason: `${trackerLabel} live — transport is single-connection (e.g. stdio), safe by construction.`,
    };
  }

  if (shape === 'session-oriented') {
    return {
      status: 'unknown',
      reason:
        `${trackerLabel} may be unavailable — this server's transport is session-oriented (HTTP/SSE), which is ` +
        "consistent with (but doesn't confirm) a stateless-per-request deployment shape where in-memory trackers " +
        'reset before ever accumulating state. Pass statelessTransport: true/false to opentel-mcp-ui\'s withUI() ' +
        'if you know your deployment topology — auto-detection cannot always tell. (ADR 012)',
    };
  }

  return {
    status: 'unknown',
    reason:
      `${trackerLabel} availability undeterminable — this server's transport isn't connected yet (or isn't ` +
      'shaped like a known SDK transport). Re-check /api/meta after the server connects, or pass ' +
      "statelessTransport: true/false to opentel-mcp-ui's withUI() explicitly.",
  };
}
