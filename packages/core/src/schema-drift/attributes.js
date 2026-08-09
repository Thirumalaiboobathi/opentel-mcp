/**
 * @module schema-drift/attributes
 *
 * Attribute key constants for tool schema drift telemetry (ADR 010,
 * docs/adr/010-schema-drift.md — Phase 3: OTel emission only). Mirrors
 * fingerprint/attributes.js's split between what's safe to also attach
 * to a metric label and what must stay span-only, and thrash/attributes.js's
 * separate span-event-name constant.
 *
 * Spans can carry high-cardinality attributes fine — each span (or span
 * event) is its own record. Metric labels can't: every distinct label
 * combination becomes its own time series. `type` is a small, closed
 * 6-value enum (see diff.js's SchemaDriftKind) — bounded the same way
 * `mcp.failure.category`/`mcp.failure.origin` are (fingerprint/attributes.js),
 * so it's metric-safe. The hashes and field-name lists are not: a hash is
 * effectively unbounded (16 hex chars), and field names are bounded per
 * tool but unbounded across every tool anyone ever registers and every
 * deployment a shared metrics backend might aggregate — the exact
 * reasoning that already keeps `mcp.failure.validation_paths` (ADR 009)
 * off `METRIC_SAFE_ATTRIBUTES` in fingerprint/attributes.js.
 */

/**
 * Span event name for a detected schema drift. ADR 010's "What gets
 * emitted" names the metric counter explicitly
 * (`mcp.tool.schema_drift.detected`) but doesn't propose a separate,
 * shorter span-event-specific name the way thrash ended up with two
 * different strings (`mcp.tool.loop.detected` the metric,
 * `mcp.loop.detected` the span event) — reusing the metric's own name
 * here is the literal, non-invented reading of the ADR, not a new
 * naming decision.
 */
export const SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED = 'mcp.tool.schema_drift.detected';

/** @type {Readonly<Record<'TYPE' | 'PREVIOUS_HASH' | 'CURRENT_HASH' | 'ADDED_FIELDS' | 'REMOVED_FIELDS' | 'CHANGED_FIELDS', string>>} */
export const ATTRIBUTE_KEYS = Object.freeze({
  /**
   * ADR 010's `SchemaDriftKind` (diff.js): `field_added` | `field_removed`
   * | `type_changed` | `required_changed` | `multiple` | `unknown`. The
   * ADR names this attribute `mcp.tool.schema_drift.type` explicitly for
   * the metric; reused identically here as the span-event attribute key
   * too (one shared constant, not two), the same reuse pattern
   * `fingerprint/attributes.js`'s `ATTRIBUTE_KEYS.CATEGORY` already
   * follows across both span and metric.
   */
  TYPE: 'mcp.tool.schema_drift.type',
  /** The stored hash from the previous capture that this one differs from. Span-only — unbounded. */
  PREVIOUS_HASH: 'mcp.tool.schema_drift.previous_hash',
  /** This capture's hash. Span-only — unbounded. */
  CURRENT_HASH: 'mcp.tool.schema_drift.current_hash',
  /** Property names added — see SchemaDriftEvent.addedFields (schema-drift/types.d.ts). Span-only — unbounded across tools/deployments. */
  ADDED_FIELDS: 'mcp.tool.schema_drift.added_fields',
  /** Property names removed. Span-only — same reasoning as ADDED_FIELDS. */
  REMOVED_FIELDS: 'mcp.tool.schema_drift.removed_fields',
  /** Property names whose schema value changed. Span-only — same reasoning as ADDED_FIELDS. */
  CHANGED_FIELDS: 'mcp.tool.schema_drift.changed_fields',
});

/**
 * Attribute keys safe to attach to metric labels. Everything else in
 * {@link ATTRIBUTE_KEYS} is unbounded and must stay span-only. `gen_ai.tool.name`
 * (reused from src/attributes.js, already an accepted metric label on
 * every other `mcp.tool.*` counter — see metrics.js) is not repeated
 * here since it isn't declared in this module's own `ATTRIBUTE_KEYS`.
 *
 * @type {readonly string[]}
 */
export const METRIC_SAFE_ATTRIBUTES = Object.freeze([ATTRIBUTE_KEYS.TYPE]);
