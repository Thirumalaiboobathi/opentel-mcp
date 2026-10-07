# ADR 024: `flushOnExit` — flush telemetry when an MCP server is stopped

**Status:** Proposed — awaiting approval. Investigation and design only; nothing in this ADR is implemented.

## Context

The core README quickstart (`packages/core/README.md:98-104`) and both examples
(`examples/hello-server/server.js:49`, `examples/hello-mcpserver/server.js:55`)
carry the same block:

```js
let flushed = false;
process.on('beforeExit', () => {
  if (flushed) return;
  flushed = true;
  instrumented.shutdown();
});
```

`instrumented.shutdown()` exists only under `setupNodeSdk: true`: it shuts down
the `NodeTracerProvider` and the dev-mode `MeterProvider` this library created
(`packages/core/src/instrument.js:814-817`), and is copied to the outer
`McpServer` (`instrument.js:497-498`). The OTLP span path is a
`BatchSpanProcessor` (`instrument.js:739`), and dev metrics export every 5 s
(`instrument.js:709`, ADR 023). Anything still buffered when the process dies is
lost.

`beforeExit` fires only when the event loop drains on its own. It does **not**
fire on `process.exit()`, on a signal with Node's default disposition, or on
`SIGKILL`. The question is how MCP clients actually stop servers.

## Step 0 findings

### 1. How MCP clients stop stdio servers

**The SDK's own client escalates stdin close → SIGTERM → SIGKILL, 2 s apart.**
`StdioClientTransport.close()` (`@modelcontextprotocol/sdk@1.32.1`,
`dist/esm/client/stdio.js:143-176`):

1. `processToClose.stdin?.end()` (`:153`)
2. waits up to 2000 ms for the child to exit (`:158`)
3. if still running, `kill('SIGTERM')` (`:161`), then waits up to 2000 ms more (`:166`)
4. if still running, `kill('SIGKILL')` (`:170`)

Clients built on this transport, which covers most TypeScript hosts, follow
that sequence. I didn't verify clients written in other languages, so this ADR
doesn't assume they behave the same (see Open questions).

**What the server side does on stdin close depends on the SDK major version:**

- **v1** `StdioServerTransport` subscribes only to stdin `data` and `error`
  (`sdk/dist/esm/server/stdio.js:37-38`). It does not notice EOF at all, which
  matches the comment in `examples/hello-mcpserver/server.js:26-29`.
- **v2** `StdioServerTransport` also listens for stdin `end` and `close` and
  calls its own `close()` (`@modelcontextprotocol/server@2.3.1`,
  `dist/stdio.mjs:62-64, 75-76, 88-99`). That fires `onclose` but does not
  call `process.exit()`.

Neither transport installs signal handlers or calls `process.exit()`. After
stdin closes, the process exits naturally only if nothing else holds the event
loop open. OTel's own timers don't: the metric reader's interval is unref'd
(`@opentelemetry/sdk-metrics`, `PeriodicExportingMetricReader.js:161`), and so
is the BatchSpanProcessor timer (`@opentelemetry/sdk-trace`,
`BatchSpanProcessorBase.js:202`).

So, for a stdio server:

| Shutdown path | When it happens | `beforeExit` fires? |
| --- | --- | --- |
| stdin EOF → loop drains | server has no other live handles | **yes** (today's README block works) |
| SIGTERM at +2 s | anything keeps the loop alive: DB pool, HTTP keep-alive agent, a `setInterval` the host forgot to unref | **no** (default disposition kills immediately) |
| SIGINT | Ctrl+C in a terminal; some hosts | **no** |
| SIGKILL at +4 s | the server ignored SIGTERM | **no** (and nothing can run) |
| `process.exit()` | host code calls it, e.g. in its own `transport.onclose` | **no**; `'exit'` listeners are synchronous only |

**Windows:** SIGTERM isn't raised on Windows. `child.kill('SIGTERM')` there
terminates the process outright and can't be intercepted (Node docs, "Signal
events"). Only the stdin-EOF path and Ctrl+C (`SIGINT`) are catchable.

### 2. Can a library safely add SIGTERM/SIGINT listeners?

Only carefully. Node's documented behavior: installing a listener for
`SIGTERM` or `SIGINT` **removes the default behavior** (exit with 128 + signal
number). A library that adds `process.on('SIGTERM', flush)` and does nothing
else turns "stop" into "flush, then keep running until the loop drains", which
is a hang for exactly the servers that needed the signal.

Restoring the default after flushing:

1. Remove our own listener.
2. If **no other** listener remains for that signal, re-raise it with
   `process.kill(process.pid, signal)`. With no listeners, Node applies the
   default disposition, so the process dies *by that signal*. The parent sees
   the same termination it would have without us: on POSIX, killed by SIGTERM,
   shell status 143.
3. If **other** listeners remain, the host has its own signal handling and
   owns the exit. We flush and do nothing else.

A second signal arriving during the flush hits no listener (ours was removed in
step 1, before awaiting), so it takes the default disposition immediately: a
second Ctrl+C still force-quits.

### 3. How other OTel libraries handle it

- `@opentelemetry/sdk-node` (0.223.0) installs **no** process listeners. Its
  docs leave shutdown to the application.
- `@opentelemetry/auto-instrumentations-node/register` (0.81.0,
  `build/src/register.js:45-48`) does:
  `process.on('SIGTERM', shutdown)` and `process.once('beforeExit', shutdown)`,
  where `shutdown` awaits `sdk.shutdown()` **and never exits or re-raises**.
  That is the hang described above: with `register` loaded, SIGTERM no longer
  terminates a process that has other live handles. This is the failure mode
  this ADR must not reproduce.

## Decision (proposed)

### API shape: an option, not a helper — recommended

```ts
instrumentMcpServer(server, {
  serviceName: 'my-mcp-server',
  setupNodeSdk: true,
  flushOnExit: true, // or { timeoutMs?: number }
});
```

| | Option on `instrumentMcpServer` | Exported helper `registerFlushOnExit(instrumented, opts)` |
| --- | --- | --- |
| Quickstart | one key, deletes the 6-line block | one extra import + call |
| What it can flush | exactly the providers this library owns | anything with a `shutdown()`, including host providers |
| Default-on possible | yes | no (must be called) |
| Risk of touching host-owned providers | none (only acts under `setupNodeSdk: true`) | caller's choice |

**Recommendation: the option.** The problem only exists for providers this
library created (`setupNodeSdk: true`). Under `setupNodeSdk: false` the host
owns its providers and its shutdown sequence, and `instrumented.shutdown()`
doesn't even exist (`instrument.js:814` is inside the `setupNodeSdk` branch).
An option scoped to the owned providers keeps that boundary intact. A helper
could be added later without conflict if host-provider users ask for it.

### Behavior per event

All handlers are installed once per **process**, not per instrumented server.
A module-level registry holds every instance's shutdown function. Per-instance
listeners would see each other as "other listeners" and none would ever
re-raise.

| Event | Behavior |
| --- | --- |
| `beforeExit` | `process.on('beforeExit')`: run the shared shutdown once (guarded), bounded by `timeoutMs`. When it settles, the loop drains again and the process exits with whatever `process.exitCode` already was; `beforeExit` doesn't change it. Replaces the README block exactly. |
| stdin EOF | No listener of our own: stdin belongs to the transport. EOF either drains the loop (→ `beforeExit` row) or leads to the client's SIGTERM 2 s later (→ next row). |
| `SIGTERM`, `SIGINT` | Listener installed with `process.on`. On receipt: remove our listener for that signal; start the bounded shutdown; when it settles (or times out), if `process.listenerCount(signal) === 0`, re-raise with `process.kill(process.pid, signal)`; otherwise return and let the host's own handler decide. |
| `process.exit()` | **Not covered.** `'exit'` listeners can't await an OTLP export. Documented: call `await instrumented.shutdown()` before `process.exit()`. |
| `SIGKILL` | Not catchable. Documented. |
| Windows | `SIGINT` (Ctrl+C) as above; `SIGTERM` can't be intercepted (see Step 0). |

### Bounded flush

- `timeoutMs` default **1000**. Stays under the SDK client's 2 s gaps
  (`client/stdio.js:158, 166`), so a flush started on stdin EOF finishes before
  SIGTERM and one started on SIGTERM finishes before SIGKILL.
- `Promise.race([sharedShutdown(), delay(timeoutMs)])`, with the delay timer
  `unref()`'d so it never holds the process open by itself.
- Invalid `timeoutMs` (non-finite, ≤ 0) falls back to the default; values are
  clamped to at most 5000. Never throws.
- A timeout doesn't cancel the export. The process is allowed to proceed
  (re-raise / exit) and whatever hasn't been sent is lost, same as today.

### Defaults

- **`setupNodeSdk: false` (production): `flushOnExit` has no effect, ever.**
  No listeners are installed. If the caller passes `flushOnExit: true` anyway,
  one `diag.warn` (once per process, same pattern as `config.js:205-211`)
  explains that the host owns its providers. Production behavior is unchanged.
- **`setupNodeSdk: true`: recommended default `true`.** This is the dev path
  whose quickstart currently needs the manual block. The library already owns
  process-global providers there (`provider.register()`, `instrument.js:758`).
  With re-raise, the only observable change on a signal is up to `timeoutMs` of
  delay before the same termination. Opt out with `flushOnExit: false`.
  The conservative alternative, default `false` with the README showing
  `flushOnExit: true`, is listed under Open questions.

### No double shutdown

`server.shutdown` (and the outer McpServer's copy) becomes a memoized
function: the first call creates the shutdown promise, and every later call,
from the host or from `flushOnExit`, returns that same promise.
`NodeTracerProvider.shutdown()` therefore runs exactly once, and an explicit
`await server.shutdown()` followed by a signal doesn't re-run it. The registry
entry is removed once its shutdown settles.

### Never throws

Every listener body is wrapped in `try/catch` and swallows to `diag.debug`.
Listener installation failures (e.g. a sandboxed `process` without `.on`)
degrade to "no flush on exit" with a single `diag.warn`.
`instrumentMcpServer()` never throws because of this option.

## Alternatives considered

1. **Keep the README block.** Zero risk, but covers only the stdin-EOF-and-drain
   path, which is the one the SDK client tries first but not the one it falls
   back to.
2. **Signal listeners without re-raise** (what `auto-instrumentations-node`
   does). Rejected: turns SIGTERM into "maybe never exit".
3. **`process.exit(128 + n)` after flushing instead of re-raising.** Rejected:
   the parent sees a normal exit with code 143 rather than death by signal, and
   it overrides a host handler that wanted to keep running.
4. **Listen on stdin `end` ourselves.** Rejected: stdin is the transport's, and
   adding a listener can change flowing/paused behavior (v1's `close()` pauses
   stdin only when it's the sole `data` listener, `server/stdio.js:56-63`).
5. **Exported helper only.** See the table above; viable, and could be added
   later.
6. **Also hook `'exit'` with a synchronous best effort.** Rejected: OTLP export
   is async, so it would claim coverage it can't deliver.

## Tests (when implemented)

Each in a child process (`process.execPath` + fixture), asserting on exit
status/signal and on exporter output:

- `beforeExit`: buffered spans/metrics are exported; exit code preserved
  (`process.exitCode = 3` in the fixture → parent sees 3).
- `SIGTERM` / `SIGINT` (POSIX only; skipped on Windows with a reason): flushed,
  then the child dies by the same signal (`signal === 'SIGTERM'`).
- Host has its own SIGTERM listener: flushed, not re-raised; the host's
  handler decides.
- Timeout bound: an exporter that never resolves → process still terminates
  within `timeoutMs` + tolerance.
- Explicit `await server.shutdown()` then SIGTERM: provider shutdown runs
  exactly once (spy).
- Two instrumented servers in one process: one listener per signal; both
  flushed; still re-raised.
- `setupNodeSdk: false` + `flushOnExit: true`: no listeners added
  (`process.listenerCount` unchanged), one `diag.warn`.
- Never throws: a `shutdown` that throws synchronously, or a `process.on`
  that throws.

## Open questions for the maintainer

1. Default under `setupNodeSdk: true`: **on** (recommended) or **off** with the
   README showing `flushOnExit: true` explicitly?
2. Should `SIGINT` be included by default, or only `SIGTERM` + `beforeExit`?
   Ctrl+C in a terminal is a dev-time stop, but some hosts send SIGINT
   deliberately.
3. Default `timeoutMs` of 1000: fine, or shorter (e.g. 500) to leave more
   headroom inside the SDK client's 2 s windows?
4. Non-TypeScript MCP clients (Python SDK, Claude Desktop, IDE hosts) weren't
   verified here. Is it worth checking their stop sequence before choosing the
   default?
5. Add the `registerFlushOnExit()` helper for `setupNodeSdk: false` users now,
   or wait for demand?
