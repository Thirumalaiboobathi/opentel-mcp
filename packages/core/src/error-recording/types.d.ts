/**
 * Shared type definitions for exception-recording mode (ADR 019,
 * docs/adr/019-raw-content-on-spans.md — Part 1, v0.13.0 Phase 1).
 *
 * Hand-written, not a compiled build artifact — this project ships plain
 * JS with no TypeScript build step (see CONTRIBUTING.md). {@link ErrorRecordingConfig}
 * is re-exported from src/index.d.ts (via instrumentMcpServer()'s
 * `options.errorRecording`), the same pattern src/thrash/types.d.ts's
 * `ThrashConfig` and src/schema-drift/types.d.ts's `SchemaDriftConfig`
 * already establish: a hand-written interface here, kept in sync with
 * src/error-recording/config.js's own JSDoc `@typedef` by hand, not by a
 * build step.
 */

/**
 * Resolved error-recording config — see src/error-recording/config.js's
 * `resolveErrorRecordingConfig()`, which this mirrors field-for-field. All
 * fields are required here (this is the RESOLVED shape, after
 * defaults/env vars have been applied); {@link instrumentMcpServer}'s
 * `errorRecording` option accepts `Partial<ErrorRecordingConfig>` — see
 * src/index.d.ts. Same pattern as `ThrashConfig`/`SchemaDriftConfig`.
 */
export interface ErrorRecordingConfig {
  /**
   * Controls what a thrown exception (as opposed to a tool-level
   * `isError: true` result, which never carries a JS `Error` and is
   * unaffected by this option) puts on the `tools/call`/`tools/list`
   * span, per ADR 019 Part 1:
   *
   * - `'full'` — `span.recordException(err)` plus `span.setStatus({
   *   message: err.message })`, exactly as every release before
   *   v0.13.0. `exception.message`/`exception.stacktrace` carry
   *   `err.message`/`err.stack` verbatim, uncapped — matching the OTel
   *   ecosystem's own default (see ADR 019's "What OpenTelemetry's own
   *   semantic conventions say").
   * - `'normalized'` — the same `exception` event shape, but
   *   `exception.message` is run through `normalizeMessage()`
   *   (`src/fingerprint/normalize/message.js` — the same
   *   UUID/email/URL/IP/timestamp/path/hex/quoted-id scrubbing already
   *   used before fingerprint hashing) and `exception.stacktrace` is
   *   rebuilt from `parseAndNormalizeStack()`'s frames
   *   (`src/fingerprint/normalize/stack.js` — cwd-stripped,
   *   `node_modules` version-collapsed), never the raw `err.stack`.
   * - `'none'` — `span.setStatus({ code: ERROR })` only: no `message`,
   *   no `exception` event at all. The same pattern already used for a
   *   tool-level `isError: true` failure.
   *
   * `error.type` is capped at 128 characters regardless of this
   * setting — see ADR 019 Part 1, "`error.type` — closing ADR 004's
   * open note as part of this design."
   *
   * @default 'full'
   */
  mode: 'full' | 'normalized' | 'none';
}
