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

**Step 6 — publishing itself — happens in CI, not on your machine.**
`.github/workflows/release.yml` triggers on the `vX.Y.Z` tag `npm version`
just created and pushed, re-runs steps 1-3 as a safety net (a tag pushed
without the checklist above must not reach npm just because someone meant
to run these first), then runs `npm publish --workspace=packages/core
--provenance`. Watch the "Release" run in the Actions tab; nothing more to
do locally. This moved out of your hands specifically so the published
package carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
— a signed attestation tying the published tarball to the exact commit and
CI run that built it, visible on the npm package page — which npm can only
generate inside a supported CI provider's OIDC context, never from a local
`npm publish`.

**One-time setup, before the first tag-triggered release works:** generate
an [npm automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
for this package and add it as the `NPM_TOKEN` secret in this repo's
GitHub Actions settings (Settings → Secrets and variables → Actions). The
workflow's `id-token: write` permission is what provenance itself needs;
`NPM_TOKEN` is the separate, still-required credential that authenticates
the publish — provenance doesn't replace it.

## Dependency updates

`.github/dependabot.yml` configures Dependabot **version updates** —
scheduled pull requests bumping `package.json`/`package-lock.json` (npm,
one entry covering the whole workspace) and the pinned action versions in
`.github/workflows/*.yml` (github-actions). Weekly, grouped
dev-dependency bumps, and `@opentelemetry/*`/`@modelcontextprotocol/*`
majors excluded from the schedule (see that file's own comments for the
full reasoning).

**This does not enable Dependabot alerts** — the separate, always-on
background scanning that flags dependencies with known vulnerabilities
(CVEs) via GitHub's advisory database. Alerts are a repository setting,
not something a `dependabot.yml` file turns on: **Settings → Code
security → Dependabot alerts**, toggle it on manually (and "Dependabot
security updates" alongside it, if you also want an automatic PR opened
per alert — that one bypasses this file's `open-pull-requests-limit`
entirely, per GitHub's own docs: security-update PRs have a separate,
non-configurable cap). Neither is enabled by adding this file.

## PR checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes if you touched `src/config.js`, any `src/*/types.d.ts`, or `src/index.d.ts`
- [ ] New behavior has test coverage
- [ ] A new ADR was added if the change involves a non-trivial design
      decision (see above)
- [ ] No new dependencies without discussion first — this project targets
      zero native dependencies and a minimal, audited dependency tree

Issues and PRs welcome.
