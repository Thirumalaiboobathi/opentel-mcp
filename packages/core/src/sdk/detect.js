/**
 * @module sdk/detect
 *
 * Detection of which MCP SDK package(s) are actually installed —
 * `@modelcontextprotocol/sdk` (v1, protocol revisions through 2025-11-25)
 * and/or `@modelcontextprotocol/server` (v2, protocol revision
 * 2026-07-28). See ADR 015 Finding 6 and its "Update (2026-08-11)": both
 * are now OPTIONAL peer dependencies (`packages/core/package.json`'s
 * `peerDependenciesMeta`), so neither can be a static top-level `import`
 * in `src/instrument.js` any more — that would crash this whole package's
 * module load for a host that only installed one of the two, before
 * `instrumentMcpServer()` is ever called.
 *
 * Resolved via dynamic `import()` at TOP-LEVEL AWAIT, not a lazily-invoked
 * `require()`. This distinction is load-bearing, not stylistic — an
 * earlier version of this module used `createRequire()` + synchronous
 * `require()`, on the theory that `instrumentMcpServer()`'s entirely
 * synchronous public contract (a host calls it and immediately calls
 * `server.setRequestHandler(...)`/`.registerTool()` on the same tick — see
 * the README's "Ordering constraint") ruled out an async detection step.
 * That was wrong in a way only caught by testing against a REAL v1
 * `McpServer`, not the hand-rolled test fixtures: `require()` resolves a
 * package's `require` condition (its CJS build), while a real ESM
 * consumer's own `import { Server } from '@modelcontextprotocol/sdk/...'`
 * resolves the SAME package's `import` condition (its ESM build) — two
 * different files, two different classes, so `input.server instanceof
 * v1.Server` was FALSE for every real McpServer a real consumer
 * constructed, even though it was TRUE for the hand-rolled fixture that
 * happened to also go through this module's own `require()` path.
 * Confirmed empirically (not just reasoned about): `new
 * McpServer().server instanceof requiredServer.Server` → `false`;
 * `new McpServer().server instanceof staticallyImportedServer.Server` →
 * `true`; and, critically, `await import(specifier)` from ANY file
 * resolves to the exact same module instance a static
 * `import specifier` anywhere else in the process would — Node's ESM
 * loader caches by resolved URL, not by which file did the importing.
 *
 * Top-level await is what keeps `instrumentMcpServer()` itself synchronous
 * despite this: any module that imports this one (transitively,
 * `instrument.js` → `index.js`) automatically waits for this module's
 * top-level await to settle before its own evaluation completes — ordinary
 * ESM behavior, not something callers opt into. By the time
 * `instrumentMcpServer` is defined and callable at all, `getV1Sdk()`/
 * `getV2Sdk()` below are already resolved, plain synchronous accessors
 * over values computed once at module load. This package has no
 * CommonJS entry point (ESM-only already, before this module existed —
 * see `docs/adr/015-mcp-v2-support.md`), so top-level await here adds no
 * new consumer-facing constraint beyond what already existed.
 */

/**
 * Imports `specifier`, resolving to `null` — not throwing — only when the
 * module genuinely isn't installed (`ERR_MODULE_NOT_FOUND`). Any other
 * error (a real bug in an installed package, a broken build, a syntax
 * error) rethrows: silently treating that as "not installed" would
 * misreport a real problem as a missing optional peer dependency, which is
 * worse than letting it surface.
 *
 * @param {string} specifier
 * @returns {Promise<unknown | null>}
 */
async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const [v1ServerMod, v1TypesMod, v2Mod] = await Promise.all([
  tryImport('@modelcontextprotocol/sdk/server/index.js'),
  tryImport('@modelcontextprotocol/sdk/types.js'),
  tryImport('@modelcontextprotocol/server'),
]);

/** @type {{ Server: Function, CallToolRequestSchema: unknown, ListToolsRequestSchema: unknown, [schema: string]: unknown } | null} */
const v1Sdk =
  v1ServerMod && v1TypesMod
    ? {
        Server: v1ServerMod.Server,
        CallToolRequestSchema: v1TypesMod.CallToolRequestSchema,
        ListToolsRequestSchema: v1TypesMod.ListToolsRequestSchema,
        // ADR 026 (opt-in coverage): v1 dispatches by schema identity, so
        // each resource/prompt method needs its schema object too.
        ReadResourceRequestSchema: v1TypesMod.ReadResourceRequestSchema,
        ListResourcesRequestSchema: v1TypesMod.ListResourcesRequestSchema,
        ListResourceTemplatesRequestSchema: v1TypesMod.ListResourceTemplatesRequestSchema,
        GetPromptRequestSchema: v1TypesMod.GetPromptRequestSchema,
        ListPromptsRequestSchema: v1TypesMod.ListPromptsRequestSchema,
      }
    : null;

/**
 * v2 dispatches `tools/call`/`tools/list` by method-name STRING, not a
 * schema object (ADR 015 Finding 1) — so, unlike v1, there is no schema
 * export to resolve here at all. `CallToolRequestSchema` for v2 exists
 * only inside `@modelcontextprotocol/core/internal`, a subpath whose name
 * says plainly it isn't for third-party use; this package deliberately
 * does not import it (ADR 015 Finding 1's rejection of that path). `Server`
 * is the only binding this package's wrapping logic needs from v2.
 *
 * @type {{ Server: Function } | null}
 */
const v2Sdk = v2Mod ? { Server: v2Mod.Server } : null;

/**
 * Resolves `@modelcontextprotocol/sdk` (v1). `null` when not installed (an
 * optional peer dependency — see this module's docblock).
 *
 * @returns {{ Server: Function, CallToolRequestSchema: unknown, ListToolsRequestSchema: unknown, [schema: string]: unknown } | null}
 */
export function getV1Sdk() {
  return v1Sdk;
}

/**
 * Resolves `@modelcontextprotocol/server` (v2). `null` when not installed
 * (an optional peer dependency — see this module's docblock).
 *
 * @returns {{ Server: Function } | null}
 */
export function getV2Sdk() {
  return v2Sdk;
}
