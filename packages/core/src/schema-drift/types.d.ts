/**
 * Shared type definitions for tool schema drift detection (ADR 010,
 * docs/adr/010-schema-drift.md — Phase 1: capture + canonicalization;
 * Phase 2: drift detection logic; Phase 3: OTel emission; Phase 4:
 * wiring into instrumentMcpServer()).
 *
 * Hand-written, not a compiled build artifact — this project ships plain
 * JS with no TypeScript build step (see CONTRIBUTING.md). {@link SchemaDriftConfig}
 * is re-exported from src/index.d.ts (via instrumentMcpServer()'s
 * `options.schemaDrift`) — the same pattern src/thrash/types.d.ts's
 * `ThrashConfig` already establishes: a hand-written interface here,
 * kept in sync with src/schema-drift/config.js's own JSDoc `@typedef` by
 * hand, not by a build step. Every other type in this file remains
 * internal-only, not part of the public API surface, the same reasoning
 * src/thrash/types.d.ts's `ThrashEntry` documents for its own
 * internal-only types.
 */

/**
 * Resolved schema-drift-detection config — see src/schema-drift/config.js's
 * `resolveSchemaDriftConfig()`, which this mirrors field-for-field. All
 * fields are required here (this is the RESOLVED shape, after defaults/
 * env vars have been applied); {@link instrumentMcpServer}'s `schemaDrift`
 * option accepts `Partial<SchemaDriftConfig>` — see src/index.d.ts. Same
 * pattern as `ThrashConfig` (src/thrash/types.d.ts).
 */
export interface SchemaDriftConfig {
  /**
   * `false` disables schema drift detection entirely: tools/list is not
   * wrapped at all (no span, no capture, no detector/emitter
   * construction) — a true no-op, not merely a per-call skip.
   *
   * @default true
   */
  enabled: boolean;
  /**
   * Hard cap on distinct (scope, toolName) pairs tracked at once
   * (src/schema-drift/store.js's `BoundedMap`) — defense-in-depth, not a
   * response to an expected failure mode.
   *
   * @default 1000
   */
  maxTrackedTools: number;
}

/** Result of hashing one canonicalized `inputSchema` value — see src/schema-drift/compose.js's computeSchemaHash(). */
export interface SchemaHashResult {
  /** 16-hex-character identity hash (fingerprint/hash.js's hashInputs()) of the versioned, canonicalized schema string. */
  hash: string;
  /** The canonicalized JSON string that was hashed — every object's keys sorted, array order preserved. Exposed for debugging/testing, not itself a stable contract. */
  canonical: string;
}

/** One tool's captured schema identity — see src/schema-drift/compose.js's captureToolSchema(). */
export interface ToolSchemaSnapshot {
  toolName: string;
  /** See {@link SchemaHashResult.hash}. */
  hash: string;
  /** See {@link SchemaHashResult.canonical}. */
  canonical: string;
}

/**
 * What kind of structural change was detected between two captures of the
 * same tool's `inputSchema` — see src/schema-drift/diff.js's
 * `diffSchemas()`. Deliberately does NOT include a `description_changed`
 * value: description is never captured by `captureToolSchema()` (Phase
 * 1), so this diff can never produce that value — see diff.js's own
 * docblock for why an unreachable enum member isn't included here (same
 * discipline as ADR 008's two-axis observation contract).
 */
export type SchemaDriftKind = 'field_added' | 'field_removed' | 'type_changed' | 'required_changed' | 'multiple' | 'unknown';

/** Options for {@link SchemaDriftDetector}'s constructor — see src/schema-drift/detector.js. */
export interface SchemaDriftDetectorOptions {
  /**
   * Hard cap on distinct (scope, toolName) pairs tracked at once —
   * defense-in-depth, not a response to an expected failure mode (see
   * store.js's docblock: a server's own tool count is normally small and
   * bounded already).
   *
   * @default 1000
   */
  maxTrackedTools?: number;
}

/**
 * Result of {@link SchemaDriftDetector}.capture() detecting a change — see
 * src/schema-drift/detector.js.
 *
 * CARDINALITY GUIDANCE FOR A FUTURE OTEL-EMISSION PHASE (nothing here
 * emits anything yet — Phase 2 is detection logic only): `kind` is a
 * small, closed, 6-value enum and is safe as a metric label, the same
 * class as `fingerprint/attributes.js`'s `category`/`origin`
 * (`METRIC_SAFE_ATTRIBUTES`). `addedFields`/`removedFields`/
 * `changedFields`, by contrast, must stay **span-only, never a metric
 * label** — field names are bounded per tool but unbounded across every
 * tool anyone ever registers, and unbounded again across every
 * deployment a shared metrics backend might aggregate. This is the exact
 * same reasoning `fingerprint/attributes.js` already documents for why
 * `mcp.failure.validation_paths` (ADR 009) is permanently excluded from
 * `METRIC_SAFE_ATTRIBUTES` — a future wiring phase must extend that
 * same exclusion list, not invent a new decision.
 */
export interface SchemaDriftEvent {
  /** Whatever caller-supplied value identifies "this server" (ADR 010, Q4) — never a session id. */
  scope: string;
  toolName: string;
  /** The stored hash from the previous capture that this one differs from. */
  previousHash: string;
  /** This capture's hash — becomes `previousHash` on the next differing capture. */
  currentHash: string;
  kind: SchemaDriftKind;
  /**
   * Property names present in the new schema but not the old. Empty
   * unless `kind` is `field_added` or `multiple`. Span-only if emitted —
   * see this interface's own docblock.
   */
  addedFields: readonly string[];
  /**
   * Property names present in the old schema but not the new. Empty
   * unless `kind` is `field_removed` or `multiple`. Span-only if emitted
   * — see this interface's own docblock.
   */
  removedFields: readonly string[];
  /**
   * Property names present in both, whose schema value differs. Empty
   * unless `kind` is `type_changed` or `multiple`. Span-only if emitted
   * — see this interface's own docblock.
   */
  changedFields: readonly string[];
  /** Whether the `required` set (compared as a set, not a sequence) differs. */
  requiredChanged: boolean;
}
