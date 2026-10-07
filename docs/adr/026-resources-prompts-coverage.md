# ADR 026: Instrumenting `resources/*` and `prompts/*`

**Status:** Proposed — awaiting approval. Investigation and design only; nothing in this ADR is implemented.

## Context

Core instruments `tools/call` (spans, metrics, fingerprinting, thrash, cost,
silent failures) and `tools/list` (schema drift, ADR 010). Five other
server-side methods are untraced: `resources/read`, `resources/list`,
`resources/templates/list`, `prompts/get`, `prompts/list`. An agent that
fails to read a resource or render a prompt leaves no trace today.

## Step 0 findings

### How `tools/call` / `tools/list` wrapping works today

- **Patch `setRequestHandler`, wrap on registration** (ADR 001).
  `instrumentMcpServer()` binds the original (`instrument.js:556`) and
  replaces `server.setRequestHandler`:
  - v1: compares the schema object by identity against
    `CallToolRequestSchema` / `ListToolsRequestSchema` (`instrument.js:569-603`)
  - v2: compares the method-name string, 2-arg form only; the 3-arg
    custom-method overload passes through untouched (`instrument.js:623-659`)
  
  Matching handlers are wrapped by `wrapToolCallHandler()`
  (`instrument.js:1697`) or `wrapToolsListHandler()` (`instrument.js:1963`)
  before the original `setRequestHandler` stores them.
- **Span shape** (ADR 004): kind `SERVER`, `mcp.method.name` set from
  constants (`instrument.js:1757`, `:1975`), name `{method} {target}` falling
  back to the method alone (`instrument.js:1604-1606`).
- **Instrument-first** (ADR 002): because wrapping happens at registration,
  a handler registered *before* `instrumentMcpServer()` is never wrapped.
  `assertInstrumentFirst()` (`instrument.js:688`) calls the SDK's
  `assertCanSetRequestHandler(method)` and throws `INSTRUMENT_FIRST_ERROR`
  (`instrument.js:209-214`) if a `tools/call` handler exists, and also a
  `tools/list` handler when schema drift is enabled.

### What broke in ADR 010

ADR 010 extended the instrument-first check to `tools/list` and shipped with
`schemaDrift.enabled` defaulting to `true`. Low-level `Server` users who had
registered `ListToolsRequestSchema` before calling `instrumentMcpServer()`
had never seen an error. After upgrading, they got `INSTRUMENT_FIRST_ERROR`
with no code change of their own (`packages/core/CHANGELOG.md:786-799`, which
documents the migration: reorder, or `schemaDrift: { enabled: false }`).
`McpServer` users were unaffected because McpServer registers `tools/list`
and `tools/call` together.

**Lesson: a new default-on wrapped method plus a throw-on-misorder is a
breaking change for whoever registered that method first.**

### Where resource/prompt handlers get registered, and when

| SDK | Class | When `resources/*` handlers are registered | Source |
| --- | --- | --- | --- |
| v1 1.32.1 | low-level `Server` | whenever the user calls `setRequestHandler` | user code |
| v1 1.32.1 | `McpServer` | lazily, on the first `resource()`/`registerResource()` | `sdk/dist/esm/server/mcp.js:376` (`setResourceRequestHandlers`), called at `:503, :512, :523, :532` |
| v1 1.32.1 | `McpServer` | prompts: lazily, on the first `prompt()`/`registerPrompt()` | `mcp.js:441` (`setPromptRequestHandlers`), called at `:764, :777` |
| v2 2.3.1 | `McpServer` | **eagerly, in the constructor**, when `capabilities.resources` / `capabilities.prompts` are declared; otherwise lazily | `@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs:1692-1698`; lazy at `:1962, :1969, :2160` |

Each lazy setup calls `assertCanSetRequestHandler()` for its methods first
(`mcp.js:380-382, 445-446`).

**The v2 eager path makes strict instrument-first impossible.**
`instrumentMcpServer()` takes the already-constructed McpServer, so if the
constructor declared `capabilities.resources`, the handlers already exist and
no call ordering can fix it.

**Related pre-existing finding (not caused by this ADR):** the same eager
path applies to `capabilities.tools` (`mcp-DIH4cS6P.mjs:1695`). Verified
empirically on 2.3.1: `new McpServer(info, { capabilities: { tools: {} } })`
followed by `instrumentMcpServer(server, {})` **throws
`INSTRUMENT_FIRST_ERROR` today**. The constructor code is identical in 2.0.0
(`mcp-DXXb3Vv3.mjs:1349-1350`). This is a separate bug (see Open questions);
nothing here depends on fixing it, but the design below must not copy it.

### Why "just wrap the existing handler" isn't available

`Protocol` keeps handlers in the private `_requestHandlers` map
(`sdk/dist/esm/shared/protocol.js:917`). The public surface is
`setRequestHandler`, `removeRequestHandler` (`:925-927`) and
`assertCanSetRequestHandler` (`:931-935`). There's no public getter, so an
already-registered handler can't be read back and re-wrapped without the
private map, which ADR 001/002 reject.

## Decision (proposed)

### Ordering: detect-and-skip, never throw (recommended)

At `instrumentMcpServer()` time, for each of the five methods independently:

- `assertCanSetRequestHandler(method)` succeeds → the method is wrapped when
  it's registered later, through the same `setRequestHandler` patch.
- It throws (already registered) → **skip that method**, and emit one
  `diag.warn` per server naming the skipped methods and the fix ("call
  `instrumentMcpServer()` before registering resources/prompts; on v2
  `McpServer`, don't declare `capabilities.resources`/`prompts` in the
  constructor — registering a resource/prompt declares them for you").
- `assertCanSetRequestHandler` missing (future SDK) → wrap whatever is
  registered afterwards, no warning (ADR 002's fallback).

The existing `tools/call` / `tools/list` throw is **unchanged** by this ADR.

| Option | Upgrade risk | Coverage |
| --- | --- | --- |
| Throw on misorder (ADR 002 style) | **Breaks** v1 users who registered resources first, and **every** v2 McpServer declaring `capabilities.resources` | full where it doesn't throw |
| Opt-in flag only, still throwing | breakage only for those who opt in | full for opt-in users |
| **Detect-and-skip + `diag.warn`** | **none** | everything registered after instrument |
| Read `_requestHandlers` and re-wrap | none | full, coupled to private SDK internals (rejected in ADR 001/002) |
| Patch McpServer's public `registerResource`/`registerPrompt` to wrap callbacks | none | per-resource/prompt callbacks only; can't cover the list methods; v1/v2 callback signatures differ |

The last row is a real "better" option for `resources/read` and `prompts/get`
on `McpServer`, and it sidesteps the v2 eager problem. It's listed as an Open
question rather than recommended, because it adds a second wrapping layer
with its own per-SDK surface.

### Rollout: opt-in in 0.16, default-on later (recommended)

```ts
instrumentMcpServer(server, { coverage: { resources: true, prompts: true } });
```

Off by default in 0.16.0. New spans on a production backend are a volume and
cost change that users should choose. Even with detect-and-skip, flipping
this default silently is the same kind of surprise ADR 010 caused. Plan to
flip the default in a later minor release with a CHANGELOG "behavior change"
note, once the UI handles the new spans (below).

### Span names and attributes

| Method | Span name | Attributes |
| --- | --- | --- |
| `resources/list` | `resources/list` | `mcp.method.name` |
| `resources/templates/list` | `resources/templates/list` | `mcp.method.name` |
| `resources/read` | `resources/read` | `mcp.method.name` |
| `prompts/list` | `prompts/list` | `mcp.method.name` |
| `prompts/get` | `prompts/get {prompt name}` | `mcp.method.name`, `gen_ai.prompt.name` |

- Kind `SERVER`, status `ERROR` + `error.type` on a thrown handler, same as
  `tools/call`'s thrown branch.
- **`gen_ai.tool.name` is absent** (never set, not `""`) on all five. Health
  grades and per-tool views key on it, so absence keeps these spans out of
  per-tool math.
- **The resource URI is not captured, in the span name or as an attribute.**
  URIs are request arguments: they routinely embed file paths, user ids and
  query strings. This follows the "never capture argument values" rule, even
  though the MCP semantic conventions define `mcp.resource.uri`. Open question
  whether to offer it behind an explicit opt-in.
- **Prompt name** is a developer-registered identifier, the same class of
  value as a tool name (ADR 021), so it's acceptable on spans. **Prompt
  arguments are never captured.**
- No result-content attributes. Optional later: a derived count
  (`mcp.resource.contents_count`), no text.

### Which machinery applies

| Machinery | Applies? | Notes |
| --- | --- | --- |
| Fingerprinting + category (ADR 006) | **yes, thrown errors only** | `computeFingerprint(err, { toolName: undefined, origin: 'thrown', cwd })`. The hash's tool slot is empty, so the same error from `resources/read` and `prompts/get` would collide; see Open questions. |
| Channel (ADR 007) | **yes** | an unknown resource is a JSON-RPC error; whether `classifyFailureChannel()` maps the SDK's resource-not-found code to `protocol.not_found` needs verifying before relying on it |
| Silent failure / `isError` | **no** | resources and prompts have no `isError` result field |
| Duration | **yes, new instrument** | `mcp.tool.duration` is per-tool by name and label, so reusing it would be wrong. Proposed `mcp.server.operation.duration` histogram, labels `mcp.method.name` (+ `error.type` on failure) only |
| Thrash detection (v0.6.0; ADR 009, 018) | **no** | repeated `resources/read` is normal caching/refresh behavior, not a retry loop |
| Cost / budget | **no** | no token usage on these methods |
| Schema drift (ADR 010) | **no** (out of scope) | `prompts/list` argument drift is a possible follow-up |
| ToolOutcome / observation state (ADR 008) | **no** | tool-only by definition |

### Metric impact

- **No new label keys.** The proposed histogram uses `mcp.method.name` (already
  in `METRIC_SAFE_ATTRIBUTES`, `src/attributes.js:279-285`) and `error.type`
  (already listed).
- **`mcp.method.name` stays bounded.** Its values come from five string
  constants added beside `MCP_METHOD_NAME_TOOLS_CALL` / `…_TOOLS_LIST`
  (`src/attributes.js:73-77`), **never** from `request.method`. The value space
  grows from 2 to 7, fixed.
- **`gen_ai.prompt.name` is not a metric label** in this release (span-only),
  so ADR 021's tool-name cardinality reasoning doesn't need extending yet.
- The ADR 021 cross-check (`test/metrics.test.js:262`) must be extended to
  scan the new call site's file; that's part of the implementation, not an
  exception to it.

### UI impact (must ship with or before the core change)

`opentel-mcp-ui`'s `summarizeBufferedSpans()` buckets **every** buffered span
into success / error / silentFailure (`packages/ui/src/summary.js:31-37`), and
the matrix and hero stat read those counts. Resource and prompt spans would
inflate "success" and "error" today. Before (or with) this core change, the UI
must:

- count only `mcp.method.name === 'tools/call'` spans in the matrix, hero stat
  and silent-failure feed;
- add per-method views for the new spans (call counts, error rate, p95), and a
  prompt-name breakdown for `prompts/get`;
- add demo fixtures for each new method.

## Tests (when implemented)

For each of the five methods × {SDK v1, SDK v2} × {low-level `Server`,
`McpServer`}:

- registered **after** instrument → one span, correct name, `mcp.method.name`,
  **no** `gen_ai.tool.name` key, status/`error.type` on throw;
- registered **before** instrument → `instrumentMcpServer()` doesn't throw,
  method not wrapped, exactly one `diag.warn` naming it;
- v2 `McpServer` with `capabilities: { resources: {}, prompts: {} }` → no
  throw, warn, tools still instrumented;
- `coverage` off (default) → no new spans, `setRequestHandler` behavior
  byte-for-byte unchanged;
- privacy: URIs and prompt arguments containing canaries never appear in any
  exported span or metric;
- metrics: `mcp.method.name` values ⊆ the seven constants; ADR 021
  cross-check passes with the new file in scope;
- never throws: handler throws, returns garbage, returns a rejected promise.

## Alternatives considered

1. **Default-on with throw** (ADR 010 pattern). Rejected: repeats the ADR 010
   breakage, and on v2 can't be satisfied at all.
2. **Default-on with detect-and-skip.** Viable, but changes span volume for
   everyone on upgrade. Deferred to a later release.
3. **Reading `_requestHandlers`.** Rejected by ADR 001/002.
4. **Patching `McpServer.registerResource`/`registerPrompt`.** Not rejected;
   see Open questions.
5. **Capture `mcp.resource.uri` per semconv.** Rejected by default on privacy
   grounds.

## Open questions for the maintainer

1. Opt-in in 0.16 (recommended) or default-on with detect-and-skip?
2. Should 0.16 *also* fix the pre-existing v2 `capabilities.tools` throw?
   It's arguably a bug today, and the same detect-and-skip (or callback-patch)
   approach could apply to `tools/call`. It's a behavior change to the
   existing check, so it needs its own decision.
3. Add the `McpServer` callback-patching layer for `resources/read` /
   `prompts/get`, which covers the v2 eager case, or accept "not covered,
   warned" for those users?
4. Fingerprint hash input for non-tool spans: leave the tool slot empty
   (proposed), or put the method name there (changes nothing for existing
   tool fingerprints but needs a documented convention)?
5. `mcp.resource.uri` behind an explicit opt-in, or never?
6. New `mcp.server.operation.duration` histogram in this release, or spans
   only first?
