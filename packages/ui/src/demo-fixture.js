/**
 * @module demo-fixture
 *
 * Seeds a realistic mix of `SerializedSpan`s so the dashboard can be run
 * and screenshotted without a live MCP server (`npx opentel-mcp-ui
 * --demo`, or `withUI(server, { demo: true })`). Not test data in the
 * unit-test sense — this is fixture data for VISUAL review, so the mix
 * deliberately matches the shape the design brief itself illustrates:
 * mostly clean successes, a handful of thrown/protocol failures a naive
 * OTel setup would also catch, and a meaningful cluster of silent
 * failures (isError: true inside a 200) that only opentel-mcp reveals —
 * the exact comparison this whole project exists to make visible.
 */

const TOOL_NAMES = ['search', 'read_file', 'write_file', 'run_query', 'send_email'];

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(16).padStart(6, '0')}`;
}

/**
 * @param {{ toolName: string, startTimeMs: number, durationMs: number, status: 'OK'|'ERROR', errorType?: string, failureCategory?: string, failureChannel?: string, attributes?: Record<string, unknown> }} spec
 * @returns {import('./types.d.ts').SerializedSpan}
 */
function makeSpan(spec) {
  return {
    id: nextId('span'),
    traceId: nextId('trace'),
    name: `tools/call ${spec.toolName}`,
    toolName: spec.toolName,
    startTimeMs: spec.startTimeMs,
    durationMs: spec.durationMs,
    status: spec.status,
    ...(spec.errorType ? { errorType: spec.errorType } : {}),
    ...(spec.failureCategory ? { failureCategory: spec.failureCategory } : {}),
    ...(spec.failureChannel ? { failureChannel: spec.failureChannel } : {}),
    argumentCount: 1 + (idCounter % 4),
    attributes: spec.attributes ?? {},
  };
}

/**
 * @returns {import('./types.d.ts').SerializedSpan[]} oldest-first.
 */
export function buildDemoFixture() {
  const now = Date.now();
  let t = now - 5 * 60_000;
  const spans = [];

  const tick = (ms) => {
    t += ms;
    return t;
  };

  // 42 clean successes, spread across every demo tool.
  for (let i = 0; i < 42; i++) {
    const toolName = TOOL_NAMES[i % TOOL_NAMES.length];
    spans.push(
      makeSpan({
        toolName,
        startTimeMs: tick(1200 + (i % 5) * 300),
        durationMs: 20 + (i % 7) * 15,
        status: 'OK',
        attributes: { 'mcp.tool.argument_count': 1 + (i % 3) },
      }),
    );
  }

  // 7 thrown/protocol failures -- VISIBLE to standard OTel (status ERROR,
  // errorType is the exception's own name, never 'tool_error').
  const thrown = [
    ['TypeError', 'read_file'],
    ['McpError', 'run_query'],
    ['RangeError', 'search'],
    ['TypeError', 'send_email'],
    ['McpError', 'write_file'],
    ['Error', 'run_query'],
    ['TimeoutError', 'search'],
  ];
  for (const [errorType, toolName] of thrown) {
    spans.push(
      makeSpan({
        toolName,
        startTimeMs: tick(2000),
        durationMs: 8 + (idCounter % 20),
        status: 'ERROR',
        errorType,
        failureCategory: 'protocol_error',
        failureChannel: errorType === 'McpError' ? 'protocol.other' : 'unknown',
      }),
    );
  }

  // 11 silent failures -- MISSED by standard OTel: isError: true inside
  // an otherwise-successful response. This is the product.
  const silentCategories = [
    'validation_error',
    'not_found',
    'permission_denied',
    'validation_error',
    'rate_limited',
    'validation_error',
    'not_found',
    'timeout',
    'validation_error',
    'permission_denied',
    'not_found',
  ];
  for (let i = 0; i < 11; i++) {
    const toolName = TOOL_NAMES[i % TOOL_NAMES.length];
    spans.push(
      makeSpan({
        toolName,
        startTimeMs: tick(1800),
        durationMs: 30 + (i % 6) * 10,
        status: 'ERROR',
        errorType: 'tool_error',
        failureCategory: silentCategories[i],
        failureChannel: 'execution',
        attributes: {
          'mcp.failure.fingerprint': `fp-${silentCategories[i]}-${i}`,
        },
      }),
    );
  }

  return spans;
}
