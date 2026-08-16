import { describe, it, expect, vi, afterEach } from 'vitest';
import { diag } from '@opentelemetry/api';
import * as resources from '@opentelemetry/resources';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { instrumentMcpServer } from '../../src/instrument.js';
import { __resetPricingStaleWarnedForTests } from '../../src/config.js';
import { DEFAULT_PRICING_LAST_VERIFIED } from '../../src/cost/pricing.js';
import { ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED } from '../../src/attributes.js';

/** ADR 016 point 3: DEFAULT_PRICING staleness — one-time diag.warn, gated on whether DEFAULT_PRICING is actually in play. */
describe('DEFAULT_PRICING staleness warning', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createServer(name = 'test-server') {
    return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
  }

  it('does not warn when DEFAULT_PRICING is well within the 90-day threshold', () => {
    __resetPricingStaleWarnedForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 10 * 24 * 60 * 60 * 1000));
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    instrumentMcpServer(createServer(), { serviceName: 'svc' });

    const pricingWarnings = warnSpy.mock.calls.filter(([msg]) => /DEFAULT_PRICING was last verified/.test(msg));
    expect(pricingWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('warns exactly once per process once DEFAULT_PRICING is stale, across multiple instrumented servers', () => {
    __resetPricingStaleWarnedForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 200 * 24 * 60 * 60 * 1000));
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    instrumentMcpServer(createServer('a'), { serviceName: 'svc-a' });
    instrumentMcpServer(createServer('b'), { serviceName: 'svc-b' });

    const pricingWarnings = warnSpy.mock.calls.filter(([msg]) => /DEFAULT_PRICING was last verified/.test(msg));
    expect(pricingWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('does not warn when a full custom pricingTable replaces DEFAULT_PRICING', () => {
    __resetPricingStaleWarnedForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 200 * 24 * 60 * 60 * 1000));
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    instrumentMcpServer(createServer(), {
      serviceName: 'svc',
      costTracking: { pricingTable: { m: { pricingKind: 'chat', inputPer1M: 1, outputPer1M: 1, currency: 'USD' } } },
    });

    const pricingWarnings = warnSpy.mock.calls.filter(([msg]) => /DEFAULT_PRICING was last verified/.test(msg));
    expect(pricingWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('does not warn when costTracking is disabled', () => {
    __resetPricingStaleWarnedForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 200 * 24 * 60 * 60 * 1000));
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    instrumentMcpServer(createServer(), { serviceName: 'svc', costTracking: { enabled: false } });

    const pricingWarnings = warnSpy.mock.calls.filter(([msg]) => /DEFAULT_PRICING was last verified/.test(msg));
    expect(pricingWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('still warns when only a partial pricing override is supplied (DEFAULT_PRICING is still the base)', () => {
    __resetPricingStaleWarnedForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(DEFAULT_PRICING_LAST_VERIFIED) + 200 * 24 * 60 * 60 * 1000));
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});

    instrumentMcpServer(createServer(), {
      serviceName: 'svc',
      costTracking: { pricing: { 'claude-sonnet-5': { pricingKind: 'chat', inputPer1M: 1, outputPer1M: 1, currency: 'USD' } } },
    });

    const pricingWarnings = warnSpy.mock.calls.filter(([msg]) => /DEFAULT_PRICING was last verified/.test(msg));
    expect(pricingWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

describe('DEFAULT_PRICING staleness resource attribute (setupNodeSdk: true only)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createServer(name = 'test-server') {
    return new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
  }

  it('attaches mcp.pricing.default_table_last_verified to the resource it constructs', () => {
    __resetPricingStaleWarnedForTests();
    const resourceSpy = vi.spyOn(resources, 'resourceFromAttributes');
    const server = createServer();

    const instrumented = instrumentMcpServer(server, { serviceName: 'svc', setupNodeSdk: true });

    expect(resourceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ [ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED]: DEFAULT_PRICING_LAST_VERIFIED }),
    );

    resourceSpy.mockRestore();
    return instrumented.shutdown?.();
  });

  it('omits the resource attribute when a full custom pricingTable replaces DEFAULT_PRICING', () => {
    __resetPricingStaleWarnedForTests();
    const resourceSpy = vi.spyOn(resources, 'resourceFromAttributes');
    const server = createServer();

    const instrumented = instrumentMcpServer(server, {
      serviceName: 'svc',
      setupNodeSdk: true,
      costTracking: { pricingTable: { m: { pricingKind: 'chat', inputPer1M: 1, outputPer1M: 1, currency: 'USD' } } },
    });

    const [[calledWith]] = resourceSpy.mock.calls;
    expect(calledWith).not.toHaveProperty(ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED);

    resourceSpy.mockRestore();
    return instrumented.shutdown?.();
  });
});
