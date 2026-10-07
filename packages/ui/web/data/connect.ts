/**
 * The OTLP/HTTP JSON receiver path every opentel-mcp-ui server exposes
 * (server.js's `POST /v1/traces` route).
 */
export const OTLP_TRACES_PATH = '/v1/traces';

/**
 * The exact snippet the connect screen shows to point an instrumented
 * server at this dashboard. Must match opentel-mcp core's real API:
 * `instrumentMcpServer(server, options)` (core's src/index.d.ts), with
 * `serviceName` required whenever `setupNodeSdk` is true (core's
 * config.js) and `exporterUrl` only taking effect with `setupNodeSdk: true`.
 * test/connect-snippet.test.js checks the import, the call shape and every
 * option key against core, and runs the snippet against a real server.
 */
export function connectSnippet(endpoint: string): string {
  return [
    "import { instrumentMcpServer } from 'opentel-mcp';",
    '',
    '// Before registering any tools:',
    'instrumentMcpServer(server, {',
    "  serviceName: 'my-mcp-server',",
    '  setupNodeSdk: true,',
    `  exporterUrl: '${endpoint}',`,
    '});',
  ].join('\n');
}
