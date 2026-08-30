/**
 * @module fingerprint/compose
 *
 * Ties classification, message normalization, and stack normalization
 * together into a single stable fingerprint for a failure.
 *
 * The whole pipeline runs under one top-level try/catch: any unexpected
 * shape or bug in a downstream step must never surface as a thrown error
 * to the caller (this runs inline in the instrumentation hot path), so a
 * single well-known FALLBACK result stands in for "couldn't fingerprint
 * this one" rather than letting a partial/inconsistent result leak out.
 */

import { hashInputs } from './hash.js';
import { normalizeMessage } from './normalize/message.js';
import { parseAndNormalizeStack } from './normalize/stack.js';
import { DEFAULT_CLASSIFIERS, runClassifiers } from './classify/index.js';

/** @typedef {import('./types.d.ts').FingerprintResult} FingerprintResult */
/** @typedef {import('./types.d.ts').FingerprintContext} FingerprintContext */
/** @typedef {import('./types.d.ts').ComputeFingerprintOptions} ComputeFingerprintOptions */

const HASH_INPUT_VERSION = 'v1';
const DEFAULT_STACK_FRAMES = 5;

// Known-gaps entry 10 (docs/known-gaps.md): `errorClass` is `err.name` (or
// a non-Error throwable's `.name`), and unlike `normalizedMessage` above it
// gets no NORMALIZE_STEPS scrubbing — it lands on `mcp.failure.error_class`
// (fingerprint/attributes.js) and `error.type` (instrument.js) exactly as
// whatever thrown value set it. In practice `.name` is almost always a
// short, fixed class identifier ("TypeError", "ZodError"), but nothing in
// the language enforces that — a tool author (or library it depends on)
// can assign any string. Capped here, not scrubbed like a message: a class
// name isn't expected to contain structured PII shapes (emails, ids, ...)
// the way a free-text message is, so pattern-matching would be reaching
// for a problem this value doesn't really have. Length is the actual
// unbounded dimension, so that's what's bounded. This also caps what feeds
// the fingerprint hash below, which is fine: two DIFFERENT long class
// names sharing an identical first 128 characters colliding into the same
// fingerprint is not a real-world scenario a normal class identifier ever
// produces.
const MAX_ERROR_CLASS_LENGTH = 128;

/**
 * @param {FingerprintContext} [ctx]
 * @returns {FingerprintResult}
 */
function buildFallback(ctx) {
  const origin = ctx?.origin;
  const toolName = ctx?.toolName ?? null;
  return {
    fingerprint: '0000000000000000',
    signature: 'unfingerprintable',
    category: 'unknown',
    origin,
    inputs: {
      errorClass: '',
      category: 'unknown',
      origin,
      toolName,
      normalizedMessage: '',
      stackSignature: '',
    },
  };
}

/**
 * Reduces any failure value into a normalized `{ name, message, stack,
 * code, status }` shape that the rest of the pipeline can rely on.
 *
 * @param {unknown} err Never null/undefined — callers filter that case.
 * @returns {{ name: string, message: string, stack: string | undefined, code: unknown, status: unknown }}
 */
function coerceError(err) {
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
 * Computes a stable identity fingerprint for a failure: same underlying
 * bug -> same fingerprint, regardless of high-cardinality noise (ids,
 * timestamps, addresses, ...) embedded in the message or stack.
 *
 * @param {unknown} err
 * @param {FingerprintContext} ctx
 * @param {ComputeFingerprintOptions} [opts]
 * @returns {FingerprintResult}
 */
export function computeFingerprint(err, ctx, opts = {}) {
  try {
    if (err === null || err === undefined) {
      return buildFallback(ctx);
    }

    const coerced = coerceError(err);
    const classifiers = opts.classifiers ?? DEFAULT_CLASSIFIERS;
    let category = runClassifiers(coerced, ctx, classifiers);

    const normalizedMessage = normalizeMessage(coerced.message);
    const { frames, signature: stackSignature } = parseAndNormalizeStack(coerced.stack, {
      cwd: ctx.cwd,
      maxFrames: opts.stackFrames ?? DEFAULT_STACK_FRAMES,
    });

    // Deferred from Phase 4: only overrides when the classifiers had no
    // signal at all, never a category a classifier actually committed to.
    if (category === 'internal' && frames.length > 0 && frames[0].file.startsWith('node_modules/')) {
      category = 'dependency';
    }

    const rawErrorClass = typeof coerced.name === 'string' ? coerced.name : String(coerced.name);
    const inputs = {
      errorClass: rawErrorClass.slice(0, MAX_ERROR_CLASS_LENGTH),
      category,
      origin: ctx.origin,
      toolName: ctx.toolName ?? null,
      normalizedMessage,
      stackSignature,
    };

    const fingerprint = hashInputs(
      `${HASH_INPUT_VERSION}|${inputs.errorClass}|${inputs.category}|${inputs.origin}|${inputs.toolName ?? ''}|${inputs.normalizedMessage}|${inputs.stackSignature}`,
    );

    const topFrame = frames[0];
    const signature = `${inputs.errorClass}@${topFrame?.fn || 'anon'}:${topFrame?.line ?? '?'}`.slice(0, 60);

    return {
      fingerprint,
      signature,
      category,
      origin: ctx.origin,
      inputs,
    };
  } catch {
    return buildFallback(ctx);
  }
}
