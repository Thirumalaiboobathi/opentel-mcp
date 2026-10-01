# Changelog

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
