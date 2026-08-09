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

