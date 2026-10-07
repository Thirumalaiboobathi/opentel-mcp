/**
 * The connect screen's snippet (web/data/connect.ts) must be something a
 * user can paste and run. Checked against opentel-mcp core itself, not
 * against a copy of its API in this package:
 *
 * 1. statically, against core's published typings (src/index.d.ts): the
 *    imported name is exported, the call is `instrumentMcpServer(server,
 *    { ... })`, and every option key is a real `InstrumentOptions` key;
 * 2. by running the snippet's call against a real McpServer and the real
 *    core, so a missing required option (e.g. `serviceName` with
 *    `setupNodeSdk: true`) fails here instead of in a user's terminal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { trace, metrics, context } from '@opentelemetry/api';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as core from 'opentel-mcp';
import { connectSnippet, OTLP_TRACES_PATH } from '../web/data/connect.ts';

const require = createRequire(import.meta.url);
const corePkgPath = require.resolve('opentel-mcp/package.json');
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'));
const coreTypings = readFileSync(join(dirname(corePkgPath), corePkg.types), 'utf8');

const ENDPOINT = `http://127.0.0.1:4319${OTLP_TRACES_PATH}`;
const snippet = connectSnippet(ENDPOINT);

function instrumentOptionKeys() {
  const start = coreTypings.indexOf('export interface InstrumentOptions {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = coreTypings.indexOf('\n}', start);
  const block = coreTypings.slice(start, end);
  return new Set([...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]));
}

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

describe('connect-screen snippet vs. opentel-mcp core', () => {
  it("imports a function core really exports, under that exact name and package", () => {
    const match = snippet.match(/^import \{ (\w+) \} from '([^']+)';$/m);
    expect(match).not.toBeNull();
    const [, name, from] = match;
    expect(from).toBe(corePkg.name);
    expect(typeof core[name]).toBe('function');
    expect(coreTypings).toMatch(new RegExp(`export function ${name}<[^>]+>\\(\\s*server: T,\\s*options\\?: InstrumentOptions,`));
  });

  it('calls it as (server, options) -- the server argument first, then an options object', () => {
    expect(snippet).toMatch(/^instrumentMcpServer\(server, \{$/m);
    expect(snippet.trimEnd().endsWith('});')).toBe(true);
  });

  it('uses only real InstrumentOptions keys', () => {
    const keys = [...snippet.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['serviceName', 'setupNodeSdk', 'exporterUrl']);
    const real = instrumentOptionKeys();
    for (const key of keys) expect(real.has(key)).toBe(true);
  });

  it("points exporterUrl at this dashboard's OTLP receiver path", () => {
    expect(snippet).toContain(`exporterUrl: '${ENDPOINT}',`);
  });

  it('runs against a real McpServer and the real core without throwing', async () => {
    const server = new McpServer({ name: 'snippet-check', version: '0.0.0' });
    // Everything after the import line, executed with the real export bound
    // to the imported name and a real server bound to `server`.
    const body = snippet.split('\n').filter((line) => !line.startsWith('import ')).join('\n');
    const run = new Function('instrumentMcpServer', 'server', body);
    expect(() => run(core.instrumentMcpServer, server)).not.toThrow();
    // setupNodeSdk: true really took effect (core attaches shutdown() only then).
    expect(typeof server.shutdown).toBe('function');
    await server.shutdown();
  });
});
