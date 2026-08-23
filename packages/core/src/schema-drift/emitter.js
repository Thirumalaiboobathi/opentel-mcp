/**
 * @module schema-drift/emitter
 *
 * OTel emission for tool schema drift detection (ADR 010,
 * docs/adr/010-schema-drift.md — Phase 3: OTel emission only). Consumes
 * a {@link SchemaDriftEvent} (src/schema-drift/detector.js, Phase 2) and
 * emits telemetry — no detection logic lives here, and nothing here
 * decides whether drift happened (that's already been fully decided and
 * tested in isolation by detector.js/diff.js). No wiring into
 * instrument.js or the tools/list handler happens here either — a later
 * phase calls this.
 *
 * Mirrors thrash/emitter.js's exact shape: one metric instrument
 * registered on the same meter identity every other `mcp.tool.*`
 * instrument uses (`metrics.getMeter('opentel-mcp', packageVersion)` —
 * see src/metrics.js's own docblock on why a second getMeter() call
 * still reports under the same meter to any backend), plus one span
 * event and one boolean span attribute (v0.12.0, ADR 011,
 * docs/adr/011-cost-aware-sampling.md — see ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED's
 * own docblock in ./attributes.js for why) on the currently active span.
 *
 * "No active span" handling follows the SAME precedent this module
 * mirrors, not an invented behavior: ADR 010's "What gets emitted"
 * section frames schema-drift telemetry as "following the existing
 * split between spans... and metrics... this package already maintains
 * for tool-call telemetry" — that existing split's own established
 * behavior (thrash/emitter.js's emit()) is to record the metric
 * unconditionally and skip the span event silently when
 * `trace.getActiveSpan()` finds nothing recording, never to fabricate a
 * span. This module does the same, for the same reason: schema capture
 * can happen outside any tool-call span (a tools/list request has its
 * own lifecycle, not a tools/call one), and manufacturing a span here
 * would be inventing a mechanism ADR 010 never proposed — a future
 * wiring phase, which ADR 010 already describes as creating its own
 * `tools/list` span (mirroring wrapToolCallHandler's own
 * tracer.startActiveSpan() for tools/call), is what will make a span
 * active by the time this emitter actually runs in production; this
 * module only needs to attach to whatever's active, never create it.
 */

import { trace, metrics } from '@opentelemetry/api';
import { ATTR_GEN_AI_TOOL_NAME } from '../attributes.js';
import { SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED, ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED, ATTRIBUTE_KEYS } from './attributes.js';

/** @typedef {import('./types.d.ts').SchemaDriftEvent} SchemaDriftEvent */

/**
 * Creates the `mcp.tool.schema_drift.detected` counter and returns an
 * `emit()` wrapper, mirroring src/thrash/emitter.js's
 * `createThrashEmitter()` shape.
 *
 * @param {string} packageVersion
 * @returns {{ emit: (event: SchemaDriftEvent) => void }}
 */
export function createSchemaDriftEmitter(packageVersion) {
  const meter = metrics.getMeter('opentel-mcp', packageVersion);

  const detected = meter.createCounter('mcp.tool.schema_drift.detected', {
    description:
      "Number of tool schema drift events detected — a tool's inputSchema changed between two observed tools/list responses.",
  });

  return {
    /**
     * Emits the counter, then — only when there's a current, recording
     * span (via trace.getActiveSpan(); this never creates a new span —
     * see this module's own docblock) — one span event carrying the
     * full detail, including the previous/current hashes and (only when
     * non-empty, mirroring `mcp.failure.validation_paths`'s
     * omit-rather-than-set-empty discipline, ADR 009) the changed field
     * names, plus (v0.12.0, ADR 011) a boolean
     * `mcp.tool.schema_drift_detected` span ATTRIBUTE on that same span —
     * a Collector tail-sampling policy can key on it directly, without
     * depending on whether span-event data is matchable at all (see
     * ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED's docblock in ./attributes.js).
     * Never throws: metrics and the span event/attribute are independently
     * guarded, so a failure in one never suppresses the other, the same
     * fail-open philosophy as every other emitter in this codebase.
     *
     * @param {SchemaDriftEvent} event
     */
    emit(event) {
      try {
        const metricAttrs = {
          [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
          [ATTRIBUTE_KEYS.TYPE]: event.kind,
        };
        detected.add(1, metricAttrs);
      } catch {
        // Never throw — see emit()'s docblock.
      }

      try {
        const span = trace.getActiveSpan();
        if (!span || !span.isRecording()) return;

        const attrs = {
          [ATTR_GEN_AI_TOOL_NAME]: event.toolName,
          [ATTRIBUTE_KEYS.TYPE]: event.kind,
          [ATTRIBUTE_KEYS.PREVIOUS_HASH]: event.previousHash,
          [ATTRIBUTE_KEYS.CURRENT_HASH]: event.currentHash,
        };
        if (event.addedFields?.length > 0) attrs[ATTRIBUTE_KEYS.ADDED_FIELDS] = event.addedFields;
        if (event.removedFields?.length > 0) attrs[ATTRIBUTE_KEYS.REMOVED_FIELDS] = event.removedFields;
        if (event.changedFields?.length > 0) attrs[ATTRIBUTE_KEYS.CHANGED_FIELDS] = event.changedFields;

        span.addEvent(SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED, attrs);
        span.setAttribute(ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED, true);
      } catch {
        // Never throw — see emit()'s docblock.
      }
    },
  };
}
