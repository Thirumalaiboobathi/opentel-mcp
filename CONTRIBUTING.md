# Contributing to opentel-mcp

## Dev setup

```bash
npm install
npm test
```

Pure JavaScript, ES modules, Node 20+ — no build step. Edit `src/` directly.

## Adding tests

Tests live in `test/` and run with [Vitest](https://vitest.dev/). Use
`@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter` to assert on
emitted spans rather than mocking OTel internals — see
`test/instrument.test.js` for the pattern (register a test-scoped tracer
provider in `beforeEach`, reset it in `afterEach`).

## Public API types

`src/index.d.ts` (and the sibling `src/*/types.d.ts` files it re-exports)
are hand-written, not compiler-generated — this project has no TypeScript
build step, so nothing keeps them in sync with `resolveOptions()`
(`src/config.js`) automatically. `npm run typecheck` (`tsc --noEmit`,
config in `tsconfig.json`) type-checks those `.d.ts` files plus any
`test/**/*.test-d.ts` type-level tests — see
`test/index.exports.test-d.ts` for the pattern (`expectTypeOf` /
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

## PR checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes if you touched `src/config.js`, any `src/*/types.d.ts`, or `src/index.d.ts`
- [ ] New behavior has test coverage
- [ ] A new ADR was added if the change involves a non-trivial design
      decision (see above)
- [ ] No new dependencies without discussion first — this project targets
      zero native dependencies and a minimal, audited dependency tree

Issues and PRs welcome.
