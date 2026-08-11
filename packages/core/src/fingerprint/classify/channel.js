/**
 * @module fingerprint/classify/channel
 *
 * Classifies which channel an MCP tools/call failure arrived on, per ADR
 * 007 (docs/adr/007-protocol-error-channel.md):
 *
 *   - 'execution' — a JSON-RPC-successful CallToolResult carrying
 *     isError: true, whose message does NOT look like a disguised
 *     protocol failure (see below). The call reached the tool and the
 *     tool itself reports a genuine business-logic failure.
 *   - 'protocol.*' — the failure originated at the RPC/dispatch layer,
 *     not inside the tool's own logic. Sub-classified by JSON-RPC error
 *     code and, for -32602 (InvalidParams) — which the current
 *     @modelcontextprotocol/sdk overloads across at least four unrelated
 *     conditions — by the SDK's message-prefix convention (ADR 007's
 *     Claim B).
 *   - 'unknown' — the input doesn't confidently resemble either shape.
 *
 * IMPORTANT, confirmed against a real McpServer (Phase 3 verification):
 * the high-level McpServer (`@modelcontextprotocol/sdk/server/mcp.js`) —
 * the ergonomic `.tool()`/`.registerTool()` API most real MCP servers
 * use — catches essentially every error its own tools/call dispatcher can
 * produce (tool not found, disabled, input validation, output
 * validation, or any other bug) and converts it to `isError: true` BEFORE
 * this ever runs, with the sole exception of UrlElicitationRequired
 * errors. Without the recovery step below, that would make
 * 'protocol.not_found' / 'protocol.input' / 'protocol.output' entirely
 * UNREACHABLE for McpServer users — every one of those conditions would
 * collapse into 'execution', which is exactly the false positive ADR 007
 * exists to fix, just relocated rather than closed. McpServer preserves
 * the original McpError's message verbatim in `content[0].text` when it
 * does this conversion — including the "MCP error {code}: " prefix its
 * constructor always adds (see recoverDisguisedProtocolFailure() below) —
 * so that text is inspected first, and only falls through to 'execution'
 * when it doesn't match that shape (i.e. it's a genuine, tool-authored
 * business-logic message).
 *
 * ADR 015 Phase 3 (`docs/adr/015-mcp-v2-support.md`): a v2
 * (`@modelcontextprotocol/server`) McpServer disguises failures
 * differently, confirmed live against the real package — see
 * recoverV2DisguisedValidationFailure() below for the details and why it
 * needs neither the "MCP error N: " wrapper nor a numeric code at all.
 * `classifyByCodeAndMessage()`/`classifyInvalidParams()` needed NO v2
 * change: v2's `ProtocolError` exposes `.code` as a real, directly-
 * readable property and `.message` as the raw, unwrapped text (confirmed
 * live), so the genuine-JSON-RPC-error path at the bottom of
 * `classifyFailureChannel()` — which already read `.code`/`.message`
 * directly, never by parsing a code out of a string — works against v2
 * unmodified. Only the isError:true disguise-recovery path needed a v2
 * counterpart.
 *
 * Named "channel", not "origin": `origin` already names a different field
 * on FingerprintInputs (`fingerprint/types.d.ts`), with a different,
 * longer-lived value set ('tool_error' | 'thrown' | 'transport') that has
 * been part of the hashed fingerprint input since v0.4.0. Reusing the name
 * here would collide with that existing, unrelated concept — see ADR 007's
 * "Where the new dimension lives" section.
 *
 * Not wired into computeFingerprint() or DEFAULT_CLASSIFIERS (that
 * registry's Classifier contract returns FailureCategory, a different
 * type). Pure, synchronous, no OTel — a plain data-in/data-out classifier
 * over whatever failure shape the caller has in hand.
 *
 * `FailureChannel` (the return type) is re-exported from the package root
 * as of v0.7.0 Phase 4 (`src/index.d.ts` -> `src/fingerprint/types.d.ts`).
 * `classifyFailureChannel()` itself is NOT re-exported from `src/index.js`
 * — it stays internal to this package's own wiring (`src/instrument.js`),
 * the same way `ThrashDetector`/`createThrashEmitter` are internal despite
 * their result types being public (see `src/index.d.ts`'s thrash section).
 */

/** @typedef {import('../types.d.ts').FailureChannel} FailureChannel */

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

// Matched against the failure's message text. Note this is NOT matched
// against the raw human-readable string a tool author might expect: an
// McpError's .message getter (see @modelcontextprotocol/sdk's types.js)
// always returns `MCP error ${code}: ${originalMessage}` — the SDK bakes
// its own "MCP error N: " wrapper in front of the text before either of
// these markers, and that wrapper is also what ends up in the JSON-RPC
// wire response's error.message (shared/protocol.js reuses error.message
// verbatim) AND in a disguised isError:true result's content[0].text (see
// recoverDisguisedProtocolFailure() below). So every check below uses
// .includes()/a bare RegExp test, never .startsWith() or an anchored ^
// pattern.
const INPUT_VALIDATION_MARKER = 'Input validation error:';
const OUTPUT_VALIDATION_MARKER = 'Output validation error:';
// Tool-not-found / tool-disabled carry no distinguishing prefix at all in
// the current SDK — just "Tool X not found" / "Tool X disabled" — so
// these are matched as loose, case-insensitive substrings rather than a
// fixed marker. This is the least stable part of this classifier (see ADR
// 007's fragility discussion) and is expected to need revisiting against
// future SDK versions.
const NOT_FOUND_RE = /\bnot found\b/i;
const DISABLED_RE = /\bdisabled\b/i;

// Matches the exact wrapper McpError's constructor always applies:
// `MCP error ${code}: ${message}` (see @modelcontextprotocol/sdk's
// types.js). `\s*` rather than a literal single space, and the `s` flag,
// are deliberately lenient about incidental formatting variance — this is
// already the least stable part of this classifier (see ADR 007); no
// reason to make it any more brittle than it has to be.
const MCP_ERROR_WRAPPER_RE = /^MCP error (-?\d+):\s*([\s\S]*)$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Disambiguates a -32602 (InvalidParams) failure's message into one of
 * the (at least) four conditions the current SDK overloads that single
 * code across. Falls back to 'protocol.other' — never guesses — when the
 * message is missing, empty, or doesn't match any known shape, including
 * a future SDK wording change.
 *
 * @param {unknown} message
 * @returns {FailureChannel}
 */
function classifyInvalidParams(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return 'protocol.other';
  }
  if (message.includes(INPUT_VALIDATION_MARKER)) return 'protocol.input';
  if (message.includes(OUTPUT_VALIDATION_MARKER)) return 'protocol.output';
  if (NOT_FOUND_RE.test(message) || DISABLED_RE.test(message)) return 'protocol.not_found';
  return 'protocol.other';
}

/**
 * Shared by both the genuine-JSON-RPC-error path and the
 * disguised-in-isError:true recovery path below, so a -32601/-32602
 * failure classifies identically regardless of which shape it happened
 * to arrive in.
 *
 * @param {number} code
 * @param {unknown} message
 * @returns {FailureChannel}
 */
function classifyByCodeAndMessage(code, message) {
  if (code === JSONRPC_METHOD_NOT_FOUND) return 'protocol.not_found';
  if (code === JSONRPC_INVALID_PARAMS) return classifyInvalidParams(message);
  return 'protocol.other';
}

/**
 * Reads `result.content[0].text` defensively — missing/non-array
 * `content`, an empty array, a non-object first element, or a non-string
 * `text` all resolve to `undefined` rather than throwing.
 *
 * @param {Record<string, unknown>} result
 * @returns {string | undefined}
 */
function firstContentText(result) {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!isPlainObject(first)) return undefined;
  return typeof first.text === 'string' ? first.text : undefined;
}

/**
 * Recovers channel classification for a protocol-shaped failure McpServer
 * (`@modelcontextprotocol/sdk/server/mcp.js`) has already converted to
 * `isError: true` — see this module's docblock for why that conversion
 * happens for nearly every McpServer-thrown McpError. Returns `null`
 * (never a channel value) when `result.content[0].text` doesn't match the
 * exact "MCP error {code}: " wrapper McpError's constructor always
 * applies — which is the correct outcome for a genuine, tool-authored
 * business-logic error message, not a disguised protocol failure.
 *
 * @param {Record<string, unknown>} result
 * @returns {FailureChannel | null}
 */
function recoverDisguisedProtocolFailure(result) {
  const text = firstContentText(result);
  if (text === undefined) return null;

  const match = MCP_ERROR_WRAPPER_RE.exec(text);
  if (!match) return null;

  const code = Number(match[1]);
  if (!Number.isInteger(code)) return null;

  return classifyByCodeAndMessage(code, match[2]);
}

/**
 * Recovers channel classification for a v2 (`@modelcontextprotocol/server`)
 * disguised protocol failure. Structurally simpler than
 * recoverDisguisedProtocolFailure() above, for two confirmed-live reasons
 * (ADR 015 Finding 4):
 *
 *   1. There is no "MCP error N: " wrapper to unwrap at all — v2's
 *      `ProtocolError` constructor sets `.message` to the raw text
 *      directly, and that raw text is exactly what ends up in a disguised
 *      `isError: true` result's `content[0].text` too. There is no code
 *      embedded anywhere in that text to recover, so — unlike
 *      `recoverDisguisedProtocolFailure()`, which exists specifically to
 *      extract a code and hand it to `classifyByCodeAndMessage()` — this
 *      function never needs `classifyByCodeAndMessage()`/`classifyInvalidParams()`
 *      at all. It only ever needs to know whether one of the two
 *      validation markers is present.
 *   2. v2's own McpServer only disguises input/output validation failures
 *      this way. Tool-not-found and tool-disabled now throw as real,
 *      undisguised `ProtocolError`s instead (confirmed by directly
 *      invoking a real v2 McpServer's captured `tools/call` handler: a
 *      nonexistent-tool call threw, uncaught by McpServer's own try/catch;
 *      a bad-argument call was caught and disguised). That condition
 *      cannot occur in the disguised shape for v2 at all, so — unlike
 *      `classifyInvalidParams()`, which still checks `NOT_FOUND_RE`/
 *      `DISABLED_RE` because v1 genuinely can disguise those — this
 *      function deliberately carries no not-found/disabled branch. Dead
 *      code for a case that can't happen would be worse than no code at
 *      all: a future reader would have no way to tell "unreachable, by
 *      design" from "reachable, just never observed yet."
 *
 * The marker strings themselves (`INPUT_VALIDATION_MARKER` /
 * `OUTPUT_VALIDATION_MARKER`, above) are confirmed byte-identical to v1's —
 * v2 kept the exact same wording — so no new constants were needed here.
 *
 * Ordering note (see classifyFailureChannel() below): this is only ever
 * tried AFTER recoverDisguisedProtocolFailure() has already returned
 * `null`. That ordering is load-bearing, not incidental — a v1-disguised
 * message's WRAPPED text (`"MCP error -32602: Input validation error: ..."`)
 * still *contains* `INPUT_VALIDATION_MARKER` as a substring, so if this
 * function ran first (or alone) it would also match v1 text — just less
 * precisely, without recovering the wrapper's code. Trying the more
 * specific, anchored v1 check first and falling through to this looser,
 * unanchored one only on a miss is what keeps the two from stepping on
 * each other, without needing to know in advance which SDK produced the
 * failure.
 *
 * @param {Record<string, unknown>} result
 * @returns {FailureChannel | null}
 */
function recoverV2DisguisedValidationFailure(result) {
  const text = firstContentText(result);
  if (text === undefined) return null;

  if (text.includes(INPUT_VALIDATION_MARKER)) return 'protocol.input';
  if (text.includes(OUTPUT_VALIDATION_MARKER)) return 'protocol.output';
  return null;
}

/**
 * Determines which channel an MCP tools/call failure arrived on. Accepts
 * either shape a caller might have in hand:
 *
 *   - A CallToolResult-like object with `isError: true`. Its
 *     `content[0].text` is checked first for a v1-shaped disguised
 *     protocol failure (see recoverDisguisedProtocolFailure() and this
 *     module's docblock), then a v2-shaped one
 *     (recoverV2DisguisedValidationFailure() — ADR 015 Phase 3); if
 *     neither matches, this is the execution channel — a genuine
 *     business-logic tool failure. Any property other than `isError`/
 *     `content` (e.g. a stray top-level `code`) is irrelevant here: only
 *     the recovery steps read into the result for a protocol code/marker,
 *     never a top-level `code` field a CallToolResult was never meant to
 *     carry.
 *   - A JSON-RPC-error-like object (an McpError instance, or a plain
 *     `{ code, message }` shape read off the wire) — the protocol
 *     channel, sub-classified by `code` and, for -32602, by `message`.
 *
 * Never throws, never guesses: any input this can't confidently place —
 * malformed, missing both `isError` and an integer `code`, or a -32602
 * whose message doesn't match a known shape — resolves to 'unknown' or
 * 'protocol.other' rather than a wrong specific answer.
 *
 * @param {unknown} failure
 * @returns {FailureChannel}
 */
export function classifyFailureChannel(failure) {
  try {
    if (!isPlainObject(failure)) {
      return 'unknown';
    }

    if (failure.isError === true) {
      // v1 tried first, deliberately — see recoverV2DisguisedValidationFailure()'s
      // own docblock for why the order is load-bearing.
      return recoverDisguisedProtocolFailure(failure) ?? recoverV2DisguisedValidationFailure(failure) ?? 'execution';
    }

    const code = failure.code;
    if (typeof code !== 'number' || !Number.isInteger(code)) {
      return 'unknown';
    }

    return classifyByCodeAndMessage(code, failure.message);
  } catch {
    return 'unknown';
  }
}
