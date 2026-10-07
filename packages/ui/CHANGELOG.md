# Changelog

## Unreleased

### Added

- **Connect screen.** Without `--demo`, a dashboard that hasn't received
  any spans yet now shows "Connect your server" instead of an empty
  page: this instance's OTLP/HTTP endpoint (`<origin>/v1/traces`), the
  exact `instrumentMcpServer(server, { serviceName, setupNodeSdk: true,
  exporterUrl })` snippet to point a server at it, and a "Waiting for
  spans…" state. It switches to the live dashboard on the first span,
  over the existing SSE stream, with no reload. `--demo` never shows it.

## 0.1.1

First-impression fixes found while preparing a demo recording of the
published 0.1.0 release.

### Fixed

- `npx opentel-mcp-ui` (and any install through `node_modules/.bin`)
  started no server and exited silently with no output, because the main-
  module guard (`bin/opentel-mcp-ui.js`) compared `import.meta.url`
  (which always resolves through symlinks) against the raw, un-resolved
  `process.argv[1]` — the `.bin` symlink path itself. The two could never
  match. Now resolved through `fs.realpathSync()` on both sides before
  comparing. `scripts/verify-tarball.js` now runs the packed tarball's
  bin through its installed `node_modules/.bin` symlink (exactly what
  `npx` resolves and executes) rather than the target file's real path
  directly, so this class of regression fails the release gate instead of
  shipping unnoticed; proved against the old code before committing the
  fix.
- `--demo` mode reported all four in-memory trackers (thrash, cost/budget,
  schema drift, ToolOutcome) as `'unknown'`, and the dashboard showed four
  near-identical warning paragraphs telling the user to pass
  `statelessTransport` to `withUI()` — advice that doesn't apply to a demo
  with no server at all. `describeInMemoryTrackerAvailability()`
  (`src/meta.js`) now reports `'live'` for demo mode (the fixture data
  already stands in for live detector output), and `DetectorBanner`
  collapses to one small "Demo data" badge. Outside demo mode, detectors
  that share the exact same reason (the common case) are now collapsed
  into one notice naming all of them, instead of repeating the same
  sentence once per detector.
- The completeness line below the observation matrix
  (`web/data/completeness.ts`) read as backend jargon to a first-time
  user ("session-oriented transport, thrash/budget/schema drift/tool
  outcome tracker state unconfirmed"). Replaced with plain language
  inline; the technical detail (and the `withUI()` hint) moved to a
  `title` tooltip via a new `detail` field, not deleted.
- Each silent-failure feed row's "Standard OTel would show" / "opentel-mcp
  detected" comparison cards clipped at the bottom and overlapped the
  next row's content at every width this was actually checked at,
  including plain desktop widths with no text wrapping involved.
  `VirtualizedList` gives each row a fixed-height, absolutely positioned
  slot; the feed's `ROW_HEIGHT` constant (96px) was shorter than that
  content needed, so overflow bled into the next row's slot.
  `SilentFailureFeed.tsx` now sizes rows per viewport width (116px
  desktop, 184px below a 560px breakpoint), and `SilentFailureFeed.css`
  stacks the two comparison cards into one column below that same
  breakpoint, where side-by-side columns would otherwise leave too little
  width for the pill text to stay on one line. Checked at 1280/1440/1920
  and a ~400px mobile width, light and dark.

### Added

- A hero stat above the detector banner: "`<missed>` of `<total
  failures>` failures were invisible to standard OTel (`<percent>`%)",
  computed from the exact same `MatrixCounts` the observation matrix
  renders (`computeHeroStat()`, `web/data/classify.ts`) so it can never
  drift from the grid below it. Zero failures shows a neutral message,
  never a `NaN%`/`Infinity` divide-by-zero.

## 0.1.0

First published release (ADR 022,
`docs/adr/022-publish-ui.md` in the main repo). This package existed as a
working, `"private": true` scaffold before this release — these entries
cover what changed to make it publishable, not a rebuild from scratch.

### Fixed

- The detector status banner and completeness line showed text written
  for a real server that "hasn't connected yet" (e.g. *"Re-check
  /api/meta after the server connects..."*) even in `--demo` mode, where
  there is no server and never will be one. `describeInMemoryTrackerAvailability()`
  (`src/meta.js`) and `computeCompleteness()` (`web/data/completeness.ts`)
  now short-circuit to demo-specific wording when the standalone CLI's
  own `--demo` flag is set. Scoped narrowly to that flag, not to
  `instrumentedServer` being absent in general: the standalone CLI's
  non-demo mode also runs with no in-process server reference (it only
  ever receives spans over its OTLP/HTTP receiver), and in that case the
  original "re-check after it connects" wording is exactly right — a
  real remote server may just not have started sending yet.
- `server.listen()` (`bin/opentel-mcp-ui.js`, `src/with-ui.js`) now binds
  explicitly to `127.0.0.1`. Previously relied on Node's default host for
  `.listen(port)` with no host argument, which is all interfaces, not
  loopback — the wrong default for something a stranger might `npx` on a
  shared network, now that this is a published, no-auth dashboard. No
  `--host` override: this is a committed default, not a configurable
  convenience.
- An unparseable `--port` value (`bin/opentel-mcp-ui.js`) crashed with
  `ERR_SOCKET_BAD_PORT` instead of degrading. Now warns to stderr and
  falls back to the default (4319), matching this release's
  never-throw-at-startup posture.

### Added

- `--help` / `-h` flag: prints usage and starts no server.
- `/api/meta` now reports a `demo: boolean` field, reflecting the
  standalone CLI's own `--demo` flag — additive to the response shape,
  never breaking an older UI reading a newer core's meta endpoint or vice
  versa (there is no coupling between the two for this field at all; it
  originates and is consumed entirely within this package).
- `README.md` and `LICENSE` (MIT, matching `opentel-mcp` core) — this
  package shipped with neither before being published.

### Changed

- `private: true` removed; published to npm for the first time.
- `peerDependencies.opentel-mcp` stays `>=0.8.0 <1.0.0` — the `<1.0.0`
  ceiling is a known, accepted limitation for this release (see ADR 022),
  not addressed here.
- `devDependencies.opentel-mcp` bumped from `^0.9.0` to `^0.14.0` to match
  the currently-published core version this package was actually
  developed and tested against (npm workspaces already resolved the real
  `0.14.0` regardless of this string — housekeeping, not a behavior
  change).
- `files` now explicitly lists `README.md`, `CHANGELOG.md`, `LICENSE`
  alongside the existing `src`, `bin`, `dist`.

### Known follow-ups (not fixed in this release)

- `demo-fixture.js`'s `makeSpan()` sets `argumentCount` and
  `attributes['mcp.tool.argument_count']` from two different counters,
  so they disagree on every fixture span. Currently invisible — nothing
  in `web/` renders `argumentCount` — so this is tracked, not fixed.
- The `<1.0.0` peer ceiling on `opentel-mcp` will need revisiting before
  core reaches 1.0.
- No core-version-aware reason string exists yet for "this core version
  predates a signal this UI knows how to show" — today that case reads
  identically to any other `'unknown'` detector status.
