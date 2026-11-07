import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as attrs from '../src/attributes.js';
import * as fpAttrs from '../src/fingerprint/attributes.js';
import { CONFORMANCE_DIR, CONTRACT_VERSION, buildContract } from '../scripts/gen-conformance.mjs';

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

  it('has its own integer contractVersion, independent of the core package version (ADR 034 amendment)', () => {
    expect(Number.isInteger(committed.contractVersion) && committed.contractVersion >= 1).toBe(true);
    expect(committed.contractVersion).toBe(CONTRACT_VERSION);
    expect(typeof committed.coreVersion).toBe('string');
    expect(committed).not.toHaveProperty('contract');
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

  it('security (ADR 034 amendment): the v0.18 signals are in the shared contract, with allow-listed labels only', () => {
    const names = committed.metrics.map((m) => m.name);
    expect(names).toEqual([
      'mcp.tool.calls',
      'mcp.tool.errors',
      'mcp.tool.silent_failures',
      'mcp.tool.duration',
      'mcp.tool.auth_failures',
      'mcp.tool.secret_leaks',
      'mcp.tool.integrity_violations',
    ]);
    for (const m of committed.metrics.slice(4)) expect(m.labelKeys).toEqual(['gen_ai.tool.name']);
    const sec = committed.security;
    for (const e of sec.spanEvents) expect(e.name).toMatch(/^mcp\.(tool\.integrity|audit)\./);
    expect(sec.secretTypes).toEqual(['url_credentials', 'jwt', 'http_auth_credential', 'aws_access_key_id', 'provider_api_key', 'secret_assignment']);
    expect(sec.secretLeak.budgetUnit).toBe('utf16-code-units');
    // every secret step in patterns.json names one of the types
    const patterns = JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, 'patterns.json'), 'utf8'));
    for (const step of patterns.secretSteps) expect(sec.secretTypes).toContain(step.type);
  });

  it('jsOnly now lists only what the Python port does not implement (clock skew)', () => {
    const js = committed.jsOnly;
    expect(js.spanAttributes).toEqual(['mcp.tool.freshness.clock_skew_ms']);
    expect(js.options).toEqual(['staleness.clockSkewToleranceMs']);
    expect(js).not.toHaveProperty('metrics');
    expect(js).not.toHaveProperty('spanEvents');
  });
});
