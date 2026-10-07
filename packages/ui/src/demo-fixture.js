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

// Per-tool allocation (0.2.0): chosen so the per-tool health grades
// (web/data/healthGrades.ts, docs/health-grades.md) show a realistic
// spread -- read_file A, search B (latency), write_file C, run_query D,
// send_email F, list_calendars "Not enough data" -- while the overall
// 42 / 7 / 11 mix above stays exactly as the README describes it.
const SUCCESS_ALLOCATION = [
  ['read_file', 12],
  ['search', 10],
  ['write_file', 9],
  ['run_query', 6],
  ['send_email', 3],
  ['list_calendars', 2],
];

const THRASH_ATTRIBUTE = 'mcp.tool.thrash_detected';

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

  // 42 clean successes. `search` is the slow one (1.2-2.1 s).
  const successTools = SUCCESS_ALLOCATION.flatMap(([toolName, count]) => Array(count).fill(toolName));
  let searchCalls = 0;
  for (let i = 0; i < successTools.length; i++) {
    const toolName = successTools[i];
    spans.push(
      makeSpan({
        toolName,
        startTimeMs: tick(1200 + (i % 5) * 300),
        durationMs: toolName === 'search' ? 1200 + 100 * searchCalls++ : 20 + (i % 7) * 15,
        status: 'OK',
        attributes: { 'mcp.tool.argument_count': 1 + (i % 3) },
      }),
    );
  }

  // 7 thrown/protocol failures -- VISIBLE to standard OTel (status ERROR,
  // errorType is the exception's own name, never 'tool_error').
  const thrown = [
    ['TypeError', 'send_email'],
    ['McpError', 'run_query'],
    ['RangeError', 'send_email'],
    ['TypeError', 'send_email'],
    ['McpError', 'send_email'],
    ['Error', 'run_query'],
    ['TimeoutError', 'send_email'],
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
  const silentTools = [
    'send_email',
    'run_query',
    'send_email',
    'write_file',
    'send_email',
    'send_email',
    'run_query',
    'send_email',
    'send_email',
    'send_email',
    'send_email',
  ];
  // Calls opentel-mcp core flagged as completing a thrash loop.
  const thrashAt = new Set([6, 9, 10]);
  for (let i = 0; i < 11; i++) {
    const toolName = silentTools[i];
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
          ...(thrashAt.has(i) ? { [THRASH_ATTRIBUTE]: true } : {}),
        },
      }),
    );
  }

  return spans;
}
