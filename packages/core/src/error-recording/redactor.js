/**
 * @module error-recording/redactor
 * Core logic for the host-supplied `errorRecording.redactor` hook (ADR 020,
 * docs/adr/020-redactor-hook.md). v0.14.0 Phase 1: this module implements
 * the hook's safety wrapper only — validating and capping a redactor's
 * output, and the one-time failure warning. It is not yet called from
 * `src/instrument.js`; wiring `applyRedactor()` into
 * `recordThrownException()`'s `'normalized'` branch, ahead of
 * `normalizeMessage()`/`parseAndNormalizeStack()` (Decision 2's ordering),
 * is a later phase.
 *
 * Deliberately does not import anything from `../fingerprint/compose.js` or
 * `./normalize/exception.js` — Decision 3 is precisely that this hook must
 * never be reachable from the fingerprint-hashing path, and not importing
 * that path's entry point here is one more structural guard against a
 * future edit accidentally wiring it in.
 */

import { diag } from '@opentelemetry/api';
import { MAX_INPUT_LENGTH } from '../fingerprint/normalize/message.js';

/**
 * Decision 5: the redactor's returned `message`/`stack` are length-capped
 * defensively before use, reusing `normalizeMessage()`'s own
 * `MAX_INPUT_LENGTH` (2048) rather than a second magic number.
 * `normalizeMessage()` truncates to this same length as its first step, so
 * this cap is only load-bearing for `stack` today — `parseAndNormalizeStack()`
 * bounds frame *count*, not per-frame length, which is the gap this closes.
 */
export const MAX_REDACTOR_OUTPUT_LENGTH = MAX_INPUT_LENGTH;

/**
 * @typedef {{ message: string, stack: string | undefined }} RedactorInput
 */

/**
 * @typedef {object} RedactorFailureState
 * @property {boolean} warnedFailed - Caller-owned, mutated in place. One
 *   instance is meant to live for the lifetime of one `instrumentMcpServer()`
 *   call (the same granularity `costAttributionState`/`thrashSessionState`
 *   already use in src/instrument.js for their own one-time diagnostics) —
 *   not a module-level global, so a fresh instrumented server gets a fresh
 *   warning budget.
 */

/**
 * Runs a host-supplied `errorRecording.redactor` against `input` and
 * returns its validated, capped output — or `null` if the redactor
 * misbehaved, per ADR 020 Decision 4.
 *
 * Called exactly once per invocation (Decision 1: one hook, one call,
 * covering both `message` and `stack` together). `redactor` is assumed to
 * already be a real function — `resolveErrorRecordingConfig()`
 * (./config.js) is what guarantees that; this function doesn't re-validate
 * `redactor` itself, only its return value.
 *
 * Failure modes, all treated identically (Decision 4 — fall back to
 * `'none'`-equivalent, never to raw content):
 *   - `redactor` throws.
 *   - `redactor` returns something whose `.message` isn't a string
 *     (covers a non-object return, `undefined`, `null`, and an object
 *     with a missing/wrong-typed `message`).
 *   - `redactor` returns a `.stack` that's neither a string nor `undefined`.
 *
 * On any of those, fires `warnRedactorFailedOnce()` below (shape-only, no
 * content) at most once per `state`, and returns `null`. The caller (once
 * wired into `recordThrownException()`) is responsible for turning that
 * `null` into the actual `'none'`-equivalent span behavior — this function
 * only decides pass/fail, it doesn't touch a span.
 *
 * On success, returns `{ message, stack }` with both fields capped to
 * {@link MAX_REDACTOR_OUTPUT_LENGTH} (Decision 5). `stack` stays
 * `undefined` if the redactor returned `undefined` for it — never coerced
 * to a string.
 *
 * @param {RedactorInput} input
 * @param {(input: RedactorInput) => unknown} redactor
 * @param {RedactorFailureState} state
 * @returns {RedactorInput | null}
 */
export function applyRedactor(input, redactor, state) {
  let result;
  let failureReason = null;

  try {
    result = redactor(input);
  } catch {
    failureReason = 'threw';
  }

  if (!failureReason) {
    if (typeof result?.message !== 'string') {
      failureReason = 'returned a non-string message';
    } else if (result.stack !== undefined && typeof result.stack !== 'string') {
      failureReason = 'returned an invalid stack (neither a string nor undefined)';
    }
  }

  if (failureReason) {
    warnRedactorFailedOnce(failureReason, state);
    return null;
  }

  return {
    message: result.message.slice(0, MAX_REDACTOR_OUTPUT_LENGTH),
    stack: result.stack === undefined ? undefined : result.stack.slice(0, MAX_REDACTOR_OUTPUT_LENGTH),
  };
}

/**
 * ADR 020 Decision 4's one-time, content-free failure diagnostic.
 *
 * CRITICAL: reports the failure *shape* only (`reason`, one of the fixed
 * strings `applyRedactor()` assigns above) — never `input`, never
 * `redactor`'s return value. A warning that echoed the very content a
 * redaction hook exists to keep off telemetry would just relocate the leak
 * from spans to logs (the same reasoning `warnRejectedModel()`,
 * src/instrument.js, already applies to ADR 019 Part 2's own warning).
 *
 * Fires at most once per `state` — see {@link RedactorFailureState}'s own
 * docblock for the intended lifetime of that object. Never throws.
 *
 * @param {string} reason
 * @param {RedactorFailureState} state
 */
function warnRedactorFailedOnce(reason, state) {
  if (state.warnedFailed) return;
  state.warnedFailed = true;

  try {
    diag.warn(
      `opentel-mcp: the errorRecording redactor ${reason} for this call; falling back to no exception content ` +
        '(span status only, no exception event) for this event — never to raw/unredacted content. This warning ' +
        'fires once per instrumentMcpServer() call and deliberately never logs the message/stack content ' +
        'involved — see docs/adr/020-redactor-hook.md Decision 4.',
    );
  } catch {
    // Never throw — matches every other diagnostic in this codebase.
  }
}
