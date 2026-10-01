# ADR 022: Publish `opentel-mcp-ui`

**Status:** Proposed — design only, no implementation.

**Supersedes:** ADR 014's Finding 4 (`docs/adr/014-revert-contract-extraction.md`),
which assumed `opentel-mcp-ui` would never be independently published. See
"Which premise this supersedes" below for why that assumption no longer
holds and what, narrowly, changes as a result.

## Context

v0.15.0 ("Make it visible") exists because a recent audit found this
library has real depth — 12 metrics, fingerprinting, thrash detection,
schema drift, the two-axis observation contract — that almost nobody
installing it ever sees. `opentel-mcp-ui` (`packages/ui`) is the one
asset in this repo that could show it, and it already works: built
(`vite build` → a single 208.8kB self-contained `dist/index.html`,
confirmed via a real build), with a `bin` entry
(`./bin/opentel-mcp-ui.js`) that already starts a server, seeds 60
demo spans with `--demo`, and serves a working dashboard — verified by
running it, not by reading the code and assuming. It has been sitting
behind `"private": true` since it was built, and `HANDOFF.md` records
that nobody ever looked at it rendered. It is currently unreachable
from the core README — grepped, zero mentions.

### Step 0 investigation: what's actually there

**Demo mode, run and inspected directly:**

```
opentel-mcp-ui: dashboard listening at http://localhost:4411
opentel-mcp-ui: seeded 60 demo spans -- no live MCP server needed.
```

Three panels render against the 60-span fixture
(`src/demo-fixture.js`): an observation matrix (SUCCESS/FAILURE ×
VISIBLE/MISSED-by-OTel, 42/0/7/11 — matches the fixture exactly), a
silent-failure feed defaulting to the `failureMissed` cell (the actual
product pitch: `isError: true` inside a 200, which a plain OTel setup
renders as a clean span), and a detector banner.

**The detector banner is broken for this specific mode.** `--demo`
passes `instrumentedServer: null` (`bin/opentel-mcp-ui.js`), so
`meta.js`'s `inspectTransport(null)` reports `shape: 'undeterminable'`
and all four trackers show `status: 'unknown'`, each with text written
for a *live* server that hasn't connected yet: *"Re-check /api/meta
after the server connects, or pass statelessTransport: true/false..."*
In demo mode there is no server and never will be one. A first-time
visitor's first screen is four near-identical paragraphs of advice they
cannot act on, plus a completeness line underneath saying the same
thing a fifth way. This is the concrete "confusing to a new user" the
audit was looking for, found by actually looking rather than
inferring it from the code.

**A second, non-blocking bug, found incidentally:** `demo-fixture.js`'s
`makeSpan()` sets `argumentCount` from one counter
(`idCounter % 4`) and the co-located `attributes['mcp.tool.argument_count']`
from a different one (`i % 3`) — the two fields disagree in every demo
span (confirmed: span 1 reports `argumentCount: 3` but
`attributes['mcp.tool.argument_count']: 1`). Harmless today — grepped
`web/`, nothing renders `argumentCount` — so this is dead-but-wrong
fixture data, not a visible defect. Tracked as a follow-up, not fixed
here: it doesn't block a first impression, and this release's phase
scope is "fix what blocks a first impression."

**Packaging, checked directly:**

- `npm view opentel-mcp-ui` → `404` — the name is free.
- `package.json` already has a correct `bin` entry, and the file it
  points to is already executable with the right shebang
  (`#!/usr/bin/env node`) — confirmed via `ls -la` and running it.
- `files: ["src", "bin", "dist"]` is already minimal and correct — no
  trimming needed.
- `dependencies: {}` — zero runtime dependencies.
- `peerDependencies: { "opentel-mcp": ">=0.8.0 <1.0.0", "@opentelemetry/api": "^1.9.0" }`
  — the `<1.0.0` ceiling is a real, if not urgent, problem: core is at
  0.14.0 today, and this ceiling will start rejecting valid installs
  the moment core crosses 1.0.
- `devDependencies` pins `opentel-mcp@^0.9.0`, stale against core's
  actual 0.14.0 — harmless in this repo because npm workspaces
  symlinks `node_modules/opentel-mcp -> ../packages/core` regardless
  of the semver string (confirmed: the resolved package.json reports
  `0.14.0`), but worth correcting as housekeeping.
- **No `README.md`, no `LICENSE` exist in `packages/ui/` at all** —
  confirmed via `ls`. npm auto-includes both in a published tarball
  once they exist, regardless of the `files` field; today there's
  nothing for it to include.
- `npm pack --dry-run`: 17 files, 84.3kB packed / 267.2kB unpacked. No
  README/LICENSE in the listing, consistent with the point above.
- A real `npx <tarball>` round-trip was flaky in this investigation's
  sandbox specifically (silent early exits across several attempts —
  consistent with this environment's constraints on backgrounded
  npm/npx cache writes, not a package defect). Extracting the packed
  tarball and running `bin/opentel-mcp-ui.js` directly against its
  declared peer dependencies resolved exactly as a real
  `npm install opentel-mcp-ui` would resolve them gave a clean,
  conclusive result instead: server starts, `/api/meta` and `/` both
  return 200, demo fixture seeds correctly. The artifact itself is
  sound.

### Which premise this supersedes

ADR 014's Finding 4, verbatim:

> "`packages/ui` is `"private": true` — never published, always
> resolved to the exact workspace commit via npm workspaces. There is
> no scenario where an independently-published `opentel-mcp-ui` drifts
> against a newer `opentel-mcp`, because `opentel-mcp-ui` is never
> independently published at all."

That sentence is the thing this ADR makes false, deliberately. It was
correct when written — `opentel-mcp-contract`'s extraction was reverted
in part *because* of it (packages/ui had exactly one real consumer, a
workspace member, so a shared-package version-drift risk didn't exist
for it). Publishing introduces exactly the scenario Finding 4 says
doesn't exist: a user's already-installed `opentel-mcp-ui` can now be
older than, newer than, or simply different from whatever `opentel-mcp`
version they also have installed, resolved independently by whatever
their package manager decides, not pinned to one workspace commit.

This ADR does not reopen ADR 014's actual decision (reverting the
`opentel-mcp-contract` package extraction) — that stays reverted; this
is narrower, about `packages/ui` specifically crossing from
private-workspace-member to independently-published, and the one
consequence of ADR 014 that was reasoned from the "never published"
premise rather than from the extraction question itself.

One finding from ADR 014 makes the consequence of superseding it
smaller than it could have been. Finding 3, also verbatim and reverified
here: *"Not one frozen constant or string value is ever imported as a
value in `packages/ui`... `serialize-span.js` even reads
`attributes['error.type']` as a raw string rather than importing
`ERROR_TYPE_TOOL_ERROR`."* Confirmed still true (`src/serialize-span.js`,
`NAMED_ATTRIBUTE_KEYS` — a plain `Set` of string literals, not an
import from core). The UI has zero compile-time coupling to core's
exports. That means version skew can't manifest as a broken build; it
can only manifest as a data-shape question at runtime — exactly the
question this ADR's Decision section below has to settle, since ADR 014
never had to.

## Decision

Publish `opentel-mcp-ui@0.1.0` to npm, under its own name, as an
independent package — not merged into `opentel-mcp` core, not gated
behind a core release.

### Version-skew policy: the UI must degrade, never crash, on attribute shapes it doesn't recognize

The UI ingests spans two ways (`withUI()` in-process, and the
standalone OTLP/HTTP JSON receiver `bin/opentel-mcp-ui.js` starts) —
both ultimately go through `serialize-span.js`'s
`spanFieldsFromAttributes()`, which maps exactly five named attribute
keys (`gen_ai.tool.name`, `error.type`, `mcp.failure.category`,
`mcp.failure.channel`, `mcp.tool.argument_count`) onto named
`SerializedSpan` fields and puts everything else into a passthrough
`attributes` bag, unconditionally, with no allowlist and no throw on an
unrecognized key.

This is already the right shape for forward-compat, and this ADR
makes the resulting policy explicit rather than leaving it as an
unstated side effect of how the function happens to be written:

- **A newer core emitting an attribute this UI version doesn't know
  about:** falls into the passthrough bag, is never read by any panel,
  renders nothing new, breaks nothing. No code change needed to
  guarantee this — it's already true by construction, because
  `spanFieldsFromAttributes()` has no "unknown key" error path at all.
- **A newer core renaming or removing one of the five named keys:**
  the corresponding `SerializedSpan` field is simply absent (`undefined`,
  never `null` or a thrown lookup error) for every span from that core
  version. The matrix and feed already handle a missing/absent field as
  "doesn't count toward that classification" (`classify.ts`'s
  `classifySpan()` treats anything that isn't exactly
  `errorType === 'tool_error'` as not-silently-failed) — degraded
  signal, not a crash, and not new code to write, but a property this
  ADR requires stay true under future review: any change to
  `spanFieldsFromAttributes()` must keep every lookup optional-chained
  or equivalent, never an assumed-present field access.
- **A core version old enough to predate a UI feature** (e.g. a
  pre-schema-drift core talking to a UI that expects
  `mcp.tool.schema_drift.*`): same mechanism — absent keys, not errors.
  The detector banner already has a vocabulary for "can't tell" via its
  `'unknown'` status (`meta.js`), which is the right place to eventually
  surface "this core version predates a signal this UI knows how to
  show" as a specific reason string, rather than the generic transport-
  undeterminable one — tracked as a follow-up (see "Not in scope"), not
  required for 0.1.0.

**Peer range.** Keep `opentel-mcp: ">=0.8.0 <1.0.0"` for this release
— 0.8.0 is where `getObservationState()` first existed, which `meta.js`
depends on when a real `instrumentedServer` is present. The `<1.0.0`
ceiling is accepted as a known, deliberate limitation for this release,
not fixed here: this library's `0.x` series is where attribute/shape
changes are still permitted without a major bump (`README`'s "Semantic
conventions" section says exactly this about the spec it tracks), so a
UI version genuinely might need updating across an arbitrary `0.x → 0.y`
bump. Widening the ceiling to also accept `1.x` is deferred to whenever
core actually approaches 1.0 and the two projects can agree on what
"stable" means for both — manufacturing that answer now, for a version
that doesn't exist yet, isn't worth doing in this release.

**`@opentelemetry/api` peer range** stays `^1.9.0`, unchanged — this
package depends on the API only (never a concrete SDK), same posture
core itself takes (ADR 005), so it carries no additional skew risk
beyond what already exists between any two `@opentelemetry/api`
consumers.

### What the CLI exposes

`npx opentel-mcp-ui [--demo] [--port=<n>] [--open] [--stateless|--stateful] [--help]`
— `--demo`, `--port` (default 4319), `--open`, `--stateless`/`--stateful`
already exist and already work (`bin/opentel-mcp-ui.js`, verified by
running each). `--help` does not exist yet — added in the implementation
phase as part of making this a real CLI entry point, printing the flag
list above plus the two endpoints below. No new flags beyond `--help`
are introduced by this ADR; the CLI's behavior is unchanged, only its
publication status is.

Defaults, unchanged: port `4319`; binds to `localhost`, not `0.0.0.0`
(confirmed in `server.js` — `createHttpServer`'s `listen()` call passes
no host override, and Node's default bind for `http.createServer` is
all interfaces *unless* a host is given — this is flagged as a gap to
close in the implementation phase, not something already correct; see
"What the UI must never do" below); OTLP/HTTP JSON trace receiver at
`POST <url>/v1/traces` — the same path/wire-format `exporterUrl` already
targets in every documented core example, nothing new introduced here.

### What the UI must never do

- **Never phone home.** No telemetry, no update check, no outbound
  request of any kind beyond what the user's own instrumented server
  sends it. Confirmed by reading `server.js`, `with-ui.js`, and
  `bin/opentel-mcp-ui.js` in full: none exists today; this ADR commits
  to it staying that way as a publish-time invariant, not just an
  accident of what hasn't been built yet.
- **Never persist data outside the local process.** The span buffer
  (`span-buffer.js`) is an in-memory bounded ring buffer; nothing is
  written to disk. This stays true after publishing — no "save my
  session" feature, no local database, in this release.
- **Never bind to `0.0.0.0` by default.** Per the note above, this is
  not yet verified as true — Node's default host for `http.Server.listen(port)`
  with no host argument is all interfaces, not `localhost`. This is a
  real, if low-severity, issue to fix in the implementation phase
  (explicit `listen(port, '127.0.0.1', ...)` or equivalent), not
  something this ADR can claim is already handled. Flagged here as a
  requirement of publishing, not a confirmed existing property — a
  locally-run dashboard that defaults to listening on every interface
  is a materially different risk once this package is something a
  stranger might `npx` on a shared or untrusted network.

### Never-throw at startup

Per this release's hard constraint, nothing added for publishing may
crash the process in a way that isn't already how the CLI fails today.
The existing `--demo`/`--stateless`/`--stateful`/`--port` parsing
(`parseArgs()`, `bin/opentel-mcp-ui.js`) already silently accepts
unrecognized flags without erroring; `--help` (new) and any argument-
validation added for it must degrade the same way — an unparseable
`--port` value, for instance, should warn and fall back to the default,
never throw past `main()`. This governs the CLI's own argument handling
only; it has no interaction with the tool-call hot path this release
explicitly does not touch.

### Initial version and release process

`opentel-mcp-ui@0.1.0` — the version already in `package.json`, kept
as-is rather than bumped preemptively; "first published version is
0.1.0, not 1.0.0" needs no new decision, it's what's already there.
Published independently of core's own release cadence: no core version
bump is required to publish this, and no future UI release requires a
simultaneous core release unless the UI adds a feature that needs a
newer core (checked against the peer range above at that time, same as
any other peer-dependency bump).

## Constraints accepted

- **Permanent published-package maintenance.** Same cost class ADR 014
  weighed for `opentel-mcp-contract` and rejected for a package with one
  consumer — accepted here because `opentel-mcp-ui` is not that
  package: it has its own distinct value (a dashboard someone runs),
  not a shared-types indirection with nothing of its own to offer.
- **Version-skew is now a real, if currently low-risk, condition** —
  accepted per the degrade policy above, not eliminated. A pathological
  future core change (e.g. repurposing `error.type: 'tool_error'` to
  mean something else, or renaming `mcp.tool.argument_count`) could
  still silently misclassify data in an old UI rather than erroring
  loudly — the `METRIC_SAFE_ATTRIBUTES` discipline this codebase applies
  to metric labels has no equivalent "don't rename a key a downstream
  consumer keys off of" discipline for span attributes today. Not
  solved here; worth a known-gaps entry.
- **The `<1.0.0` peer ceiling will eventually need revisiting** —
  accepted as this release's scope boundary, not fixed.

## Alternatives rejected

**Keep it private, ship only the Grafana/SigNoz dashboards instead.**
Rejected: the Grafana dashboard requires a Prometheus-scraped
`MeterProvider` already wired up — exactly the setup burden Phase 2 of
this same release exists to remove from the quickstart. `opentel-mcp-ui`'s
whole differentiator, per ADR 013's own finding, is that it needs
*nothing* standing up first. Publishing the thing that needs no backend
and leaving unpublished the thing that does is the wrong one to gate.

**Merge `opentel-mcp-ui` into `opentel-mcp` core as a subpath export**
(e.g. `opentel-mcp/ui`). Rejected: forces every core install to carry
React/Vite-built assets whether or not the installer wants a dashboard,
and ties the UI's release cadence to core's — exactly the
release-ordering cost ADR 014 Finding 5 already argued against for
`opentel-mcp-contract`, for the same reason (two independent concerns
sharing one version number buys nothing here either).

**Wait for a core 1.0 before publishing**, to avoid the peer-ceiling
problem entirely. Rejected: core 1.0 isn't scheduled, the audit this
release responds to found a real discovery gap today, and a published-
but-conservatively-ranged UI is strictly better than an unpublished one
while waiting for a milestone with no timeline.

## Consequences

- `opentel-mcp-ui` becomes a real, independent npm dependency surface
  with its own issues, its own version history, and its own install
  footprint (84.3kB packed, confirmed) — reachable via
  `npx opentel-mcp-ui --demo` from a clean machine once implemented.
- The core README gains a legitimate reason to point at it near the
  top, closing the "someone reading the npm page has no idea this
  exists" gap the audit raised.
- `0.1.0`'s detector-banner wording problem in `--demo` mode (Step 0
  above) must be fixed before publishing, since it is this release's
  first and most direct "first impression" failure — scoped into this
  phase's implementation step, not deferred.
- The `argumentCount`/`mcp.tool.argument_count` fixture mismatch, the
  `<1.0.0` peer ceiling, the stale `devDependencies` pin, and a
  core-version-aware reason string for the detector banner are tracked
  as follow-ups, not blockers, per the findings above.
