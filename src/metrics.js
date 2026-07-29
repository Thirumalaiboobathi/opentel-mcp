/**
 * @module metrics
 * OpenTelemetry Metrics instruments for opentel-mcp.
 *
 * Follows the same @opentelemetry/api-only pattern as tracing (see
 * setupTracer() in instrument.js): instruments come from
 * metrics.getMeter(), which resolves to whatever MeterProvider the host
 * application has already registered globally, or the API's built-in
 * no-op implementation if none has. This module never creates or
 * registers a MeterProvider itself — recording through it is a
 * zero-overhead no-op until the host does. See config.js's enableMetrics
 * option for the opt-out, and the README's "Metrics" section for how to
 * wire up a real MeterProvider.
 *
 * Unlike @opentelemetry/api's tracing API, its metrics API (as of
 * @opentelemetry/api ^1.9) does not proxy a not-yet-registered
 * MeterProvider — metrics.getMeter() resolves the current global
 * synchronously at call time rather than lazily delegating later. So, as
 * with setupTracer(), setupMeter() must run after the host application has
 * registered its MeterProvider (the same ordering the README already
 * documents for tracing).
 *
 * There are two, unrelated attributes.js files in this package: this
 * module's sibling ./attributes.js holds the MCP-semconv span/metric
 * attribute constants (ATTR_ERROR_TYPE, ATTR_MCP_TOOL_OUTCOME, ...);
 * ./fingerprint/attributes.js holds the separate failure-classification
 * attribute keys (mcp.failure.category, ...) added by the fingerprinting
 * feature. They are deliberately not merged — see that module's own
 * docblock for why.
 */

import { metrics } from '@opentelemetry/api';
import {
  ATTR_MCP_METHOD_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_ERROR_TYPE,
  ATTR_MCP_TOOL_OUTCOME,
  ATTR_MCP_TOOL_MODEL,
  MCP_METHOD_NAME_TOOLS_CALL,
} from './attributes.js';
import { ATTRIBUTE_KEYS } from './fingerprint/attributes.js';

/**
 * Creates the mcp.tool.* instruments and returns small record*() wrappers
 * around them, keyed to the well-known attribute names above so call
 * sites in instrument.js never construct attribute bags by hand.
 *
 * `failureCategory` (recordError, recordSilentFailure, recordDuration) is
 * optional and, when a non-empty string, adds ATTRIBUTE_KEYS.CATEGORY
 * (mcp.failure.category — see ./fingerprint/attributes.js) to the
 * attribute bag. It's the one fingerprint attribute low-cardinality
 * enough to be metric-safe (see METRIC_SAFE_ATTRIBUTES); callers omit it
 * (or pass '') when fingerprinting is disabled or produced no category.
 *
 * `model` (recordTokens, recordCost) follows the same optional-attribute
 * pattern: added to the bag only when the cost extractor actually found a
 * model name (see instrument.js's applyCostAttribution()), so a run with
 * no model detection doesn't create a spurious `mcp.tool.model: undefined`
 * time series. Model names are bounded in practice by how many distinct
 * models a deployment actually calls, the same cardinality argument this
 * package already relies on for `gen_ai.tool.name` on every other counter.
 *
 * @param {string} packageVersion
 * @returns {{
 *   recordCall: (toolName: string | undefined) => void,
 *   recordError: (toolName: string | undefined, errorType: string, failureCategory?: string) => void,
 *   recordSilentFailure: (toolName: string | undefined, failureCategory?: string) => void,
 *   recordDuration: (toolName: string | undefined, durationMs: number, outcome: string, failureCategory?: string) => void,
 *   recordTokens: (toolName: string | undefined, model: string | undefined, totalTokens: number) => void,
 *   recordCost: (toolName: string | undefined, model: string | undefined, costUsd: number) => void,
 * }}
 */
export function setupMeter(packageVersion) {
  const meter = metrics.getMeter('opentel-mcp', packageVersion);

  const calls = meter.createCounter('mcp.tool.calls', {
    description: 'Number of MCP tool calls received, regardless of outcome.',
  });
  const errors = meter.createCounter('mcp.tool.errors', {
    description: 'Number of MCP tool calls whose handler threw or rejected (protocol-level failure).',
  });
  const silentFailures = meter.createCounter('mcp.tool.silent_failures', {
    description:
      'Number of MCP tool calls whose JSON-RPC response succeeded but whose CallToolResult had isError: true.',
  });
  const duration = meter.createHistogram('mcp.tool.duration', {
    description: 'Duration of MCP tool call execution.',
    unit: 'ms',
  });
  const tokensTotal = meter.createCounter('mcp.tool.tokens.total', {
    description: 'Total input + output tokens attributed to MCP tool calls (see src/cost/extractor.js).',
    unit: 'tokens',
  });
  const costTotal = meter.createCounter('mcp.tool.cost.total', {
    description: 'Total estimated cost of MCP tool calls (see src/cost/calculator.js).',
    unit: 'USD',
  });

  return {
    recordCall(toolName) {
      calls.add(1, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        [ATTR_MCP_METHOD_NAME]: MCP_METHOD_NAME_TOOLS_CALL,
      });
    },
    recordError(toolName, errorType, failureCategory) {
      errors.add(1, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        [ATTR_ERROR_TYPE]: errorType,
        ...(failureCategory ? { [ATTRIBUTE_KEYS.CATEGORY]: failureCategory } : {}),
      });
    },
    recordSilentFailure(toolName, failureCategory) {
      silentFailures.add(1, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        ...(failureCategory ? { [ATTRIBUTE_KEYS.CATEGORY]: failureCategory } : {}),
      });
    },
    recordDuration(toolName, durationMs, outcome, failureCategory) {
      duration.record(durationMs, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        [ATTR_MCP_TOOL_OUTCOME]: outcome,
        ...(failureCategory ? { [ATTRIBUTE_KEYS.CATEGORY]: failureCategory } : {}),
      });
    },
    recordTokens(toolName, model, totalTokens) {
      tokensTotal.add(totalTokens, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        ...(model ? { [ATTR_MCP_TOOL_MODEL]: model } : {}),
      });
    },
    recordCost(toolName, model, costUsd) {
      costTotal.add(costUsd, {
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
        ...(model ? { [ATTR_MCP_TOOL_MODEL]: model } : {}),
      });
    },
  };
}
