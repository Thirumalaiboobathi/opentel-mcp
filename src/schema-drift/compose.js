/**
 * @module schema-drift/compose
 *
 * Ties canonicalization and hashing together into a single stable identity
 * for one tool's `inputSchema` (ADR 010, docs/adr/010-schema-drift.md —
 * Phase 1: capture + canonicalization only. No drift comparison, no OTel
 * emission, no wiring into instrumentMcpServer()/tools/list here — later
 * phases build on this module, they don't live in it).
 *
 * Reuses fingerprint/hash.js's `hashInputs()` directly rather than adding a
 * second hashing primitive: ADR 010 (Q3) concluded that primitive is
 * already generic — pure `sha256(input).slice(0, 16)` with no coupling to
 * failure-specific concerns — and only `fingerprint/compose.js`'s
 * `computeFingerprint()` itself (classification, message/stack
 * normalization) is failure-specific and not reusable here.
 *
 * `description` is deliberately never read anywhere in this module. ADR
 * 010's "What 'drift' means" section decided description drift is an
 * independent dimension, computed and reported separately from
 * structural schema drift, never folded into the same hash — hashing it
 * in here would be exactly the "one combined fingerprint" design ADR 010
 * rejected. This hash is `inputSchema` identity, and only that.
 */

import { hashInputs } from '../fingerprint/hash.js';
import { canonicalizeSchema } from './canonicalize.js';

/** @typedef {import('./types.d.ts').SchemaHashResult} SchemaHashResult */
/** @typedef {import('./types.d.ts').ToolSchemaSnapshot} ToolSchemaSnapshot */

// Mirrors fingerprint/compose.js's HASH_INPUT_VERSION discipline (itself
// following ADR 006): a leading version tag means a future change to what
// goes into this hash (e.g. folding in outputSchema) can ship as `v2`
// without silently reinterpreting `v1` identities already recorded by
// consumers.
const HASH_INPUT_VERSION = 'v1';

/**
 * Computes a stable identity hash for one `inputSchema` value. Never
 * throws — canonicalizeSchema() already never throws, and hashInputs()
 * is a pure, side-effect-free string hash; this function's own try/catch
 * exists purely as defense-in-depth for the same reason
 * computeFingerprint() wraps its whole body (this runs inline in a future
 * hot path), not because either dependency is expected to fail.
 *
 * @param {unknown} inputSchema
 * @returns {SchemaHashResult | null} `null` when `inputSchema` can't be
 *   canonicalized (missing, or not safely serializable) — see
 *   canonicalizeSchema()'s docblock for exactly which shapes that covers.
 */
export function computeSchemaHash(inputSchema) {
  try {
    const canonical = canonicalizeSchema(inputSchema);
    if (canonical === null) return null;

    const hash = hashInputs(`${HASH_INPUT_VERSION}|${canonical}`);
    return { hash, canonical };
  } catch {
    return null;
  }
}

/**
 * Captures one tool's canonicalized, hashed `inputSchema` identity from a
 * `tools/list` response entry (ADR 010, Q2 — the hook point this feeds is
 * the same instance-patched `server.setRequestHandler` ADR 001 already
 * established for `tools/call`; this module has no dependency on that
 * wiring and doesn't perform it — see this module's own docblock).
 *
 * Only `tool.name` and `tool.inputSchema` are read. `description` and
 * every other tool-definition field are deliberately untouched — see this
 * module's docblock.
 *
 * @param {{ name?: unknown, inputSchema?: unknown }} tool - One entry from
 *   a tools/list response's `tools` array.
 * @returns {ToolSchemaSnapshot | null} `null` when `tool` is malformed (no
 *   usable string `name`) or its `inputSchema` doesn't canonicalize — never
 *   throws, never guesses a partial result.
 */
export function captureToolSchema(tool) {
  try {
    if (!tool || typeof tool !== 'object') return null;

    const toolName = tool.name;
    if (typeof toolName !== 'string' || toolName.length === 0) return null;

    const result = computeSchemaHash(tool.inputSchema);
    if (result === null) return null;

    return { toolName, hash: result.hash, canonical: result.canonical };
  } catch {
    return null;
  }
}
