# ADR 015: MCP v2 (stateless spec) support — design

**Status:** Proposed — design only, no implementation. This is the Phase 0
investigation for v0.10.0+, written against `@modelcontextprotocol/server@2.0.0`
and `@modelcontextprotocol/client@2.0.0` (protocol revision 2026-07-28)
installed in a scratch directory, never added as a dependency of
`packages/core`. Findings below are marked **[verified live]** where they
were confirmed by constructing real instances and running real code against
the installed v2 package, not just reading `.d.mts` type declarations —
that distinction matters for a couple of the findings below, which read one
way from the types and a different way once actually run.

## Context

`@modelcontextprotocol/server@2.0.0` is a new, separate npm package from
`@modelcontextprotocol/sdk@1.30.0` (the package `packages/core` currently
instruments via a peer dependency). It implements MCP protocol revision
2026-07-28, whose headline change — per the [MCP blog's 2026-07-28
announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) — is
removing the `initialize`/`notifications/initialized` handshake and the
`Mcp-Session-Id` Streamable HTTP header: every request becomes
self-contained, and a new `server/discover` RPC replaces version
negotiation. `@modelcontextprotocol/sdk@1.x` is not deprecated by this —
it continues to implement the 2025-06-18 (and earlier) protocol revisions —
so this is an *additional* SDK to support, not a replacement.

Six design questions had to be answered against the real, installed v2
package before any implementation could be scoped, plus one heuristic in
today's v0.9.0 code (`isSingleConnectionTransport()`, ADR 006) that needed
checking against v2's actual transport classes rather than assumed to still
hold.

## Decision

### 1. ADR 001's patching strategy ports directly — with a *more* stable anchor

`@modelcontextprotocol/server@2.0.0` still exports `Server`, `McpServer`,
and an abstract `Protocol` base class under the same names as
`@modelcontextprotocol/sdk`. `Protocol` still declares
`setRequestHandler(method, handler)` and `assertCanSetRequestHandler(method)`
as public, non-underscore-prefixed methods; `Server extends Protocol` and
`McpServer.server` is still a public `Server` instance that
`.registerTool()` lazily calls `setRequestHandler('tools/call', ...)` on —
structurally identical to v1's "no hook, only this one method" situation
that ADR 001 was written against.

What changed is *how* a `tools/call` registration is recognized. In v1,
`setRequestHandler`'s spec-method overload takes a schema object
(`CallToolRequestSchema`, imported from `@modelcontextprotocol/sdk/types.js`)
as its second argument, and ADR 001 anchors on reference equality against
that constant. In v2, the same overload takes the method name **directly
as a string** — `setRequestHandler(method: 'tools/call', handler)` — and
`CallToolRequestSchema` itself still exists, but only inside
`@modelcontextprotocol/core/internal`, a subpath whose name says plainly
that it isn't meant for third-party consumption (**[verified live]**:
importable at runtime, but not re-exported from `@modelcontextprotocol/server`'s
public `index.mjs` at all — confirmed by `grep`ping the compiled bundle).

Decision: for v2, anchor on `method === 'tools/call'` (a plain string
comparison) instead of schema-object identity. This is not a workaround —
it is *more* stable than v1's mechanism, because it requires no import of
an internal/unstable module at all; the string `'tools/call'` is the wire
method name itself, unlikely to ever change independently of the whole
protocol being renamed. **[Verified live]**: patched `setRequestHandler` on
both a low-level `Server` and an `McpServer`'s inner `.server`, then called
`server.setRequestHandler('tools/call', handler)` directly and
`mcpServer.registerTool(...)` — both land in the patch with
`method === "tools/call"`, exactly as needed.

`assertCanSetRequestHandler('tools/call')` behaves identically to v1
(**[verified live]**: no-op before registration, throws after) — ADR 002's
detection mechanism needs no change for v2 beyond being invoked on the
right object.

### 2. Per-request factory model — a documentation change, not a new mechanism

`createMcpHandler(factory, options)` and `serveStdio(factory, options)`
both take a `McpServerFactory = (ctx) => McpServer | Server` invoked fresh
per serving unit: one HTTP request under `createMcpHandler` (including
modern-era requests, under its default `legacy: 'stateless'` posture — not
just the legacy-compat fallback), or one connection under `serveStdio`.
There is no more "construct one long-lived `Server`, instrument it once at
process start" pattern for the HTTP entry point the SDK itself now
recommends — `instrumentMcpServer()` must be called *inside* the factory,
before `.registerTool()`/`.tool()` calls run for that instance, on every
invocation.

This is not a new problem for this package. **ADR 012 already found and
scoped the identical root cause**, discovered independently against a v1
"stateless Streamable HTTP" deployment shape — a fresh `Server` constructed
per incoming HTTP POST, re-instrumented each time — months before v2
existed. ADR 012's `instanceKey` option (share the four trackers —
`budgetTracker`, `thrashDetector`, `toolOutcomeCounter`,
`schemaDriftDetector` — across repeated `instrumentMcpServer()` calls that
pass the same key, via the process-wide `InstanceRegistry`) is already the
right mechanism for v2's factory model; v2 just makes this deployment shape
the *default*, SDK-blessed pattern instead of a workaround some hosts
happened to build. **Decision: no new tracker-sharing mechanism is needed.**
The work here is documentation — the README's "Ordering constraint" section
and the `instanceKey` option's own docs need a v2-specific example showing
`instrumentMcpServer(server, { instanceKey: 'my-server' })` called inside
the factory passed to `createMcpHandler`/`serveStdio`.

One gap ADR 012 didn't need to address, because it wasn't yet the SDK's own
pattern, is covered under Finding 3 below: `instanceKey` shares the
*trackers*, but not the thrash fallback session id, and v2's factory model
is where that distinction starts to matter.

### 3. `sessionId` — correcting the framing

`sessionId` is **not removed from the SDK type**. `BaseContext.sessionId?:
string` (v2's `ctx` argument) is still a real, optional field — what's
removed at the *wire* level is the `Mcp-Session-Id` HTTP header and the
`initialize` handshake under the new stateless posture, not the field
itself. Under `createMcpHandler`'s default stateless mode, `sessionId` is
simply *usually undefined* — the same shape stdio has always had in v1,
which `resolveThrashSessionId()` (`instrument.js`) already exists
specifically to handle via its per-connection fallback UUID
(`thrashConnectionFallbackSessionId`) and `assumeSingleSession` opt-in.

Honest accounting of what this means for Agent Thrash Detection under v2's
*default* deployment shape: the fallback mechanism activates the same way
it does for stdio today, **but with one difference that matters under the
per-request factory model from Finding 2.** `thrashConnectionFallbackSessionId`
is generated with a plain `randomUUID()` call local to each
`instrumentMcpServer()` invocation (`instrument.js:300`) — it is *not*
looked up through `getOrCreateTracker()`/`instanceRegistry`, unlike the
four trackers ADR 012 covers. Under v1's long-lived-server deployment
(instrument once, serve many requests), one `instrumentMcpServer()` call
generates one fallback UUID for the connection's whole lifetime, so
repeated failures on that connection correctly accumulate under the same
key. Under v2's per-request factory model, even with `instanceKey` set so
the *detector* is shared across requests, each request's own
`instrumentMcpServer()` call still mints its *own* fresh fallback UUID —
so if a caller enables `assumeSingleSession` (or the transport happens to
misclassify as single-connection, see Finding 8) expecting thrash detection
to work across a stateless deployment's repeated calls from the same
logical client, it will not: every request looks like a different
"session" to the shared detector, and consecutive-failure loops can never
be observed. **This is a real gap, not yet designed away** — flagged here
rather than silently carried into implementation. A fix would need the
fallback id itself to be resolvable through the same `instanceKey`-keyed
registry the trackers already use (i.e., "no real session id, but caller
told us via `instanceKey` this is one logical connection" — one stable id
per `instanceKey`, not one random id per call), which is a design change
to `instrument.js`, not just documentation. Scoped as follow-up work in
Phase 3 below, not resolved by this ADR.

### 4. `channel.js` — the wrapper is gone; recovery is still needed, but simpler

`ProtocolError`'s constructor calls `super(message)` directly with no
`"MCP error ${code}: "` wrapping (**[verified live]**: `err.message` is
the raw message, `err.code` is a real, directly-readable numeric property,
`String(err)` is `"ProtocolError: <raw message>"`). `channel.js`'s
`recoverDisguisedProtocolFailure()` — whose entire mechanism is matching
that exact wrapper prefix out of `content[0].text` via
`MCP_ERROR_WRAPPER_RE` — can never match v2 output; that regex has nothing
left to match against.

But the disguise behavior itself also changed, not just its formatting.
v1's `channel.js` docblock (confirmed against a real v1 `McpServer`)
states McpServer disguises tool-not-found, tool-disabled, input validation,
*and* output validation into `isError: true`. **[Verified live against
v2]**: `McpServer`'s `tools/call` handler throws "not found"/"disabled"
**outside** its try/catch (`mcp-DXXb3Vv3.mjs:1396-1397` in the installed
package) — they reach the wire as real, thrown `ProtocolError`s, not
disguised. Only input/output validation errors (raised inside
`validateToolInput`/`validateToolOutput`, called *inside* the try block)
get caught and converted to `isError: true`. Confirmed by directly invoking
the captured `tools/call` handler: a nonexistent-tool call threw a real
`ProtocolError` (`code: -32602`, clean message, not caught); a bad-argument
call returned `{ isError: true, content: [{ text: "Input validation
error: ..." }] }`.

This changes what recovery needs to do, and simplifies it. v2's
`ProtocolErrorCode` uses `-32602` (`InvalidParams`) uniformly for
not-found, disabled, *and* both validation failures — there is no numeric
code differentiating them even in the un-disguised, thrown case; message
content is the only signal `classifyInvalidParams()` has ever used to tell
them apart (v1 worked the same way for the thrown branch — this isn't new).
Since v2 no longer disguises not-found/disabled at all, and the two cases
it *does* disguise (input/output validation) are each uniquely identified
by their own marker string (`"Input validation error:"` /
`"Output validation error:"`, confirmed byte-identical to v1's markers —
`mcp-DXXb3Vv3.mjs:1432`, `:1444`), **the recovery path no longer needs to
recover a numeric code at all.** For v2, `recoverDisguisedProtocolFailure()`
collapses to: read `content[0].text`, check for the two marker strings
directly, return `'protocol.input'`/`'protocol.output'` on a match, `null`
(fall through to `'execution'`) otherwise — no regex-unwrap step, no code
needed, no not-found/disabled branch (nothing to recover there anymore).

Decision: **keep the recovery path — it's still needed, since McpServer
still disguises validation errors — but implement it as a v2-specific,
marker-only variant, not a patch to the existing wrapper regex.** The
un-disguised (thrown) branch of `classifyFailureChannel()` needs no v2
change at all: it already reads `.code`/`.message` directly off the
failure object without ever depending on the wrapper, so it works
unmodified against v2's clean `ProtocolError` shape.

### 5. `validation-paths.js` — a third, more stable format; both existing branches stay

**[Verified live]**: a v2 input-validation disguised failure's
`content[0].text` is:

```
Input validation error: Invalid arguments for tool strict: n: Invalid input: expected number, received string, email: Invalid email address
```

Traced to `formatIssue(issue)` / `validateStandardSchema()`
(`src-CX2iR2pK.mjs:5339-5353` in the installed package):
`` `${path.join('.')}: ${message}` ``, multiple issues joined by `", "` — a
third rendering, distinct from both formats `extractValidationPaths()`
already handles (the ≤1.29 JSON-issues-array, and the 1.30+ `"<message> at
<path>"` newline-joined format). Path comes *first*, separated by `: `,
joined by `, `, all on one line.

The important structural difference: this format comes from
`validateStandardSchema()` operating over the generic [Standard
Schema](https://standardschema.dev) `~standard.validate()` interface, not
from Zod-specific error rendering. v1's two existing formats are both
downstream of Zod's own `getParseErrorMessage()`/`ZodError` rendering,
which is why `validation-paths.js`'s docblock already flags them as
fragile — coupled to a specific library's internal formatting choices,
which has already changed once (1.29 → 1.30) and could change again on
any future Zod bump. v2's format is defined by `@modelcontextprotocol/server`
itself (`formatIssue()` is package code, not re-exported Zod formatting),
and is schema-library-agnostic by construction — it will render the same
way whether a v2 tool author uses Zod, Valibot, ArkType, or any other
Standard-Schema-compliant library. **This should be materially more stable
across future SDK versions than either v1 format**, since it isn't
downstream of a third party's error-message choices at all.

Decision: **add a third extraction branch for this format; keep both
existing branches unchanged.** This module must keep serving v1 alongside
v2 (Finding 6 below — one package supporting both SDKs), and v1's own
`getParseErrorMessage()` behavior hasn't changed with v2's release — a v1
`Server` author (low-level, throwing a raw `ZodError`) or an SDK still
pinned below 1.30 still produces the ≤1.29 JSON-array format; an SDK at
1.30+ still produces the "at <path>" format. Neither branch can be
dropped. The new v2 branch should be tried using the same
gate-on-marker-string discipline the existing rendered-format branch
already uses (`extractRenderedPaths()`'s precondition on
`INPUT_VALIDATION_MARKER`/`OUTPUT_VALIDATION_MARKER`), rather than
guessing from shape alone — a bare `"foo: bar, baz: qux"` string is not
self-validating the way a Zod-issue-shaped JSON array is.

### 6. Dual-SDK detection: one `instrumentMcpServer()`, not a separate entry point

Both SDKs export classes literally named `Server`/`McpServer` from
`server/index.js`/`server/mcp.js`-shaped paths — `instanceof Server` can't
disambiguate versions even if both were imported (the same dual-package-
hazard class of bug `detectServerKind()`'s docblock already designed
around for two *copies* of the same SDK; here it's two different SDKs with
colliding class names). Neither `Server` nor `McpServer` instances carry an
inspectable "which SDK" marker on the object itself — the divergence
(`(request, extra)` vs `(request, ctx)` handler signatures,
`extra.sessionId`/`extra.requestId` vs `ctx.sessionId`/`ctx.mcpReq.id`,
`CallToolRequestSchema`-vs-string dispatch) only becomes visible once a
call is already in flight, which is too late to decide how to wrap the
handler in the first place.

Decision: **detect by package presence, resolved once, not by per-call or
per-object duck-typing.** Concretely: try `require.resolve` /
`import()`-probe for `@modelcontextprotocol/sdk/package.json` and
`@modelcontextprotocol/server/package.json` (both wrapped in try/catch,
since a host typically has only one installed), and branch
`instrumentMcpServer()`'s internals on which one succeeds — falling back to
existing v1-shaped duck-typing (`detectServerKind()`) if only the v1
package resolves, or a new v2-shaped equivalent if only v2 resolves. This
stays inside **one exported `instrumentMcpServer()`**, not a second
`instrumentMcpServerV2()`: the span-wrapping logic that follows detection
(create span, set standard attributes, run `computeFingerprint()`, record
metrics, run cost/thrash/schema-drift bookkeeping) is close to identical
between the two SDKs once the caller knows which `(request, extra|ctx)`
shape to expect — the actual divergence is contained to a handful of field
reads (`sessionId`, `requestId`) and the two classifier modules (Findings
4–5), not the ~250-line core of `wrapToolCallHandler`. A separate entry
point would duplicate that core almost verbatim for a small, well-isolated
set of differences — worse for maintenance than one function with an
internal, resolved-once branch.

**Open question this ADR does not resolve — flagged for Phase 1
implementation:** `packages/core/package.json` currently declares
`@modelcontextprotocol/sdk` as a required peer dependency (`>=1.0.0`, no
`peerDependenciesMeta`), and `src/instrument.js` does a static top-level
`import { Server } from '@modelcontextprotocol/sdk/server/index.js'` for
the `instanceof Server` check in `detectServerKind()`. Supporting v2
alongside v1 as two *optional* peers (a host might have only one
installed) requires two changes together, not independently:

- `package.json`: add `@modelcontextprotocol/server` to
  `peerDependencies`, and add `peerDependenciesMeta` marking **both**
  `@modelcontextprotocol/sdk` and `@modelcontextprotocol/server` as
  `optional: true` — today's `sdk` peer is implicitly required (no
  `peerDependenciesMeta` entry at all), so this is a real change to that
  package's contract, not just an addition.
- `instrument.js`: the static top-level `import { Server } from
  '@modelcontextprotocol/sdk/...'` cannot survive that change unmodified —
  a host with only `@modelcontextprotocol/server` installed would fail at
  *module load*, before `instrumentMcpServer()` is ever called, on an
  import that has nothing to do with the SDK they're actually using. This
  needs to become a lazy/dynamic import (or an equivalent deferred-resolve
  pattern) for whichever SDK's presence was detected, gated behind the
  package-presence probe in the same finding above.

This is package-structure and module-loading design work, not covered
further here; it belongs in the Phase 1 implementation plan below.

### 7. OTel semantic conventions — no v2 awareness; interim story, per ADR 004's posture

Fetched `open-telemetry/semantic-conventions-genai`'s `docs/gen-ai/mcp.md`
directly (today, not from memory): every span example still shows the
`initialize`/`notifications/initialized` handshake, `mcp.session.id` is
still `Recommended` and links to the 2025-06-18 session-management spec
page, and there is no mention anywhere in the document of "2026-07-28,"
"stateless," `server/discover`, or session-id removal.
`mcp.method.name`/`gen_ai.tool.name`/the `tools/call` span-naming
scheme/the `error.type` guidance are all unchanged from what ADR 004
already implements — no attribute renames needed on that front.

Per ADR 004's already-established posture ("align to the spec as
currently published, signal instability explicitly, rather than waiting
for it to catch up"), this package needs its own interim decisions for the
gap the spec hasn't addressed yet:

- **`mcp.session.id`: keep emitting it exactly as today — only when a
  real value exists, never emit it as `undefined`/empty.** No behavior
  change needed: `wrapToolCallHandler` already reads `sessionId =
  extra?.sessionId` / (v2) `ctx?.sessionId` and only threads it into
  budget tracking, which already treats an absent session id as "skip
  session-scoped budget tracking" (Finding 3's own cross-reference). This
  extends unchanged to v2's stateless-HTTP case, where `sessionId` is
  simply usually absent — same as stdio today.
- **`jsonrpc.request.id` (`ATTR_JSONRPC_REQUEST_ID`): needs a v2-specific
  source.** Today it's set from `extra?.requestId` (v1). v2's `ctx` has no
  `requestId` field at that name at all — the equivalent, always-present
  value is `ctx.mcpReq.id` (Finding 3: `RequestId`, non-optional, unlike
  v1's `extra.requestId`). The v2 branch of `wrapToolCallHandler` needs to
  read `ctx.mcpReq.id` instead, and — since it's always present rather
  than conditionally set — can drop the `!== undefined && !== null` guard
  v1's version needs.

### 8. `isSingleConnectionTransport()` — confirmed inversion against a real v2 transport class

ADR 006's heuristic keys on `!('sessionId' in transport)`: true (safe to
assume single-connection) only when the transport doesn't even declare a
`sessionId` property, on the theory that session-oriented transports
always declare the field (even if unset) and single-connection transports
(stdio) never do.

**[Verified live]**, by constructing real instances of every relevant v2
transport class and testing `'sessionId' in instance` directly (not
inferred from `.d.mts` — TypeScript's `sessionId?: string;` class-field
declarations do not reliably indicate whether the compiled JS actually
sets the property, and this SDK ships pre-bundled/minified, so the only
way to know was to run it):

| Transport | `'sessionId' in instance` | Correct classification? |
|---|---|---|
| `WebStandardStreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`) | `true` (own property, value `undefined`) | Correctly **not** treated as single-connection by the heuristic |
| `WebStandardStreamableHTTPServerTransport`, stateful (`sessionIdGenerator` set) | `true` | Correctly not single-connection |
| `StdioServerTransport` | `false` | Correctly treated as single-connection |
| **`PerRequestHTTPServerTransport`** | **`false`** | **Incorrectly treated as single-connection** |

`WebStandardStreamableHTTPServerTransport` (the legacy-compat transport
`createMcpHandler`'s `legacy: 'stateless'` fallback constructs for
2025-era requests) declares `sessionId` as a real class field regardless
of stateless/stateful mode, matching v1's `StreamableHTTPServerTransport`/
`SSEServerTransport` — no inversion there, no change needed for that path.

`PerRequestHTTPServerTransport` — the transport class `createMcpHandler`
constructs internally for **modern (2026-07-28) era requests**, i.e. the
primary new stateless surface this ADR exists to support — does not
declare `sessionId` at all. Its own keys are entirely internal
(`_classification`, `_responseMode`, `_requestId`, etc. — no public field
resembling a session concept, consistent with the modern era having no
session concept at the protocol level whatsoever). Once `Server.connect()`
sets `server.transport` to one of these,
`isSingleConnectionTransport(server)` evaluates `!('sessionId' in
transport)` → `!false`... resolves to `true` — the exact false positive
the heuristic exists to prevent: a transport that legitimately serves
many different, unrelated HTTP clients (one instance per request, but
many requests, potentially many different real-world callers) gets
classified the same as stdio's genuinely-one-connection-for-the-process's-
lifetime case.

This is confirmed against real, installed v2 code, not predicted from
type signatures — the `.d.mts` declarations for both transports look
superficially similar (`sessionId?: string;` shows up on
`WebStandardStreamableHTTPServerTransport` but never appears at all in
`PerRequestHTTPServerTransport`'s declaration, which the live test
corroborates rather than contradicts, but the *stateless-mode* result for
`WebStandardStreamableHTTPServerTransport` specifically could not have
been predicted from the types alone — TypeScript optional-field
declarations don't guarantee runtime `in` behavior either way).

Decision: `isSingleConnectionTransport()` needs a v2-aware update before
this package can safely support v2's default HTTP deployment shape. The
safe direction is the same one the function already takes for the
"undetermined" case: **default to `false` (not single-connection) for
`PerRequestHTTPServerTransport`**, not by name/`instanceof` (same
dual-package-hazard reasoning as `detectServerKind()` — avoid importing a
v2 class just to exclude it), but by recognizing it as "a v2 transport we
don't have positive single-connection evidence for" once dual-SDK
detection (Finding 6) makes "which SDK" knowable at the call site. Where
positive evidence *is* needed (a genuinely single-client v2 stdio
deployment via `serveStdio`), stdio's transport under v2 was not part of
this table — confirming its `sessionId` shape is follow-up work before
implementation, not assumed here.

## Constraints accepted

- Findings 4, 5, and 8 depend on the *current* v2.0.0 release's exact error
  message text, disguise behavior, and transport field shapes — none of
  which are part of any documented, versioned contract (v1's equivalent
  behaviors already changed once, 1.29 → 1.30; v2 offers no reason to
  expect more stability). Each of these will need the same "confirmed
  empirically, may break on the next SDK bump, existing tests pin the
  version so a break fails loudly rather than silently" discipline
  `validation-paths.js` already documents for v1.
- Finding 6's peer-dependency/lazy-import redesign is scoped as an open
  question, not resolved here — this ADR does not commit to a specific
  lazy-import mechanism (dynamic `import()` vs `createRequire` +
  `require.resolve` vs something else), since that choice interacts with
  this package's `"type": "module"` setting and dual CJS/ESM consumer
  support in ways that need their own investigation before Phase 1 starts.
- Finding 3's fallback-session-id gap (thrash detection across a v2
  stateless deployment using `instanceKey` + `assumeSingleSession`) is
  identified but not designed away by this ADR. Shipping v2 support
  without addressing it means Agent Thrash Detection silently underdelivers
  for that specific combination (real per-call session ids still work
  fine; it's only the fallback path that's affected) — acceptable to ship
  Phase 1–2 without it, but should not ship silently forever; tracked as
  Phase 3.

## Alternatives rejected

- **A separate `instrumentMcpServerV2()` export.** Rejected in Finding 6:
  duplicates `wrapToolCallHandler`'s ~250 lines almost verbatim for a
  small, well-isolated set of differences (handler signature, two
  classifier modules, a couple of field reads). Two entry points also
  means two places for every future feature (cost tracking, schema drift,
  thrash detection) to be added, tested, and kept in sync — direct
  maintenance-burden duplication with no compensating benefit, since the
  SDKs aren't different enough to warrant it.
- **Per-call/per-object duck-typing to distinguish v1 from v2** (mirroring
  how `detectServerKind()` distinguishes `Server` from `McpServer` today).
  Rejected in Finding 6: neither SDK's `Server`/`McpServer` instances carry
  any inspectable "which SDK" marker before a call is already in flight,
  by which point it's too late to have decided how to wrap the handler.
  Package-presence detection, resolved once, is the only point where the
  distinction is actually knowable.
- **Patching `recoverDisguisedProtocolFailure()`'s existing regex to
  optionally match without the `"MCP error N: "` prefix**, instead of a
  distinct v2 code path (Finding 4). Rejected: once the prefix is optional,
  the regex is doing meaningfully less work than before (no code to
  recover, no wrapper to strip) — writing it as what it actually is for v2
  (a direct marker check, no regex) is clearer than keeping one regex that
  silently degrades into simpler behavior depending on which SDK produced
  the text.
- **Dropping v1's two existing `validation-paths.js` branches** once a v2
  branch exists, on the theory that v2 is "the new format going forward."
  Rejected in Finding 5: this package supports both SDKs going forward
  (Finding 6's whole premise), and v1's own SDK hasn't changed its
  rendering with v2's release — a v1 `Server`/`McpServer` user on any
  currently-supported SDK version still needs both existing branches
  exactly as before.

## Phased rollout plan

Proposed as four phases, each independently shippable and each narrowing
the risk surface of the next:

1. **Phase 1 — foundational plumbing (no v2-specific telemetry logic
   yet).** Resolve Finding 6's open peer-dependency/lazy-import question,
   land package-presence detection, extend `detectServerKind()`'s
   equivalent for v2's `Server`/`McpServer` shapes, and get
   `instrumentMcpServer()` wrapping a v2 `tools/call` handler with a
   *correct* span and standard attributes (Finding 1, Finding 7's
   `jsonrpc.request.id` source change) — deliberately without
   fingerprinting/channel/validation-path/thrash logic yet, so this phase
   is reviewable independent of Findings 3–5, 8's open gaps.
2. **Phase 2 — error/message classification.** `channel.js`'s v2-aware
   marker-only recovery path (Finding 4) and `validation-paths.js`'s third
   extraction branch (Finding 5), each with their own SDK-version-pinned
   tests mirroring the discipline `validation-paths.js` already documents
   for the 1.29→1.30 break.
3. **Phase 3 — session/thrash correctness.** `isSingleConnectionTransport()`'s
   v2-aware update (Finding 8) and a resolution to Finding 3's fallback-
   session-id gap under `instanceKey` — these are grouped together because
   both are about Agent Thrash Detection's correctness under v2's default
   deployment shape, and Finding 8's fix changes which servers even reach
   the fallback path Finding 3 is about.
4. **Phase 4 — docs and semconv interim story.** README's "Ordering
   constraint" and `instanceKey` sections updated with v2/`createMcpHandler`
   examples (Finding 2), Finding 7's interim attribute decisions written up
   alongside ADR 004's existing instability disclaimer, CHANGELOG entry.

No release version is committed here — Phase 1 is the earliest candidate
for a `v0.10.0` (or `v0.11.0`, depending on what else lands first) preview
release explicitly scoped to "v2 span/attribute support only, no
fingerprinting/thrash/schema-drift parity yet," consistent with how this
package has staged prior multi-phase features (ADR 010's schema drift,
ADR 011's cost-aware sampling). Phases 2–4 land as subsequent minor
releases once each is independently reviewed.

## Consequences

- Every finding in this ADR that reads "confirmed live" is a snapshot of
  `@modelcontextprotocol/server@2.0.0` specifically. Nothing here is a
  contract this package can rely on remaining true across v2 patch/minor
  releases any more than the equivalent v1 behaviors have — the same
  version-pinned-test discipline that already protects `validation-paths.js`
  needs to extend to every new v2-specific code path this ADR proposes.
- Shipping Phase 1 alone (span/attributes only) without Phases 2–4 means
  v2 users get strictly less signal than v1 users get today — no
  fingerprinting-driven `mcp.failure.*` attributes, no thrash detection,
  no schema drift — for as long as Phases 2–4 take to land. That gap
  should be stated plainly in the README/CHANGELOG for whichever release
  ships Phase 1, not left implicit.
- This ADR does not address `@modelcontextprotocol/client@2.0.0` beyond
  confirming its structural shape (`Client extends Protocol<ClientContext>`,
  same `ProtocolError` types re-exported) during Phase 0 — this package
  instruments MCP *servers*, and client-side instrumentation (if ever in
  scope) is a separate, unscoped question.

## Update (2026-08-11): today's shipped code silently no-ops on v2 input — confirmed live, not predicted

A finding flagged at the end of a follow-up documentation pass, verified
before being written up here: **`instrumentMcpServer()`, as currently
shipped (before any of this ADR's phases land), silently instruments
nothing when passed an `@modelcontextprotocol/server@2.0.0` `McpServer`.**
This precedes, and is more urgent than, the Finding 8 misclassification
above — Finding 8 only matters once `wrapToolCallHandler` actually runs
for a v2 request; this finding is why it currently never does, for any v2
request, through any code path.

**Mechanism:** `detectServerKind()` (`src/instrument.js`) recognizes a
high-level `McpServer` by duck-typing — an object with a `.server`
property exposing `setRequestHandler`, plus a `.tool` or `.registerTool`
function — deliberately not `instanceof McpServer`, to avoid importing the
class at all (ADR 001). A v2 `McpServer` satisfies this shape exactly
(Finding 1: `.server` is a real `Server` with `setRequestHandler`,
`.registerTool` exists), so it passes detection today even though this
package has never supported or tested against it. Detection succeeding
lets `instrumentMcpServer()` proceed through `assertInstrumentFirst()`
(which also passes — v2's `assertCanSetRequestHandler` behaves
identically per Finding 2) and patch `server.setRequestHandler`. That
patch is where it silently stops working: it compares `schema ===
CallToolRequestSchema` (the v1 Zod object), but v2 dispatches by the
method name string `'tools/call'` (Finding 1) — the comparison is `false`
for every call, so the handler is never wrapped, and registration falls
through to the original, unmodified `setRequestHandler` call.

**Confirmed live**, not inferred from the code reading above: constructed
a real `@modelcontextprotocol/server@2.0.0` `McpServer`, passed it to this
package's actual, shipped `instrumentMcpServer()`, registered a tool via
`registerTool`, and invoked the captured `tools/call` handler directly,
with an `InMemorySpanExporter` wired up as the global tracer provider.
Result: `instrumentMcpServer()` returned without throwing (`returned ===
input`, `getThrashSummary`/`getObservationState` both attached as
functions — every outward signal says "instrumented"); the tool call
itself executed correctly and returned the right result; **zero spans
were recorded.** No error, no warning, no degraded-but-present telemetry —
total, silent loss, with a success return value.

**Why this changes Phase 1's scope, not just its priority.** The Phased
rollout plan above frames Phase 1 as "get `instrumentMcpServer()` wrapping
a v2 `tools/call` handler with a correct span." That framing implicitly
assumes the starting state is "v2 input does nothing detectable" (a
reasonably safe default to build on top of). It is not — the actual
starting state is "v2 input reports success and produces nothing,"
which is a strictly worse failure mode than an error would be, and one
Phase 1 must actively close, not merely supersede by adding real wrapping
on top of it. **Phase 1's scope is therefore two things, not one:**

1. Real v2 detection and wrapping (as already planned).
2. **A loud failure or explicit rejection for server kinds
   `instrumentMcpServer()` does not fully support** — so that a v1-only
   build the day before Phase 1 ships, and a partially-migrated or
   misdetected object the day after, both fail obviously instead of
   succeeding silently. This is a general hardening of
   `detectServerKind()`'s contract ("recognized and fully wrapped, or
   rejected — never recognized and silently partially wrapped"), not a
   v2-specific patch; it should hold for whatever comes after v2 as well.

Concretely, this means Phase 1 cannot ship "v2 detection added, v1
detection unchanged" as sufficient — it must also close the gap where an
object satisfies the duck-typed shape but doesn't match either SDK's
actual dispatch mechanism the wrapping code checks for. The exact
shape of that check (e.g., resolving which SDK produced the object before
trusting the duck-type match, per Finding 6's package-presence detection
design) is Phase 1 implementation work, not decided further here.

Full write-up, including the exact reproduction steps and why this is
worse than every other tracked gap in this package: `docs/known-gaps.md`
entry 7. The README's "Compatibility" section now states this prominently
rather than leaving it to be discovered.
