/**
 * @module thrash/emitter
 * OpenTelemetry emission for Agent Thrash Detection (v0.6.0). Consumes a
 * ThrashDetectedEvent (src/thrash/detector.js) and emits telemetry only —
 * no detection logic lives here, and nothing here decides whether a loop
 * happened (that's already been fully decided and tested in isolation by
 * detector.js). This module is pure OTel plumbing: 5 metric instruments,
 * registered on the same instrumentation scope as the v0.3 mcp.tool.*
 * instruments (see src/metrics.js — both call
 * metrics.getMeter('opentel-mcp', packageVersion); the OTel API defines
 * meter identity by that name+version pair, not by JS object identity, so
 * a second getMeter() call here still reports under the same meter to any
 * backend), plus one span event and one boolean span attribute (ADR 011,
 * docs/adr/011-cost-aware-sampling.md) on the currently active span.
 *
 * Metric attributes are gen_ai.tool.name ONLY. mcp.failure.fingerprint and
 * mcp.loop.session_id are deliberately excluded from every metric here —
 * see src/fingerprint/attributes.js's METRIC_SAFE_ATTRIBUTES docblock:
 * both are unbounded, per-caller values (a new bug is a new fingerprint,
 * forever; a new session is a new session id, forever), so putting either
 * on a metric label would turn every distinct bug/session into its own
 * permanent time series. Both are still fully available on the
 * mcp.loop.detected span event below, where high-cardinality attributes
 * are safe (each span is its own record, not a label on a shared series).
 */

import { trace, metrics } from '@opentelemetry/api';
import { ATTR_GEN_AI_TOOL_NAME } from '../attributes.js';
import { ATTRIBUTE_KEYS } from '../fingerprint/attributes.js';
import {
  SPAN_EVENT_NAME_LOOP_DETECTED,
  ATTR_MCP_LOOP_LENGTH,
  ATTR_MCP_LOOP_WASTED_TOKENS_IN,
  ATTR_MCP_LOOP_WASTED_TOKENS_OUT,
  ATTR_MCP_LOOP_WASTED_COST_USD,
  ATTR_MCP_LOOP_DURATION_MS,
  ATTR_MCP_LOOP_FIRST_SPAN_ID,
  ATTR_MCP_LOOP_FIRST_TRACE_ID,
  ATTR_MCP_LOOP_SESSION_ID,
  ATTR_MCP_TOOL_THRASH_DETECTED,
} from './attributes.js';

/** @typedef {import('./types.d.ts').ThrashDetectedEvent} ThrashDetectedEvent */

/**
 * Creates the mcp.tool.loop.* instruments and returns an emit() wrapper,
 * mirroring src/metrics.js's setupMeter() shape. Kept as its own function
 * (not folded into setupMeter() itself) so that v0.3 file stays untouched.
 *
 * @param {string} packageVersion
 * @returns {{ emit: (event: ThrashDetectedEvent) => void }}
 */
export function createThrashEmitter(packageVersion) {
  const meter = metrics.getMeter('opentel-mcp', packageVersion);

  const detected = meter.createCounter('mcp.tool.loop.detected', {
    description:
      'Number of agent thrash loops detected — the same tool failing with the same failure fingerprint repeatedly.',
  });
  const length = meter.createHistogram('mcp.tool.loop.length', {
    description: "Number of consecutive same-fingerprint failures in a detected loop, at the moment of detection.",
  });
  const wastedTokens = meter.createHistogram('mcp.tool.loop.wasted_tokens', {
    description: 'Total input + output tokens burned by a detected loop so far.',
    unit: 'tokens',
  });
  const wastedCostUsd = meter.createHistogram('mcp.tool.loop.wasted_cost_usd', {
    description: 'Total estimated USD cost burned by a detected loop so far.',
    unit: 'USD',
  });
  const duration = meter.createHistogram('mcp.tool.loop.duration', {
    description: "Elapsed time between a detected loop's first and most recent failure.",
    unit: 'ms',
  });

  return {
    /**
     * Emits all 5 metrics, and — only when there's a current, recording
     * span (via trace.getActiveSpan(); this never creates a new span) —
     * one mcp.loop.detected span event carrying the full detail,
     * including mcp.failure.fingerprint and mcp.loop.session_id (neither
     * of which ever goes on a metric label — see this module's docblock),
     * plus (ADR 011, docs/adr/011-cost-aware-sampling.md) a boolean
     * mcp.tool.thrash_detected span ATTRIBUTE on that same span — a
     * Collector tail-sampling policy can key on it directly, without
     * depending on whether span-event data is matchable at all (see
     * thrash/attributes.js's ATTR_MCP_TOOL_THRASH_DETECTED docblock). Set
     * only to `true`, never `false` — this call site only runs when a
     * loop was actually detected. Never throws: a broken meter/instrument,
     * a malformed event, or no active span all degrade to a silent no-op
     * rather than surfacing to the caller, matching this library's
     * fail-open philosophy. Metrics and the span event/attribute are
     * independently guarded, so a failure in one never suppresses the
     * other.
     *
     * @param {ThrashDetectedEvent} event
     */
    emit(event) {
      try {
        const metricAttrs = { [ATTR_GEN_AI_TOOL_NAME]: event.toolName };
        detected.add(1, metricAttrs);
        length.record(event.loopLength, metricAttrs);
        wastedTokens.record(event.wastedTokensIn + event.wastedTokensOut, metricAttrs);
        wastedCostUsd.record(event.wastedCostUsd, metricAttrs);
        duration.record(event.durationMs, metricAttrs);
      } catch {
        // Never throw — see emit()'s docblock.
      }

      try {
        const span = trace.getActiveSpan();
        if (!span || !span.isRecording()) return;

        span.addEvent(SPAN_EVENT_NAME_LOOP_DETECTED, {
          [ATTR_MCP_LOOP_LENGTH]: event.loopLength,
          [ATTR_MCP_LOOP_WASTED_TOKENS_IN]: event.wastedTokensIn,
          [ATTR_MCP_LOOP_WASTED_TOKENS_OUT]: event.wastedTokensOut,
          [ATTR_MCP_LOOP_WASTED_COST_USD]: event.wastedCostUsd,
          [ATTR_MCP_LOOP_DURATION_MS]: event.durationMs,
          [ATTR_MCP_LOOP_FIRST_SPAN_ID]: event.firstSpanId,
          [ATTR_MCP_LOOP_FIRST_TRACE_ID]: event.firstTraceId,
          [ATTR_MCP_LOOP_SESSION_ID]: event.sessionId,
          [ATTRIBUTE_KEYS.FINGERPRINT]: event.fingerprint,
        });
        span.setAttribute(ATTR_MCP_TOOL_THRASH_DETECTED, true);
      } catch {
        // Never throw — see emit()'s docblock.
      }
    },
  };
}
