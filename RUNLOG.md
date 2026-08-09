# RUNLOG

Running log for the unattended Steps 2–5 run (UI project). One section per
step: what was done, what was decided, what should be reviewed. Read this
first; see HANDOFF.md for the end-of-run summary and any halted work.

## Step 2 — Extract the contract package

**Status: done, all acceptance criteria met.**

### What moved

New package `packages/contract` (`opentel-mcp-contract@0.1.0`, flipped from
private scaffold to publishable):

- `TOOL_OUTCOME` — new frozen runtime object for `ToolOutcome` (didn't exist
  as a runtime value before; only the TS type existed). `{SUCCESS, FAILURE,
  UNKNOWN}`.
- `OBSERVATION_INTEGRITY` — moved verbatim (same frozen object) from core's
  `src/observation/integrity.js`. The *detection logic*
  (`detectObservationIntegrity()`, which needs `@opentelemetry/api`) stayed
  in core — contract has zero runtime dependencies, so anything requiring an
  OTel import couldn't move.
- `ATTR_MCP_TOOL_OUTCOME`, `MCP_TOOL_OUTCOME_SUCCESS`, `MCP_TOOL_OUTCOME_ERROR`,
  `MCP_TOOL_OUTCOME_SILENT_FAILURE`, `ERROR_TYPE_TOOL_ERROR` — moved verbatim
  from core's `src/attributes.js`.
- `SerializedSpan` — new type, didn't exist before. See "on SerializedSpan"
  below — this needed real design work, not just a move.

Core's `src/attributes.js`, `src/observation/integrity.js`, and
`src/observation/types.d.ts` now **import these from `opentel-mcp-contract`
and re-export under the exact same names**, so no other file in core (or
its tests) needed to change a single import path. `packages/core/package.json`
gained `"opentel-mcp-contract": "^0.1.0"` as a real `dependencies` entry
(not dev, not peer — core genuinely depends on it at runtime now).

### Decisions I made that you should look at

1. **Core's public root surface (`src/index.js`/`index.d.ts`) was NOT
   expanded with the new runtime values.** `ToolOutcome`/`ToolOutcomeCounts`/
   `ObservationIntegrity`/`ObservationState` were always type-only exports
   at the package root — that's unchanged, now marked `@deprecated` (see
   below), pointing at `opentel-mcp-contract`. I deliberately did **not**
   also add `TOOL_OUTCOME`/`OBSERVATION_INTEGRITY`/the attribute constants
   as new root-level runtime exports of `opentel-mcp` itself — a consumer
   who wants those imports `opentel-mcp-contract` directly. This felt like
   the more disciplined reading of "additive from the consumer's view": add
   nothing that wasn't asked for to core's public surface. Reconsider if you
   want core to also carry these for convenience.
2. **Core bumped 0.8.0 → 0.9.0 (minor).** Not explicitly instructed, but
   this project's own CHANGELOG/ADR012 convention is a minor bump for every
   additive capability (v0.6.0 thrash, v0.7.0 channel-aware, v0.8.0 schema
   drift). A brand-new runtime `dependencies` entry felt minor-worthy, not
   patch-worthy. I did **not** touch `packages/core/CHANGELOG.md` — flagging
   that as a follow-up, not doing it silently under "unattended."
3. **`@deprecated` tags had to be four separate single-line
   `export type { X } from '...'` statements**, not one grouped
   `export { type A, type B } from ...` with per-specifier JSDoc. The
   grouped form is valid TypeScript, but it broke
   `scripts/verify-tarball.js`'s plain-text export parser (it doesn't strip
   comments, so the JSDoc text got parsed as part of an export name). I
   fixed the *usage* to match the existing tool rather than modifying the
   tool's regex — didn't want to weaken a real release gate to accommodate
   my own formatting choice.
4. **`scripts/verify-tarball.js` needed a real fix, not a workaround.**
   Once core had a genuine workspace dependency, the script's existing
   design (pack core, `npm install` the tarball into a project *outside*
   the repo) tried to fetch `opentel-mcp-contract` from the real npm
   registry and 404'd — it isn't published there yet. I added
   `findLocalWorkspaceDependencyDirs()`, which packs any `dependencies`
   entry that resolves to a sibling `packages/*` workspace too, and
   installs all the tarballs together in one `npm install` call (Node's
   module resolution is filesystem-based for flat top-level
   `node_modules` entries, so this is a faithful reproduction of what a
   real consumer's install will look like once both are published, not a
   workaround). This also caught a real bug on the first attempt: my new
   `.d.ts` files declared only the *types*, not the runtime `const` values
   their same-named `.js` files export — exactly the TS7016 bug class this
   script exists to catch (see CONTRIBUTING.md's v0.6.0 story). Fixed by
   adding the value declarations to `tool-outcome.d.ts`/
   `observation-integrity.d.ts` and writing a new `attributes.d.ts`,
   matching the existing `cost/pricing.d.ts` pattern.
5. **On `SerializedSpan` (new type, `packages/contract/src/span.d.ts`):**
   I did NOT give it an `observationIntegrity` field, and documented why at
   length in the type's own docblock. Re-reading ADR 008 in full before
   writing this: `ObservationIntegrity` is explicitly a property of the
   *whole instrumented process* ("is the OTel pipeline wired up"),
   re-evaluated on demand — never a per-call/per-span value. There is no
   mechanism anywhere in core's emission that varies it per span, and
   every `SerializedSpan` a consumer ever receives is, by construction,
   one that was successfully captured (tautologically "observed"). I flag
   this prominently now because **Step 5's observation matrix (5a) asks
   for a per-span crosstab against this exact axis, which this finding
   says can't be built faithfully** — see the Step 5 entry below and
   HANDOFF.md.
   For the per-span "is this the kind of failure standard OTel would also
   show" concept 5b needs, use `errorType === 'tool_error'`
   (`ERROR_TYPE_TOOL_ERROR`) — that's a real, per-span, ADR-faithful
   discriminator (confirmed by reading `instrument.js`'s two failure
   branches directly: the silent-failure branch sets `error.type` to
   literally `'tool_error'`; the thrown branch sets it to `err.name`).

### Verification

- `npm run typecheck` — clean across all three workspaces.
- `npm test` — 642 passed, 6 skipped (was 636/6 before this step; the 6
  new tests are `test/observation/contract-reexport.test.js`, added per
  the acceptance criteria — reference-identity (`toBe`, not `toEqual`)
  checks proving core's re-exports are the literal same object as
  contract's, not a second copy).
- `test/index.exports.test-d.ts` extended with `expectTypeOf` equality
  checks between core's re-exported types and `opentel-mcp-contract`'s own.
- `npm run verify:tarball` — passes end to end against the real fix above.
- **Tarball comparison vs published 0.8.0:** file list is **byte-identical**
  — still exactly 58 files, same paths (the new dependency lives in its
  own, separate tarball; nothing added or removed from core's own file
  list). Content deltas, all expected: `package.json` (version 0.8.0 →
  0.9.0, new `opentel-mcp-contract` dependency), `src/attributes.js`,
  `src/observation/integrity.js`, `src/observation/types.d.ts`, and
  `src/index.d.ts` (re-exports now routed through contract, `@deprecated`
  tags added). No other file in the tarball changed.

Commit: `refactor: extract observation contract into standalone package`

## Step 3 — UI backend (span buffer + local telemetry server)

**Status: done, all acceptance criteria met — but the in-process
integration mode ships a materially different mechanism than originally
specified, found and corrected mid-step. Read "The architecture
correction" below; it's the important part of this entry.**

### What shipped, in packages/ui/src/

- `span-buffer.js` — `SpanBuffer`, a fixed-capacity ring buffer (default
  1000, configurable), O(1) push, oldest-evicted-first, bounded memory
  under sustained load (tested to 10,000 pushes against capacity 10).
- `serialize-span.js` — converts a real OTel `ReadableSpan` into
  `SerializedSpan` (opentel-mcp-contract). `spanFieldsFromAttributes()` is
  factored out so the OTLP JSON path (below) shares the exact same
  attribute-to-field mapping, not a second hand-maintained copy.
- `collector-span-processor.js` — `CollectorSpanProcessor`, a real
  `@opentelemetry/sdk-trace` `SpanProcessor` implementation. Filters to
  `tools/call`-shaped spans (excludes `tools/list`/schema-drift spans).
  Exposes both `onEnd()` (the SpanProcessor interface) and
  `ingestSerializedSpan()` (a direct path used by the OTLP receiver and by
  tests).
- `otlp-json-receiver.js` — decodes a REAL OTLP/HTTP JSON
  `ExportTraceServiceRequest` body into `SerializedSpan[]`. Verified
  against the actual wire format opentel-mcp core's own
  `@opentelemetry/exporter-trace-otlp-http` dependency sends (read its
  installed source directly: `JsonTraceSerializer`, hex-encoded ids,
  decimal-string nanosecond timestamps) — not guessed.
- `meta.js` — `describeInMemoryTrackerAvailability()` (generic over which
  tracker; ADR 012 names all four in-memory trackers, not just thrash) and
  `inspectTransport()` (the same structural transport-shape check core's
  own internal `isSingleConnectionTransport()` uses). See "On the
  transport-detection honesty boundary" below.
- `summary.js` — `/api/summary`'s two clearly-separated buckets:
  `observationState` (core's own cumulative bookkeeping, verbatim) and
  `buffered` (real per-span counts from the current ring buffer window).
  Deliberately NOT a fabricated 2x2 grid — see "On /api/summary's shape"
  below, which foreshadows Step 5's blocker.
- `server.js` — `node:http` only, no framework. Routes: `GET /`,
  `GET /api/spans` (SSE, with `Last-Event-ID`/`?lastEventId=` reconnect
  replay from the buffer), `GET /api/spans/history`, `GET /api/summary`,
  `GET /api/meta`, `POST /v1/traces` (OTLP/HTTP JSON receiver — see the
  architecture correction below for why this exists on EVERY server this
  module creates, not just the standalone CLI's).
- `with-ui.js` — `withUI(instrumentedServer, options)`.
- `open-browser.js` — cross-platform browser opener via
  `child_process.spawn` of the OS's own `open`/`start`/`xdg-open`, not an
  npm dependency.
- `bin/opentel-mcp-ui.js` — the standalone `npx opentel-mcp-ui` CLI.

### The architecture correction (read this one)

The original design (mine, from the brief's "ingests via the existing
core hook") assumed `withUI()` could dynamically attach a `SpanProcessor`
to whatever `TracerProvider` was ALREADY registered, via a
`provider.addSpanProcessor()`-style call — the classic older OTel SDK
pattern. **I wrote this, then wrote `withUI()`'s own test for it, and the
test failed.** Investigating why (rather than adjusting the test to pass)
found: verified directly against the installed `@opentelemetry/sdk-trace@2.9.0`
(reading `TracerProvider.js`'s actual source, not assumed), `TracerProvider`
builds one `MultiSpanProcessor` from `options.spanProcessors` at
construction time and stores it in a private field (`_activeSpanProcessor`).
**There is no public method to add a processor after construction in this
SDK version.** I could have reached into that private field
(`provider._activeSpanProcessor._spanProcessors.push(...)`) and it would
have worked at runtime — I did not do this, because it's exactly the
"coupling to unstable SDK internals" this project's own ADRs (001, 008)
already reject as a pattern, and doing it quietly to make a test pass
would have been indistinguishable from the "about to write `any` to get
past a type error" halt condition in spirit, even though it's not
literally that.

**Corrected design:** every server this package creates (both integration
modes) exposes `POST /v1/traces`, a real OTLP/HTTP JSON receiver. This is
"the existing core hook" honored literally, just not the hook I first
assumed: `instrumentMcpServer(server, { setupNodeSdk: true, exporterUrl:
'<dashboard url>/v1/traces' })` already sends spans there TODAY, using
opentel-mcp core's own, already-shipping `@opentelemetry/exporter-trace-otlp-http`
dependency — zero core changes, not a new emission path, and it's the
literal `exporterUrl` option that's been in `InstrumentOptions` since
long before this project started. `withUI()` STILL attempts the dynamic
`addSpanProcessor` path as a real, tested best-effort bonus (proven
correct against a hand-built fake provider in
`test/with-ui.test.js` — it's not dead code, it would fire for a
host-authored custom `TracerProvider`, or a future OTel SDK version, that
does expose it), but the dashboard's actual, tested, reliable ingestion
path in both modes is OTLP.

I'm flagging this as something you should look at, not something I'm
fully confident reads naturally against the ORIGINAL usage example in the
brief (`withUI(instrumentedServer, { port: 4319, open: true })` implying
zero additional configuration). With the correction, that call alone
starts a fully functional dashboard server, but it will not receive
spans until the host EITHER (a) has a custom TracerProvider supporting
dynamic attach (rare), or (b) also sets `exporterUrl` on their
`instrumentMcpServer()` call to point at it. (b) is one extra config
line, clearly logged via `diag.warn` the moment `withUI()` can't attach
dynamically, but it is a real deviation from "one function call, no other
changes" — worth deciding whether the README should lead with this as the
primary documented flow (which I'd recommend) rather than a fallback.

### On the transport-detection honesty boundary

ADR 012 is explicit that the fresh-`Server`-per-request problem is about
a *usage pattern*, not a transport *class* — a long-lived
`StreamableHTTPServerTransport` serving many sessions has no such
problem. `withUI()` only ever sees ONE server object at one point in
time; it cannot observe whether other server objects are being
constructed and discarded elsewhere in the host's process. So
`describeInMemoryTrackerAvailability()`'s auto-detection deliberately
returns `'unknown'` (not `'unavailable'`) for a session-oriented
transport — correlated risk, not confirmed unavailability — and only
returns a confident `'unavailable'`/`'live'` when the host explicitly
passes `statelessTransport: true/false` (mirroring
`thrashDetection.assumeSingleSession`'s own "operator assertion beats
silent guessing" precedent). The Step 3 brief's exact banner copy
("Thrash detection unavailable — stateless HTTP transport...") is used
verbatim ONLY in the explicit-assertion case; the auto-detected
session-oriented case uses different, hedged wording ("may be
unavailable... doesn't confirm..."). I chose accuracy over matching the
brief's copy exactly here — flagging in case you'd rather the softer
"unknown" case still be worded to feel more like the punchier example
copy for the dashboard banner (Step 5c can restyle the TEXT without
changing the underlying `status` values).

Also generalized past thrash detection alone: ADR 012 names all four
in-memory trackers (thrash, cost/budget, schema drift, ToolOutcome
counting) as sharing the identical root cause, so `/api/meta` reports on
all four, not just thrash.

### On /api/summary's shape (foreshadowing Step 5)

Kept `observationState` (core's real `ToolOutcomeCounts` + single
`ObservationIntegrity` value) and `buffered` (real per-span counts from
the ring buffer) as two separate, honestly-labeled objects rather than
inventing a combined 2x2 grid. This is deliberate, not an oversight: see
the Step 2 entry above and the Step 5 entry below for why a literal
`ToolOutcome x ObservationIntegrity` per-span crosstab can't be built
faithfully from what core actually emits.

### Other decisions worth a look

- `opentel-mcp-contract` is listed as a real `dependencies` entry for
  `opentel-mcp-ui`, even though nothing in this step's `.js` files imports
  a runtime value from it yet (only a type-only import in `index.d.ts`).
  Judgment call: the finished dashboard will need `TOOL_OUTCOME`/
  `OBSERVATION_INTEGRITY` at runtime for rendering (Step 5), so declaring
  it once now rather than re-adding it per step seemed more honest about
  the package's actual, near-term shape.
- Added `"./package.json": "./package.json"` to **opentel-mcp core's**
  `exports` map (mirrors the same addition already made to
  `opentel-mcp-contract` in Step 2) so `/api/meta` can report a REAL
  `coreVersion` instead of a permanent `'unknown'`. This is the one touch
  to core in this step — purely additive (a common, standard convention;
  no existing behavior changed), needed so `/api/meta` doesn't have to
  lie by omission about the one piece of information it's supposed to
  report honestly. Re-verified the tarball comparison after this change;
  still clean.
- The `SpanBuffer.size` bug the eviction tests actually caught: `size`
  was originally derived from the lifetime `totalPushed` counter, so
  calling `clear()` didn't reset `size` to 0 (only `toArray()` emptied).
  Fixed by tracking `pushedSinceClear` separately from the lifetime
  `totalPushed` (the latter is kept, deliberately, as the stable basis
  for SSE sequence numbers, which must never reset). Caught by the
  acceptance criterion's own "buffer eviction" test requirement doing its
  job.

### Verification

- `npm test` (root): core 642/6 (unchanged), ui 61/0 (new).
- `npm run typecheck`: clean across all three workspaces.
- Manual end-to-end smoke test of the standalone CLI: started it, sent it
  a REAL OTLP/HTTP JSON payload (built via
  `@opentelemetry/otlp-transformer`'s own `JsonTraceSerializer`, the exact
  code opentel-mcp core's exporter uses), confirmed it landed in
  `/api/spans/history` and `coreVersion` resolved correctly via the new
  `exports` entry.
- `npm run verify:tarball`: still passes after the core `exports` change.

