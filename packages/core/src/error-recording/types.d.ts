/**
 * Shared type definitions for exception-recording mode (ADR 019,
 * docs/adr/019-raw-content-on-spans.md — Part 1, v0.13.0 Phase 1) and the
 * `redactor` hook (ADR 020, docs/adr/020-redactor-hook.md, v0.14.0).
 *
 * Hand-written, not a compiled build artifact — this project ships plain
 * JS with no TypeScript build step (see CONTRIBUTING.md). {@link ErrorRecordingConfig},
 * {@link ErrorRecordingRedactor}, and {@link ErrorRecordingRedactorFields}
 * are re-exported from src/index.d.ts (via instrumentMcpServer()'s
 * `options.errorRecording`), the same pattern src/thrash/types.d.ts's
 * `ThrashConfig` and src/schema-drift/types.d.ts's `SchemaDriftConfig`
 * already establish: hand-written types here, kept in sync with
 * src/error-recording/config.js's/redactor.js's own JSDoc `@typedef`s by
 * hand, not by a build step.
 */

/**
 * The `{ message, stack }` shape {@link ErrorRecordingRedactor} both
 * receives as input and must return as output (ADR 020 Decision 1: one
 * hook, one call per thrown-exception event, covering both fields
 * together — the same shape describes what goes in and what's expected
 * to come back out). Mirrors `applyRedactor()`'s own internal
 * `RedactorInput` JSDoc typedef (src/error-recording/redactor.js) — this
 * is that same contract, named for public consumption.
 */
export interface ErrorRecordingRedactorFields {
  readonly message: string;
  readonly stack: string | undefined;
}

/**
 * A host-supplied redaction hook for `errorRecording.mode: 'normalized'`
 * — see {@link ErrorRecordingConfig.redactor}'s own doc for the complete
 * behavioral contract (ordering, mode-gating, failure fallback, length
 * capping, fingerprint isolation). ADR 020,
 * docs/adr/020-redactor-hook.md. Exported as a standalone, nameable type
 * (rather than only inline on `ErrorRecordingConfig.redactor`) so a
 * consumer can type a redactor function on its own — e.g. in a separate
 * module, before passing it into `errorRecording.redactor` — the same
 * pattern `UsageExtractor` (src/cost/types.d.ts) and `Classifier`
 * (src/fingerprint/types.d.ts) already establish for this codebase's
 * other function-shaped config hooks.
 */
export type ErrorRecordingRedactor = (input: ErrorRecordingRedactorFields) => ErrorRecordingRedactorFields;

/**
 * Resolved error-recording config — see src/error-recording/config.js's
 * `resolveErrorRecordingConfig()`, which this mirrors field-for-field.
 * `mode` is required here (this is the RESOLVED shape, after
 * defaults/env vars have been applied — it's always one of the three
 * literal modes, never absent); `redactor` stays optional even after
 * resolution, since "no redactor configured" is itself a legitimate
 * resolved state, not a default to fall back from (there's no default
 * function). {@link instrumentMcpServer}'s `errorRecording` option
 * accepts `Partial<ErrorRecordingConfig>` — see src/index.d.ts. Same
 * pattern as `ThrashConfig`/`SchemaDriftConfig`.
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
   *   `node_modules` version-collapsed), never the raw `err.stack`. If
   *   `redactor` (below) is configured, it runs first — see that
   *   field's own doc.
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

  /**
   * A host-supplied redaction hook for content this library's own
   * `normalizeMessage()`/`parseAndNormalizeStack()` don't recognize —
   * a proprietary API key format, an internal account id shape, a
   * customer name embedded in prose or in a multi-tenant stack frame
   * path. See ADR 020 (`docs/adr/020-redactor-hook.md`) for the full
   * design; summarized here:
   *
   * - Only consulted when `mode === 'normalized'`. Under `'full'` or
   *   `'none'` it's accepted but never called (Decision 6) — and
   *   configuring one alongside either of those produces a one-time
   *   `diag.warn()` naming the no-op, since that's an easy
   *   misconfiguration to hit silently (forgetting to also flip `mode`).
   * - Called once per thrown-exception event, on raw `message`/`stack`
   *   (via the same coercion this library's own pipeline uses),
   *   **before** `normalizeMessage()`/`parseAndNormalizeStack()` run —
   *   never the reverse (Decision 2). A message-only redactor can just
   *   return `stack` unchanged.
   * - Applies to the **span only**. `computeFingerprint()`'s
   *   `mcp.failure.*` hash inputs are always computed from the real,
   *   unmodified `err` — identically whether or not a redactor is
   *   configured. This is deliberate and non-negotiable (Decision 3):
   *   the fingerprint is a SHA-256 hash, never a plaintext channel, so
   *   redacting it buys nothing while tying fingerprint stability to
   *   unversioned host code.
   * - Must be synchronous and must return `{ message: string, stack:
   *   string | undefined }`. A redactor that throws, returns a
   *   non-string `message`, or returns a `stack` that's neither a
   *   string nor `undefined` causes that event to fall back to
   *   `'none'`-equivalent output (status only, no `exception` event) —
   *   never to raw/unredacted content (Decision 4) — plus a one-time,
   *   content-free `diag.warn()`.
   * - The returned `message`/`stack` are length-capped defensively
   *   before use, regardless of what a well-behaved redactor is
   *   expected to return (Decision 5).
   * - No environment-variable equivalent — a function can't be
   *   expressed as an `OTEL_MCP_*` string. JS-config-only, same as
   *   `costTracking.extractor`/`thrashDetection`'s classifier-shaped
   *   options already are.
   *
   * @default undefined
   */
  redactor?: ErrorRecordingRedactor;
}
