# Contributing to opentel-mcp

## Dev setup

```bash
npm install
npm test
```

This repo is an npm-workspaces monorepo (`packages/core`, `packages/ui`);
the published `opentel-mcp` library lives in `packages/core`.
Running `npm test`/`npm run typecheck`/etc. from the repo root delegates into
each workspace's own scripts. Pure JavaScript, ES modules, Node 20+ — no
build step in core. Edit `packages/core/src/` directly.

## Adding tests

Tests live in `packages/core/test/` and run with [Vitest](https://vitest.dev/).
Use `@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter` to assert on
emitted spans rather than mocking OTel internals — see
`packages/core/test/instrument.test.js` for the pattern (register a
test-scoped tracer provider in `beforeEach`, reset it in `afterEach`).

## Public API types

`packages/core/src/index.d.ts` (and the sibling `src/*/types.d.ts` files it
re-exports) are hand-written, not compiler-generated — this project has no
TypeScript build step, so nothing keeps them in sync with `resolveOptions()`
(`src/config.js`) automatically. `npm run typecheck` (`tsc --noEmit`,
config in `packages/core/tsconfig.json`) type-checks those `.d.ts` files plus
any `test/**/*.test-d.ts` type-level tests — see
`packages/core/test/index.exports.test-d.ts` for the pattern (`expectTypeOf` /
`@ts-expect-error`). It does not check the `.js` source itself
(`checkJs: false`); that's out of scope for this narrow setup. When you
add a new `instrumentMcpServer()` option in `config.js`, add it to
`index.d.ts` too and run `npm run typecheck` — nothing else will catch a
mismatch.

## ADR discipline

Non-trivial design decisions — anything that trades off correctness,
compatibility, or API shape — gets an Architecture Decision Record under
`docs/adr/`, numbered sequentially. Look at `001-wrapping-strategy.md` and
`002-instrument-first-detection.md` for the expected format (Context,
Decision, Constraints accepted, Alternatives rejected, Consequences).

## Release checklist

Run these in order — each step assumes the previous one passed:

1. `npm test`
2. `npm run typecheck` — type-checks `src/**/*.d.ts` against the repo tree
   directly (see "Public API types" above).
3. `npm run verify:tarball` — packs the tarball, installs it into a clean
   project *outside* this repo, and imports every value and type export
   parsed from `src/index.d.ts` under `tsc --strict`, plus a runtime import
   to confirm the package actually loads. This exists because step 2 can't
   catch a public export that's re-exported from a `.js` file with no
   matching `.d.ts` — nothing forces that check through the tarball's
   `files` allowlist and package.json `exports` the way a real consumer's
   install does. That exact gap shipped in v0.6.0 (TS7016 on `import {
   computeFingerprint } from 'opentel-mcp'` for any strict consumer),
   fixed in v0.6.1. Also wired into `prepublishOnly`, so `npm publish`
   fails closed on this — but run it manually here so a broken release
   doesn't burn a publish attempt.
4. `npm version <patch|minor|major>`
5. `git push --tags`
6. `npm publish`

## PR checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes if you touched `src/config.js`, any `src/*/types.d.ts`, or `src/index.d.ts`
- [ ] New behavior has test coverage
- [ ] A new ADR was added if the change involves a non-trivial design
      decision (see above)
- [ ] No new dependencies without discussion first — this project targets
      zero native dependencies and a minimal, audited dependency tree

Issues and PRs welcome.
