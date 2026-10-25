import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as attrs from '../src/attributes.js';
import * as fpAttrs from '../src/fingerprint/attributes.js';
import { CONFORMANCE_DIR, buildContract } from '../scripts/gen-conformance.mjs';

/**
 * ADR 028 Decision 4: conformance/contract.json is what the Python port
 * must emit. JS is the source of truth, so this asserts the file equals
 * what attributes.js, fingerprint/attributes.js and metrics.js export and
 * register (metrics through an in-memory MeterProvider).
 */
describe('conformance/contract.json (ADR 028)', () => {
  const committed = JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, 'contract.json'), 'utf8'));

  it('equals the live core contract', async () => {
    expect(await buildContract()).toEqual(committed);
  });

  it('lists every span attribute key core exports for the tools/call span', () => {
    const a = committed.span.attributes;
    expect(a.methodName).toBe(attrs.ATTR_MCP_METHOD_NAME);
    expect(a.genAiOperationName).toBe(attrs.ATTR_GEN_AI_OPERATION_NAME);
    expect(a.genAiToolName).toBe(attrs.ATTR_GEN_AI_TOOL_NAME);
    expect(a.toolArgumentCount).toBe(attrs.ATTR_MCP_TOOL_ARGUMENT_COUNT);
    expect(a.jsonrpcRequestId).toBe(attrs.ATTR_JSONRPC_REQUEST_ID);
    expect(a.errorType).toBe(attrs.ATTR_ERROR_TYPE);
    expect(committed.span.fingerprintAttributes).toEqual({ ...fpAttrs.ATTRIBUTE_KEYS });
  });

  it('allowlists equal the live frozen arrays, and every metric label key is on one of them', () => {
    expect(committed.allowlists.metricSafeAttributes).toEqual([...attrs.METRIC_SAFE_ATTRIBUTES]);
    expect(committed.allowlists.fingerprintMetricSafeAttributes).toEqual([...fpAttrs.METRIC_SAFE_ATTRIBUTES]);
    const allowed = new Set([...committed.allowlists.metricSafeAttributes, ...committed.allowlists.fingerprintMetricSafeAttributes]);
    for (const m of committed.metrics) {
      for (const k of [...m.labelKeys, ...m.optionalLabelKeys]) expect(allowed.has(k), `${m.name}: ${k}`).toBe(true);
    }
  });
});
