# opentel-mcp v0.1.0 — Consumer Test Report

Date: 2026-07-10
Tester: fresh `npm install opentel-mcp` from the public npm registry, in an
empty project (`/home/thiru/test-opentel-mcp`), never touching the source
repo. No `file:` links, no local links — confirmed via `npm config list`
(default registry, no local `.npmrc` overrides) and by checking
`node_modules/opentel-mcp` is a real directory, not a symlink.

This is not a reassuring document. Read the findings section before the
headline numbers.

## Headline answers

- **Does the published package install and work from a clean project? YES.**
  `npm install opentel-mcp @opentelemetry/api @modelcontextprotocol/sdk`
  resolves from the registry, pulls v0.1.0, and the one-line
  `instrumentMcpServer(server, { serviceName, setupNodeSdk: true })` works
  exactly as documented against a real three-tool MCP server driven over
  real stdio JSON-RPC.

- **Did stdout stay clean (all lines valid JSON-RPC)? YES.**
  Every run — the main 4-request drive, the double-instrumentation check,
  the `enabled: false` check, and the Step 6 host-provider check — produced
  stdout where 100% of lines parsed as valid JSON via a programmatic
  `JSON.parse()` check (not eyeballed). Zero corruption, zero failures,
  across every scenario tested. This is the library's central claim and it
  held in every case.

- **Did all three failure/success paths produce correct spans? YES**, field
  for field, against every claim in the original ask:
  - `search_documents`: `status.code: 1` (OK), no `error.type`. Correct.
  - `fetch_weather('Chennai')`: `status.code: 2` (ERROR), `error.type:
    'tool_error'`, and the JSON-RPC response on stdout was a normal
    successful response with `isError: true` in the payload — nothing
    thrown, transport untouched. Correct.
  - `crash_tool()`: `status.code: 2`, `error.type: 'Error'`, a recorded
    `exception` span event with full `exception.type` /
    `exception.message` / `exception.stacktrace` (stack trace lands
    exactly on the `throw` in `server.js`), and a real JSON-RPC error
    response (`code: -32603`) on stdout. Correct.

- **Did `setupNodeSdk: false` respect the host provider? YES — mostly.**
  See the serviceName finding below; the routing itself is correct, but
  there's a real gap in what gets attached to the spans it routes.

- **Anything missing from the published tarball?** No. `files: ["src",
  "README.md", "LICENSE"]` published exactly `src/` (5 files),
  `README.md`, `LICENSE`, and `package.json` (npm always includes this) —
  nothing extra, nothing missing that a consumer needs at runtime.

---

## THE finding: `serviceName` is silently inert when `setupNodeSdk` is false

This is the real output of tonight's session — a bug in the production
default path, previously unverified by any test that spans two processes
with a genuinely pre-existing host provider.

### Exact reproduction

1. Host app (consumer) sets up its own OTel pipeline first, exactly as the
   README's "Bring-your-own-SDK (prod)" section instructs:

   ```js
   const hostProvider = new NodeTracerProvider({
     resource: resourceFromAttributes({ 'service.name': 'host-app' }),
     spanProcessors: [new SimpleSpanProcessor(new HostPrefixedStderrExporter())],
   });
   hostProvider.register();
   ```

2. Then, per the documented API, the host instruments its MCP server and
   passes `serviceName` — a required option; omitting it throws:

   ```js
   instrumentMcpServer(server, { serviceName: 'agri-rag-mcp-prod' });
   // setupNodeSdk omitted -> defaults to false, the documented production path
   ```

3. Drive one `tools/call`. The resulting span, captured verbatim from the
   host's own exporter:

   ```json
   {
     "name": "tools/call search_documents",
     "resourceServiceName": "host-app",
     "attributes": { "gen_ai.tool.name": "search_documents", "...": "..." }
   }
   ```

   `resourceServiceName` is `"host-app"` — the host's own resource — never
   `"agri-rag-mcp-prod"`, the value passed into `instrumentMcpServer()`.
   The option is accepted, validated (a missing/empty string throws), and
   then never read again anywhere in the `setupNodeSdk: false` branch of
   `setupTracer()` in `src/instrument.js`.

### Why this is NOT a hijack

Routing spans through the host's already-registered provider — including
using *the host's* `Resource` (which is where `service.name` actually
lives in OTel's data model) — is the correct behavior. A
`Tracer` has no mechanism to override the `Resource` of the `TracerProvider`
that created it; that would require constructing a second provider, which
is precisely the hijack behavior Step 6 was designed to catch and did not
find. So: no hijack. The host's resource attributes winning is correct
OTel semantics, not a bug in the routing.

### Why this IS still a bug

The bug isn't that the host's resource wins — it's that `serviceName` is a
**required, validated argument** (`resolveOptions()` throws
`'opentel-mcp: options.serviceName is required and must be a non-empty
string.'` if it's missing) that has **zero effect** in this configuration,
and nothing in the API surface, the thrown error, or the README's
"Bring-your-own-SDK (prod)" section (lines 106–109) says so. A consumer
reads "serviceName is required," supplies a real value, sees spans in
their backend, and has no way to discover — short of reading
`src/instrument.js` themselves, which is exactly what this session did —
that the value they were forced to type is being silently discarded. It
fails the "surprise the reader" test for library design: required-but-
sometimes-inert is worse than optional, because it actively signals "this
matters here" when it doesn't.

### Three candidate fixes

1. **Make `serviceName` conditionally optional** — only require it when
   `setupNodeSdk: true` (where it's actually consumed); allow omitting it
   when `setupNodeSdk: false`.
   - Pro: the validation now matches actual usage; you can't be required
     to supply a value that's thrown away.
   - Con: doesn't fix the deeper confusion — a consumer who *does* pass
     `serviceName` alongside `setupNodeSdk: false` (very plausible, since
     it's still in every code example muscle-memory) gets no signal that
     it's ignored. Silently accepting-and-ignoring an optional field is
     barely better than silently accepting-and-ignoring a required one.

2. **Document the constraint loudly** — keep `serviceName` required
   unconditionally (simpler mental model: "always pass it"), but make the
   README and JSDoc for `setupNodeSdk: false` explicit: *"serviceName is
   validated but not applied to emitted spans in this mode — the resource
   (including service.name) comes entirely from your own registered
   TracerProvider. Set service.name there instead."* Possibly also emit a
   one-time `diag.warn()` via `@opentelemetry/api`'s diag channel when
   `setupNodeSdk: false` and a global provider is already registered,
   so it surfaces at runtime, not just in docs someone may not read.
   - Pro: cheap, ships today, no API change, no breaking change.
   - Con: documentation and warnings are easy to miss; doesn't stop the
     footgun from firing for consumers who don't read the fine print
     (which is most consumers, by design of "one-line instrumentation").

3. **My honest recommendation: combine 1 and 2, plus a runtime nudge.**
   Make `serviceName` optional when `setupNodeSdk: false` (fix 1, so the
   API stops lying about what's required), *and* add a one-time
   `diag.warn()` at instrumentation time whenever `setupNodeSdk: false`
   **and** `serviceName` was explicitly passed — something like
   `"opentel-mcp: serviceName is ignored when setupNodeSdk is false; set
   service.name on your own TracerProvider's Resource instead."` That
   warning fires exactly when the mismatch between consumer intent and
   actual behavior exists, catches it at the moment of misuse rather than
   relying on documentation being read, and costs nothing when the
   consumer does the right thing (either omits `serviceName` in this mode,
   or uses `setupNodeSdk: true`). This is more work than fix 2 alone, but
   fix 2 alone is documentation compensating for an API that still invites
   the mistake — a warning at the call site is worth more than a paragraph
   in a README nobody re-reads after the first `npm install`.

---

## Other findings (small, but real — noted per your "be blunt" instruction)

### 1. Published `package.json` leaks monorepo structure (`workspaces` field)

The published tarball's `package.json` still contains:
```json
"workspaces": ["examples/hello-server", "examples/hello-mcpserver"]
```
Neither directory exists in the published package (correctly excluded by
`files`). Harmless functionally — npm doesn't act on `workspaces` in a
dependency's own manifest — but it leaks internal repo layout into every
consumer's `node_modules`, and is generally a sign the published
`package.json` wasn't trimmed from the monorepo root's. Cosmetic; still a
real diff between "what you meant to publish" and "what got published."

### 2. README quickstart omits the `"type": "module"` requirement

Both quickstart code blocks use bare ESM `import` syntax, and the package
itself is `"type": "module"` with no CommonJS build (`exports["."]` points
only at `./src/index.js`, an ESM file — confirmed no `require` condition in
the package's `exports` map). A consumer following the README verbatim
into a fresh `npm init -y` project — which defaults to CommonJS — will hit
`SyntaxError: Cannot use import statement outside a module` on the very
first quickstart snippet. This session hit exactly that and had to add
`"type": "module"` to its own `package.json` before anything would run.
The README never mentions this prerequisite. Worth one line under
"Quickstart" or "Compatibility": *"This package is ESM-only; your
project's package.json needs `"type": "module"` (or use a `.mjs`
extension)."*

### 3. README says "Status: pre-release. Not yet published to npm." — but it is

Line 10 of the published README (the version installed via `npm install
opentel-mcp`, presently v0.1.0) reads: **"Status: pre-release. Not yet
published to npm."** This is directly contradicted by the fact that this
entire test session installed it from the npm registry. This is a stale
banner left over from before the first publish — small, but it's the kind
of thing that makes a first-time visitor to the README bounce, thinking
the package they just `npm install`ed isn't real yet.

### 4. No CommonJS entry point / dual-package hazard risk (noted, not tested deep)

Related to finding 2: since `exports["."]` only has an `import` condition,
any consumer on a CommonJS codebase can't `require('opentel-mcp')` at all
— not even via a transpiler-produced `require` shim, since there's no
`require` condition to satisfy Node's exports resolution. This may well be
an intentional scope decision (MCP servers skew heavily ESM already, and
the instrument.js code itself notes awareness of dual-package hazards in
its `detectServerKind` comments) — flagging it as a known boundary, not
asserting it should change, since I don't know your target consumer base
well enough to say CJS support is warranted.

---

## Step 5 adversarial checks — verbatim error messages, with judgment

**(a) `instrumentMcpServer()` called AFTER registering a tool handler:**
```
THREW: Error
MESSAGE: opentel-mcp: instrumentMcpServer() must be called BEFORE registering tool handlers. Move instrumentMcpServer(server, options) to immediately after `new Server(...)`, before any server.setRequestHandler(CallToolRequestSchema, ...) calls (low-level Server) or .tool()/.registerTool() calls (McpServer).
```
Judgment: **Good.** Tells the developer exactly what's wrong, exactly what
to move, and exactly where to move it to, for both API shapes. A confused
developer copy-pasting the fix instructions verbatim would succeed on the
first try.

**(b) `instrumentMcpServer()` with no `serviceName`:**
```
THREW: Error
MESSAGE: opentel-mcp: options.serviceName is required and must be a non-empty string.
```
(Also verified with `options` omitted entirely — same message, since
`resolveOptions` defaults `options` to `{}` first.)
Judgment: **Good, as far as it goes** — clear and specific. Undercut by the
finding above: it's not always true that this is required (functionally),
which will confuse a developer in the `setupNodeSdk: false` case who
wonders why they're forced to supply a value that (per the finding above)
does nothing.

**(c) `instrumentMcpServer()` called twice on the same server:**
No error — verified as a true no-op via span counting: one `tools/call`
after double-instrumenting produced exactly **1** span, not 2.
Judgment: **Correct and good.** Silent idempotency is the right behavior
here (a throw would punish defensive/repeated-import code paths for no
reason), and it was verified empirically, not just by reading the guard
logic.

**(d) Plain object `{}` instead of a `Server`:**
```
THREW: Error
MESSAGE: opentel-mcp: instrumentMcpServer() expects either a low-level Server instance (from @modelcontextprotocol/sdk/server/index.js) or a high-level McpServer instance (from @modelcontextprotocol/sdk/server/mcp.js).
```
Judgment: **Good.** Names both accepted shapes and where to import them
from. A confused developer gets pointed at the fix immediately.

**(e) `enabled: false`:**
No error, no throw. Verified: tool call succeeded normally over stdio
(`pong` response), and stderr byte length was exactly **0** — not just "no
span objects visible," but literally zero bytes written, confirmed
programmatically.
Judgment: **Correct and good.** Clean opt-out with no side channel noise.

---

## Three concrete things to fix before telling anyone about this package

1. **Fix the `serviceName` / `setupNodeSdk: false` mismatch** (see full
   writeup above) — recommend option 3 (make it optional in that mode +
   add a one-time `diag.warn()` when it's passed anyway and ignored). This
   is the one that will actually bite real users in production, since
   `setupNodeSdk: false` is the documented, recommended prod configuration.

2. **Fix the README**: add the `"type": "module"` prerequisite to
   Quickstart/Compatibility, and delete/update the stale "Status:
   pre-release. Not yet published to npm." banner. Both are one-line
   changes and both are the first thing a new visitor sees.

3. **Strip `workspaces` (and double-check for other monorepo-root leftovers)
   from the published `package.json`** — either by hand-authoring a
   publish-time manifest or adding a `prepublishOnly` step that removes
   monorepo-only fields before `npm publish`.

None of these are architectural problems. The core instrumentation logic —
span shape, error-path handling, idempotency, stdout/stderr separation,
host-provider respect — is solid and matched every claim tested tonight.
The bugs found are all in the seams: what happens when a required option
turns out not to be required, and what the README promises versus what a
truly fresh install experiences.
