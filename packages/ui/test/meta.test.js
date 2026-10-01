import { describe, it, expect } from 'vitest';
import { describeInMemoryTrackerAvailability, inspectTransport } from '../src/meta.js';

/** Stdio-shaped transport: connected, no sessionId property (matches core's own isSingleConnectionTransport() check). */
function stdioShapedServer() {
  return { transport: { start: () => {}, send: () => {} } };
}

/** Session-oriented transport: connected, exposes a sessionId getter (StreamableHTTPServerTransport/SSEServerTransport shape). */
function sessionOrientedServer() {
  return { transport: { start: () => {}, send: () => {}, get sessionId() { return 'session-abc'; } } };
}

/** McpServer-wrapped low-level Server -- transport lives on .server.transport, not .transport directly. */
function mcpServerWrapped(transport) {
  return { server: { transport } };
}

function unconnectedServer() {
  return {};
}

describe('inspectTransport', () => {
  it('reports single-connection for a stdio-shaped transport (no sessionId)', () => {
    expect(inspectTransport(stdioShapedServer()).shape).toBe('single-connection');
  });

  it('reports session-oriented for a transport exposing sessionId', () => {
    expect(inspectTransport(sessionOrientedServer()).shape).toBe('session-oriented');
  });

  it('reports undeterminable when transport is not yet connected', () => {
    expect(inspectTransport(unconnectedServer()).shape).toBe('undeterminable');
  });

  it('finds the transport through .server.transport for McpServer-wrapped objects, same duck-typing core itself uses', () => {
    expect(inspectTransport(mcpServerWrapped({ start() {} })).shape).toBe('single-connection');
    expect(
      inspectTransport(mcpServerWrapped({ start() {}, get sessionId() { return 'x'; } })).shape,
    ).toBe('session-oriented');
  });
});

describe('describeInMemoryTrackerAvailability -- BOTH transport modes, per acceptance criteria', () => {
  it('STATEFUL / single-connection transport (e.g. stdio): reports live', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: stdioShapedServer(),
      statelessTransport: 'auto',
    });
    expect(result.status).toBe('live');
  });

  it('STATELESS HTTP transport, explicitly asserted: reports unavailable, citing ADR 012', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: sessionOrientedServer(),
      statelessTransport: true,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('ADR 012');
    expect(result.reason).toContain('Thrash detection unavailable');
  });

  it('session-oriented transport under auto-detection: reports unknown (correlated risk), never a false-confident live or unavailable', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: sessionOrientedServer(),
      statelessTransport: 'auto',
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('ADR 012');
  });

  it('explicit statelessTransport: false always wins, even over a session-oriented transport', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: sessionOrientedServer(),
      statelessTransport: false,
    });
    expect(result.status).toBe('live');
  });

  it('undeterminable transport under auto-detection: reports unknown, not a guess', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: unconnectedServer(),
      statelessTransport: 'auto',
    });
    expect(result.status).toBe('unknown');
  });

  it('is generic over which tracker -- the label is substituted, not hardcoded to thrash', () => {
    const result = describeInMemoryTrackerAvailability('Schema drift detection', {
      instrumentedServer: sessionOrientedServer(),
      statelessTransport: true,
    });
    expect(result.reason).toContain('Schema drift detection unavailable');
  });

  it('demo: true short-circuits every other check -- never the "re-check after the server connects" text, which would be wrong when no server exists at all (ADR 022)', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: null,
      statelessTransport: 'auto',
      demo: true,
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('--demo mode');
    expect(result.reason).not.toContain('re-check');
  });

  it('demo: true wins even over an explicit statelessTransport assertion', () => {
    const result = describeInMemoryTrackerAvailability('Thrash detection', {
      instrumentedServer: null,
      statelessTransport: true,
      demo: true,
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('--demo mode');
  });
});
