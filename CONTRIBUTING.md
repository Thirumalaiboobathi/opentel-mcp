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

## ADR discipline

Non-trivial design decisions — anything that trades off correctness,
compatibility, or API shape — gets an Architecture Decision Record under
`docs/adr/`, numbered sequentially. Look at `001-wrapping-strategy.md` and
`002-instrument-first-detection.md` for the expected format (Context,
Decision, Constraints accepted, Alternatives rejected, Consequences).

## PR checklist

- [ ] `npm test` passes
- [ ] New behavior has test coverage
- [ ] A new ADR was added if the change involves a non-trivial design
      decision (see above)
- [ ] No new dependencies without discussion first — this project targets
      zero native dependencies and a minimal, audited dependency tree

Issues and PRs welcome.
