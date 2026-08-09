# ADR 014: Revert the `opentel-mcp-contract` extraction before publishing

**Status:** Decided and implemented. `packages/contract` is deleted; its
contents are back in `packages/core` as primary definitions.

## Context

Commit `ad6e4c2` ("refactor: extract observation contract into standalone
package") pulled the two-axis observation contract (ADR 008) — `TOOL_OUTCOME`,
`OBSERVATION_INTEGRITY`, five `mcp.tool.outcome`-family attribute constants,
and a new `SerializedSpan` type — out of `packages/core` into a new
package, `opentel-mcp-contract`, and flipped it from a private scaffold to
publishable. `packages/core` gained it as a real `dependencies` entry;
core's own re-exports of `ToolOutcome`/`ToolOutcomeCounts`/
`ObservationIntegrity`/`ObservationState` were marked `@deprecated` in
favor of importing from the new package directly.

This happened as Step 2 of an unattended multi-step run building out
`opentel-mcp-ui` (see `RUNLOG.md`), motivated by that UI: "so the emitter
(opentel-mcp) and any consumer (opentel-mcp-ui) import the exact same
definitions and can never quietly drift apart." No ADR was written for it
at the time — a gap against this project's own stated discipline
(`CONTRIBUTING.md`: "Non-trivial design decisions — anything that trades
off correctness, compatibility, or API shape — gets an Architecture
Decision Record"), and the original implementer's own `HANDOFF.md`
flagged real second-guessing about the area ("I'd ask upfront whether
[this]... rather than deciding it alone... it's a real public-API call").

Before `opentel-mcp-contract` was ever published, this ADR reassesses the
extraction directly, prompted by the observation that publishing it makes
it a *permanent* public package `opentel-mcp` would require forever —
its own versioning, breaking-change discipline, and release cadence — for
something extracted days earlier to serve a UI now scoped to local dev.

## Findings

**1. The payload is trivial.** 9 files, 348 lines, almost all docblock.
The actual content: 2 frozen runtime objects (`TOOL_OUTCOME`,
`OBSERVATION_INTEGRITY`, 3-4 lines each), 5 string constants
(`ERROR_TYPE_TOOL_ERROR`, `ATTR_MCP_TOOL_OUTCOME`, three
`MCP_TOOL_OUTCOME_*` values), and 5 type-only exports (`ToolOutcome`,
`ToolOutcomeCounts`, `ObservationIntegrity`, `ObservationState`,
`SerializedSpan`). `dependencies: {}` — zero runtime logic, zero imports
of its own.

**2. Core's usage was exactly what got moved out — nothing more.** Core
imported 6 of the 7 runtime values (everything except `TOOL_OUTCOME`,
which core never touches at all) plus 4 re-exported types. All of it was
moved out of core's own `attributes.js`/`observation/integrity.js` in the
original extraction — putting it back is reversing a copy, not writing
new code.

**3. Only two consumers exist, and one of them uses zero runtime
values.** Grepped the whole repo: only `packages/core` and `packages/ui`
ever referenced `opentel-mcp-contract`. `packages/ui`'s entire usage —
verified by reading every matching file, not just grepping for the
package name — is JSDoc-only type annotations
(`@typedef {import('opentel-mcp-contract').SerializedSpan}` and one
`ObservationState` reference), erased entirely at runtime. Not one
frozen constant or string value is ever imported as a value in
`packages/ui`. `serialize-span.js` even reads `attributes['error.type']`
as a raw string rather than importing `ERROR_TYPE_TOOL_ERROR` to compare
against it.

**4. The motivating risk (version drift) can't actually occur for the
one real consumer.** `packages/ui` is `"private": true` — never
published, always resolved to the exact workspace commit via npm
workspaces. There is no scenario where an independently-published
`opentel-mcp-ui` drifts against a newer `opentel-mcp`, because
`opentel-mcp-ui` is never independently published at all. The one place
shared object *identity* actually matters — core's own emission path
re-exporting the same object it detects/records — was already guaranteed
by both living in the same package before the extraction, and is
restored by undoing it.

**5. Publishing is a one-way door; not publishing isn't.** Once real
consumers install `opentel-mcp` and get `opentel-mcp-contract`
transitively, reversing the split becomes a breaking change requiring a
major-version bump and a deprecation cycle. It also imposes a permanent
release-ordering constraint: `opentel-mcp-contract` would need to publish
*before* every `opentel-mcp` release touching it, forever, for two
packages with exactly one real consumer of runtime values between them
(core itself). None of this has happened yet — `opentel-mcp-contract`
was never published (confirmed against the npm registry: 404).
Reconsidering now costs nothing a later reconsideration wouldn't cost
far more.

## Decision

**Revert the extraction.** Moved back into `packages/core`, as primary
definitions (not re-exports):

- `ERROR_TYPE_TOOL_ERROR`, `ATTR_MCP_TOOL_OUTCOME`,
  `MCP_TOOL_OUTCOME_SUCCESS`/`ERROR`/`SILENT_FAILURE` → `src/attributes.js`
- `OBSERVATION_INTEGRITY` → `src/observation/integrity.js`
- `ToolOutcome`, `ToolOutcomeCounts`, `ObservationIntegrity`,
  `ObservationState` → `src/observation/types.d.ts`
- `@deprecated` markers on the four types' root re-exports
  (`src/index.d.ts`) removed — they're primary again, not superseded by
  anything.
- `opentel-mcp-contract` removed from `packages/core/package.json`'s
  `dependencies`.
- `test/observation/contract-reexport.test.js` deleted — it existed
  solely to prove core's re-exports were reference-identical to
  contract's own; meaningless once there is nothing to re-export from.
  The compile-time equivalent in `test/index.exports.test-d.ts` removed
  for the same reason.

`SerializedSpan` moved into `packages/ui/src/types.d.ts` instead of back
into core — it was never core's type to begin with (core has, and had,
zero references to it; it is `opentel-mcp-ui`'s own SSE/wire-format
projection). `packages/ui`'s `ObservationState` reference now imports
from `opentel-mcp` directly (already available there, already
`peerDependencies`/`devDependencies` of `packages/ui`). `opentel-mcp-contract`
removed from `packages/ui/package.json`'s `dependencies` too.

**`packages/contract` is deleted, not left in the tree.** Considered
leaving it as an unpublished, workspace-member reference implementation
with a note recording the story — rejected: it would remain a live
workspace member (root `package.json`'s own description called it out:
"...its shared observation contract..."), meaning its own
`test`/`typecheck` scripts keep running, forever, for code nothing
imports — a real, ongoing cost, not a one-time one. It would also be the
only place in this repository where a past decision is recorded as
leftover code rather than in an ADR, CHANGELOG entry, or `known-gaps.md`
entry — every other reversed or superseded decision in this project's
history (e.g. ADR 010's schema-drift-only framing, superseded by ADR
012) is recorded in prose, not preserved as dead code alongside it. Git
history (`git log --all -- packages/contract`) already preserves the
literal artifact losslessly if anyone wants to see the exact shape
again — this ADR is the record; deleting the code doesn't lose it.

## Alternatives rejected

- **Publish both packages as originally planned.** Rejected — Finding 5:
  a permanent, one-way commitment (separate versioning, release
  ordering, breaking-change discipline forever) to serve a consumer
  (Finding 4) that structurally cannot benefit from the risk it would
  guard against.
- **Keep `opentel-mcp-contract` unpublished but as a real dependency via
  a workspace `file:`/`workspace:` protocol reference, never publishing
  it separately.** Not seriously considered: `packages/core` is the
  package that gets published, and `npm publish` resolves `dependencies`
  from the real registry — a workspace-only reference would break the
  very first external install. This is exactly the ordering problem
  Finding 5 already names.
- **Leave `packages/contract` in the tree, unpublished, with an
  explanatory note (the original plan for this ADR).** Rejected in favor
  of deletion — see Decision above for the reasoning; raised directly
  with the person who scoped this task, who agreed after hearing the
  ongoing-cost and "record decisions in ADRs, not dead code" arguments.

## Consequences

- `packages/core`'s public API surface (`src/index.d.ts`) is unchanged
  from a consumer's perspective: `ToolOutcome`, `ToolOutcomeCounts`,
  `ObservationIntegrity`, `ObservationState` are exported exactly as
  they were before `ad6e4c2`, no longer `@deprecated`. Nothing published
  ever carried the `opentel-mcp-contract` dependency (it was never
  published), so this is invisible history, not a breaking change for
  any real consumer.
- `packages/core/CHANGELOG.md`'s `## 0.9.0` entry no longer mentions the
  contract extraction at all — it was tried and reverted within the same
  unreleased cycle, so there is nothing for a reader upgrading to 0.9.0
  to know about.
- Root `package.json`'s `workspaces` array and description, root
  `README.md`'s package table, and `CONTRIBUTING.md`'s workspace list no
  longer mention `packages/contract`. `RUNLOG.md`/`HANDOFF.md` (the
  original run's own logs) are left untouched — they're a point-in-time
  record of what that run decided, not something this ADR rewrites;
  this ADR is the record of what changed since.
- **Condition for re-extracting, if it ever comes up again:** a second
  consumer that (a) is independently published (not `private: true`,
  not workspace-resolved) and (b) imports real runtime values — not just
  types — from the shared definitions. Under those two conditions
  together, the version-drift risk the original extraction was trying to
  prevent becomes real, and re-extracting would be justified. Neither
  condition holds today. If it happens, re-derive the shape fresh against
  whatever the new consumer actually needs rather than resurrecting this
  exact package — the requirements will be different by then.
