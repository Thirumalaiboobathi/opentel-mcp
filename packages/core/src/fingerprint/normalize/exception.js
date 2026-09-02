/**
 * @module fingerprint/normalize/exception
 *
 * Single entry point for turning a thrown/failure value into normalized
 * exception content — coercion into a `{ name, message, stack, code,
 * status }` shape, plus the normalized message and stack that both
 * `computeFingerprint()` (`../compose.js`, for `mcp.failure.*`) and
 * `errorRecording.mode`'s `'normalized'` span-writing path
 * (`../../instrument.js`'s `recordThrownException()`, for
 * `exception.message`/`exception.stacktrace`) need from the SAME `err`.
 *
 * Before this module existed, each of those two call sites independently
 * re-derived "the message"/"the stack" from raw `err` fields —
 * `computeFingerprint()` via the richer `coerceError()` below (handling a
 * thrown string, a `CallToolResult`-shaped `isError: true` object, or a
 * plain object with no `.message` at all), `recordThrownException()` via a
 * simpler, independent `err?.message`/`err?.stack` read that silently
 * produced no `exception.message` for exactly the shapes `coerceError()`
 * does handle. Same inputs, two code paths, free to drift apart on the
 * next edit to either one — see the README's "Error recording" section
 * ("Caveat 2") and `docs/known-gaps.md` entry 10 for the trace-scoping
 * issue this consolidation was prompted alongside (a separate concern:
 * that finding is about content leaving this library's span entirely,
 * this one is about the two things THIS library itself writes about the
 * same `err` disagreeing with each other). Routing both consumers through
 * `normalizeException()` below means the span's exception event and the
 * fingerprint's hashed inputs are read from one computation, not two —
 * they cannot diverge by construction, not just by convention.
 */

import { normalizeMessage } from './message.js';
import { parseAndNormalizeStack } from './stack.js';

/** @typedef {import('../types.d.ts').NormalizedStackFrame} NormalizedStackFrame */

/**
 * Reduces any thrown/failure value into a normalized `{ name, message,
 * stack, code, status }` shape the rest of the pipeline can rely on.
 *
 * Callers that need to treat `null`/`undefined` specially (no content to
 * coerce at all) must check for that themselves before calling this —
 * same convention `computeFingerprint()` already followed pre-extraction,
 * kept unchanged here rather than folded in, since `null`/`undefined`
 * means something different to each caller (a FALLBACK fingerprint
 * result vs. a bare-status span with no exception event content).
 *
 * @param {unknown} err Never null/undefined — callers filter that case.
 * @returns {{ name: string, message: string, stack: string | undefined, code: unknown, status: unknown }}
 */
export function coerceError(err) {
  if (typeof err === 'string') {
    return { name: 'Error', message: err, stack: undefined, code: undefined, status: undefined };
  }

  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      status: err.status ?? err.statusCode,
    };
  }

  if (err && typeof err === 'object' && err.isError === true && Array.isArray(err.content)) {
    return {
      name: 'MCPToolError',
      message: err.content[0]?.text ?? '',
      stack: undefined,
      code: undefined,
      status: undefined,
    };
  }

  const obj = err ?? {};
  return {
    name: obj.name ?? 'Error',
    message: obj.message ?? String(obj),
    stack: obj.stack,
    code: obj.code,
    status: obj.status ?? obj.statusCode,
  };
}

/**
 * Coerces `err`, then normalizes its message and stack — the one
 * computation both `computeFingerprint()` and `recordThrownException()`'s
 * `'normalized'` mode consume, instead of each calling `coerceError()` /
 * `normalizeMessage()` / `parseAndNormalizeStack()` independently.
 *
 * @param {unknown} err Never null/undefined — callers filter that case,
 *   same as {@link coerceError}.
 * @param {{ cwd?: string, maxFrames?: number }} [opts] Forwarded to
 *   {@link parseAndNormalizeStack} unchanged — callers that want the
 *   fingerprint's shorter, hash-stable frame count (`compose.js`'s
 *   `DEFAULT_STACK_FRAMES`) vs. errorRecording's own default pass their
 *   own `maxFrames`; the coercion and message-normalization steps are
 *   identical either way.
 * @returns {{
 *   coerced: ReturnType<typeof coerceError>,
 *   normalizedMessage: string,
 *   frames: NormalizedStackFrame[],
 *   stackSignature: string,
 * }}
 */
export function normalizeException(err, opts = {}) {
  const coerced = coerceError(err);
  const normalizedMessage = normalizeMessage(coerced.message);
  const { frames, signature: stackSignature } = parseAndNormalizeStack(coerced.stack, opts);
  return { coerced, normalizedMessage, frames, stackSignature };
}
