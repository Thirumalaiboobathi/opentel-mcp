/**
 * @module tool-integrity/emitter
 *
 * OTel emission for tool definition integrity (ADR 029): span events on the active tools/list span, and the
 * `mcp.tool.integrity_violations` counter (label: gen_ai.tool.name only). Never throws. Tool names and hashes
 * only: no description, schema or annotation text.
 */

import { trace, metrics } from '@opentelemetry/api';
import { ATTR_GEN_AI_TOOL_NAME } from '../attributes.js';
import {
  SPAN_EVENT_INTEGRITY_CHANGED,
  SPAN_EVENT_INTEGRITY_PIN_MISMATCH,
  SPAN_EVENT_INTEGRITY_ADDED,
  SPAN_EVENT_INTEGRITY_REMOVED,
  ATTR_INTEGRITY_OLD_HASH,
  ATTR_INTEGRITY_NEW_HASH,
  ATTR_INTEGRITY_EXPECTED_HASH,
  ATTR_INTEGRITY_ACTUAL_HASH,
  ATTR_INTEGRITY_SEVERITY,
  INTEGRITY_SEVERITY_HIGH,
  METRIC_INTEGRITY_VIOLATIONS,
} from './attributes.js';

/**
 * @param {string} packageVersion
 * @param {boolean} enableMetrics
 */
export function createToolIntegrityEmitter(packageVersion, enableMetrics) {
  const violations = enableMetrics
    ? metrics.getMeter('opentel-mcp', packageVersion).createCounter(METRIC_INTEGRITY_VIOLATIONS, {
        description:
          'Number of tools whose definition changed since first seen or no longer matches a configured pin (ADR 029). Detection only.',
      })
    : null;

  return {
    /**
     * @param {import('./tracker.js').Observation} observation
     * @param {import('@opentelemetry/api').Span} [explicitSpan] - The tools/list span. Passed in rather than read
     *   from the active context, so events land on it even where the host registered no context manager.
     */
    emit(observation, explicitSpan) {
      try {
        for (const tool of observation.violationTools) {
          try {
            violations?.add(1, { [ATTR_GEN_AI_TOOL_NAME]: tool });
          } catch {
            // never throw
          }
        }
      } catch {
        // never throw
      }
      try {
        const span = explicitSpan ?? trace.getActiveSpan();
        if (!span || !span.isRecording()) return;
        for (const f of observation.findings) {
          try {
            /** @type {Record<string, string>} */
            const attrs = { [ATTR_GEN_AI_TOOL_NAME]: f.tool };
            let name;
            if (f.kind === 'changed') {
              name = SPAN_EVENT_INTEGRITY_CHANGED;
              attrs[ATTR_INTEGRITY_OLD_HASH] = /** @type {string} */ (f.oldHash);
              attrs[ATTR_INTEGRITY_NEW_HASH] = /** @type {string} */ (f.newHash);
            } else if (f.kind === 'pin_mismatch') {
              name = SPAN_EVENT_INTEGRITY_PIN_MISMATCH;
              attrs[ATTR_INTEGRITY_EXPECTED_HASH] = /** @type {string} */ (f.expected);
              attrs[ATTR_INTEGRITY_ACTUAL_HASH] = /** @type {string} */ (f.actual);
              attrs[ATTR_INTEGRITY_SEVERITY] = INTEGRITY_SEVERITY_HIGH;
            } else if (f.kind === 'added') {
              name = SPAN_EVENT_INTEGRITY_ADDED;
              attrs[ATTR_INTEGRITY_NEW_HASH] = /** @type {string} */ (f.newHash);
            } else {
              name = SPAN_EVENT_INTEGRITY_REMOVED;
              if (f.oldHash) attrs[ATTR_INTEGRITY_OLD_HASH] = f.oldHash;
            }
            span.addEvent(name, attrs);
          } catch {
            // never throw
          }
        }
      } catch {
        // never throw
      }
    },
  };
}

/**
 * The dev-mode `pins` snippet (setupNodeSdk: true), written once to stderr (never stdout: stdio transports use it).
 *
 * @param {Record<string, string>} hashes
 * @returns {string}
 */
export function formatPinsSnippet(hashes) {
  const lines = Object.keys(hashes)
    .sort()
    .map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(hashes[name])},`);
  return (
    '[opentel-mcp] toolIntegrity: current tool definition hashes. To pin them, pass:\n' +
    '  toolIntegrity: {\n' +
    '    enabled: true,\n' +
    '    pins: {\n' +
    lines.join('\n') +
    '\n    },\n' +
    '  },\n'
  );
}
