/**
 * @module fingerprint/classify/validation-paths
 *
 * Extracts which schema field(s) a Zod validation failure named, per ADR
 * 009 (docs/adr/009-field-level-convergence.md). The MCP TypeScript SDK's
 * `getParseErrorMessage()` (server/zod-compat.js) renders a ZodError into
 * a message string that survives verbatim into the thrown McpError's
 * message, and — same mechanism `classifyFailureChannel()` relies on
 * (fingerprint/classify/channel.js) — verbatim again into McpServer's
 * `isError: true` disguise of it. This module parses that rendered text,
 * not a live ZodError: by the time a failure reaches this instrumentation,
 * the structured object is gone (see ADR 009's Q2) — only ever the
 * rendered text remains.
 *
 * THREE rendering formats are parsed, because there are now two SDKs, and
 * one of them has already changed its own rendering once (confirmed
 * empirically going from @modelcontextprotocol/sdk@1.29.0 to 1.30.0 — see
 * ADR 009's addendum):
 *
 *   1. JSON issues array — `JSON.stringify(error.issues, ..., 2)`, the
 *      whole-array-with-`path`-fields shape `getParseErrorMessage()` used
 *      through SDK 1.29.0 (and still what you get if a low-level `Server`
 *      author throws a raw, unrendered `ZodError` directly — nothing
 *      guarantees they've upgraded, or ever rendered it through the SDK's
 *      helper at all).
 *   2. Rendered "`<message> at <dotPath>`" lines, one per issue, joined by
 *      `\n` — what `getParseErrorMessage()` produces as of
 *      @modelcontextprotocol/sdk 1.30.0.
 *      Root-level issues (empty `path`) render as just `<message>`, no
 *      " at " suffix at all.
 *   3. Rendered "`<dotPath>: <message>`" issues, comma-joined onto ONE
 *      line — what @modelcontextprotocol/server (v2, ADR 015 Phase 3)
 *      renders, confirmed live against the real, installed package.
 *      Traced to `formatIssue()`/`validateStandardSchema()` in v2's own
 *      bundle: `` `${path.join('.')}: ${message}` ``, issues joined by
 *      `", "`. Path comes FIRST here, unlike format 2 — and this format
 *      comes from v2's generic Standard Schema (standardschema.dev)
 *      `~standard.validate()` handling, not Zod-specific rendering the
 *      way formats 1 and 2 both are, so it renders identically whether a
 *      v2 tool author's schema is Zod, Valibot, ArkType, or any other
 *      Standard-Schema-compliant library. See `extractV2Paths()` below.
 *
 * JSON is tried first (it's self-validating — a successful, Zod-issue-
 * shaped parse is strong evidence either way — see `parseZodIssuesArray`)
 * and unconditionally preferred when it confidently matches. The two
 * rendered forms are tried only as fallbacks, and only within text that
 * already confirms it's SDK-validation-shaped (see `extractRenderedPaths`/
 * `extractV2Paths`) — unlike the JSON path, a bare rendered line is not
 * self-validating, so both formats lean on the same INPUT/OUTPUT_VALIDATION
 * marker `classify/channel.js` already trusts (ADR 007) rather than
 * pattern-matching arbitrary text. Format 2 and format 3 are mutually
 * exclusive by construction (one separates issues with `\n` and orders
 * `message at path`; the other separates with `, ` and orders
 * `path: message`), confirmed empirically rather than assumed — see
 * `extractV2Paths()`'s own docblock for why trying format 2 before format
 * 3 is still safe even so.
 *
 * This is best-effort, string-parsing extraction. Pure, synchronous, no
 * OTel, never throws: any input that doesn't confidently look like any
 * known rendering resolves to an empty array rather than a wrong or
 * partial guess.
 *
 * Standalone, like channel.js: not wired into computeFingerprint() (the
 * path text is already implicit in the hashed normalized message — see
 * ADR 009's "Where would extraction belong" — so hashing it again would
 * be redundant, not more correct) and not re-exported from src/index.js.
 *
 * FRAGILITY, stated plainly: this is now coupled to THREE independent
 * rendering conventions instead of one. A future format change in either
 * SDK breaks this again, exactly the way 1.30.0 broke the JSON-only
 * version — and the failure mode is silent: `[]`, not an exception, not a
 * warning. `test/fingerprint/classify.validation-paths.test.js`'s
 * SDK-version pins (one per SDK) exist specifically so that a future SDK
 * bump fails a test loudly instead of only degrading data quality
 * unnoticed. Format 3's genericity across schema libraries (Standard
 * Schema, not Zod-specific) should make it materially more stable than
 * formats 1/2 across FUTURE @modelcontextprotocol/server releases — but
 * that is an expectation, not a guarantee, and the pin discipline treats
 * it as such.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `result.content[0].text` defensively, mirroring
 * classify/channel.js's firstContentText() — missing/non-array
 * `content`, an empty array, a non-object first element, or a
 * non-string `text` all resolve to `undefined` rather than throwing.
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
 * Locates the first top-level `[...]` array substring in `text`, tracking
 * quoted-string state so a `[`/`]` character inside a JSON string value
 * (e.g. a Zod message like `"expected one of [a, b, c]"`) is never
 * mistaken for a structural bracket. Returns `null` — never a guessed
 * partial substring — when no balanced array is found (an unterminated
 * string, unbalanced brackets, or no `[` at all).
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractJsonArraySubstring(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced -- never guess a truncated substring
}

// Known-gaps entry 10 (docs/known-gaps.md): unlike the two RENDERED
// formats below (RENDERED_DOT_PATH_RE, V2_ISSUE_START_RE), this JSON
// format's `path` array comes straight from a parsed ZodError with no
// character restriction at all -- for a `z.record()`/map-shaped schema,
// a failing issue's `path` includes the actual runtime KEY the caller
// passed (e.g. an email address used as an object key), which is caller
// data, not a schema-declared field name. `PATH_SEGMENT_RE` gates each
// string segment against the same identifier-only shape the rendered
// formats already require (RENDERED_DOT_PATH_RE without the `.`/`[...]`
// chaining, since here each segment is already a separate array element,
// not a joined string to split) -- a segment that doesn't match is, by
// construction, not a schema-declared property name a tool author wrote,
// so it's treated as a dynamic key and redacted.
//
// Numeric segments (array indices) are never redacted: Zod only ever
// produces a `number` path segment for an array index, never for an
// object/record key (JSON object keys are always strings, even for a
// numeric-looking one) -- so a `number` segment is structurally always a
// small integer index, never caller-chosen content.
//
// What "redacted" means was a real choice among three, argued here rather
// than picked silently:
//   - Drop the whole path. Loses the entire signal for exactly the
//     validation failures a record-shaped schema exists to catch -- the
//     one case this gap is about is also the one case this option throws
//     away completely.
//   - Drop just the offending segment. WRONG, not just lossy: joining the
//     remaining segments produces a path that names a DIFFERENT, real
//     field. `["users", "<dynamic-key>", "email"]` dropped down to
//     `users.email` looks like a legitimate, confidently-reported path to
//     a field named `email` directly under `users` -- a fabricated
//     dot-path this feature's own "never guess" discipline (see this
//     module's docblock) exists specifically to rule out.
//   - Replace the segment with a fixed placeholder. Preserves the path's
//     shape and depth (still says "the failure was inside a record-like
//     value at this position") without leaking the key's content -- the
//     same shape/anomaly-signal-without-content-capture tradeoff
//     `mcp.tool.argument_count` already makes (`src/attributes.js`), and
//     the same placeholder-substitution mechanism `normalizeMessage()`'s
//     `NORMALIZE_STEPS` already uses for EMAIL/UUID/URL/etc.
//     (`normalize/patterns.js`). Chosen: it's the only option that
//     neither destroys the signal nor fabricates a wrong one.
const PATH_SEGMENT_RE = /^[\w$]+$/;
const REDACTED_PATH_SEGMENT = '<KEY>';

/**
 * Parses `jsonText` and, only if EVERY element confidently looks like a
 * Zod issue (a plain object with both a `path` array of string/number
 * segments and a string `message` — the two fields every Zod issue shape
 * carries across v3 and v4, confirmed empirically against both), returns
 * one dot-joined path string per issue. Returns `null` -- not a partial
 * result -- the moment any single element doesn't match: a JSON array
 * that happens to parse but isn't Zod-issue-shaped is not this feature's
 * business to guess at, and a MIX of matching/non-matching elements is
 * more likely a sign this isn't really a Zod issues array at all than a
 * reason to keep only the matching ones.
 *
 * Any string segment that isn't identifier-shaped (`PATH_SEGMENT_RE`) is
 * replaced with `REDACTED_PATH_SEGMENT` before joining — see the
 * constants' own comment above for why a placeholder, not a dropped
 * segment or a dropped path. Numeric segments (array indices) are never
 * redacted.
 *
 * @param {string} jsonText
 * @returns {string[] | null}
 */
function parseZodIssuesArray(jsonText) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const paths = [];
  for (const issue of parsed) {
    if (!isPlainObject(issue)) return null;
    if (typeof issue.message !== 'string') return null;

    const path = issue.path;
    if (!Array.isArray(path) || path.length === 0) return null;
    if (!path.every((segment) => typeof segment === 'string' || typeof segment === 'number')) return null;

    const redactedPath = path.map((segment) =>
      typeof segment === 'number' || PATH_SEGMENT_RE.test(segment) ? segment : REDACTED_PATH_SEGMENT,
    );
    paths.push(redactedPath.join('.'));
  }
  return paths;
}

// Same literal markers classify/channel.js already trusts (ADR 007) as the
// SDK's own convention for distinguishing input- vs output-validation
// -32602 failures from every other condition sharing that code. Reused
// here as the precondition for attempting rendered-format extraction at
// all: extractRenderedPaths() only ever runs on text that already
// contains one of these, never on arbitrary business-logic text (e.g. a
// tool's own "please look at docs" message), since a bare "<x> at <y>"
// line is not self-validating the way a Zod-issue-shaped JSON array is.
const INPUT_VALIDATION_MARKER = 'Input validation error:';
const OUTPUT_VALIDATION_MARKER = 'Output validation error:';

// A dotPath segment as SDK 1.30.0's getDotPath() renders it: an
// identifier-like key, or `[digits]` for an array index, chained with `.`
// or `[...]`. Deliberately excludes whitespace and punctuation other than
// `.`/`_`/`$`/brackets, so a suffix like "least 5" (the tail of a
// root-level message that happens to contain the substring " at ", e.g.
// "Number must be at least 5") fails this pattern and is correctly not
// mistaken for a path -- see this function's docblock for the residual
// risk that remains even with this restriction.
const RENDERED_DOT_PATH_RE = /^[\w$]+(?:\.[\w$]+|\[\d+\])*$/;

/**
 * Normalizes a rendered dotPath's `[digit]` array-index segments to `.digit`,
 * matching parseZodIssuesArray()'s `path.join('.')` output. Chosen over
 * leaving brackets as-is so both extraction paths (JSON and rendered) agree
 * on canonical form for the same logical field -- callers/operators
 * comparing `mcp.failure.validation_paths` values across SDK versions (or
 * across the low-level Server's JSON-rendered path and McpServer's
 * SDK-rendered path in the same fleet) should never see "items[3]" from one
 * and "items.3" from the other for what is, semantically, the same path.
 *
 * @param {string} dotPath
 * @returns {string}
 */
function normalizeRenderedDotPath(dotPath) {
  return dotPath.replace(/\[(\d+)\]/g, '.$1');
}

/**
 * Parses SDK 1.30.0+'s rendered `"<message> at <dotPath>"` format: one
 * issue per line, joined by `\n`, root-level issues (empty `path`)
 * rendering as just `<message>` with no " at " suffix at all.
 *
 * Only attempted when `text` contains the SDK's own input/output
 * validation marker (see INPUT_VALIDATION_MARKER above) -- this format,
 * unlike the JSON array, is not self-validating on its own (any English
 * sentence ending in "at <word>" would otherwise look plausible), so this
 * gate is the load-bearing precondition that keeps this from firing on
 * unrelated business-logic failure text.
 *
 * Per-line, best-effort: a line with no confidently-path-shaped " at "
 * suffix (root-level issues; a message whose own text happens to contain
 * " at " followed by more prose) is silently skipped, not treated as
 * disqualifying the whole message -- unlike parseZodIssuesArray()'s
 * all-or-nothing JSON handling, a real Zod validation failure routinely
 * mixes root-level and field-level issues in the same result, so a
 * per-line miss here is expected, not a sign of corruption.
 *
 * @param {string} text
 * @returns {readonly string[]}
 */
function extractRenderedPaths(text) {
  if (!text.includes(INPUT_VALIDATION_MARKER) && !text.includes(OUTPUT_VALIDATION_MARKER)) {
    return [];
  }

  const paths = [];
  for (const line of text.split('\n')) {
    const atIndex = line.lastIndexOf(' at ');
    if (atIndex === -1) continue;

    const suffix = line.slice(atIndex + 4);
    if (!RENDERED_DOT_PATH_RE.test(suffix)) continue;

    paths.push(normalizeRenderedDotPath(suffix));
  }
  return paths;
}

// The two full sentence shapes @modelcontextprotocol/server (v2) prefixes
// its rendered issues list with -- confirmed live against the installed
// package (mcp-DXXb3Vv3.mjs): "Input validation error: Invalid arguments
// for tool <name>: <issues>" and "Output validation error: Invalid
// structured content for tool <name>: <issues>". (A third "Output
// validation error: Tool <name> has an output schema but no structured
// content was provided" shape carries no per-field issues at all --
// this regex simply won't match it, correctly yielding no paths, same as
// any other message it doesn't recognize.)
//
// Anchored with `^` deliberately: this is what disambiguates v2's BARE
// text from v1's WRAPPED text without needing to know which SDK produced
// it. v1's own message uses the identical "Input validation error:
// Invalid arguments for tool <name>: " wording (confirmed against the
// installed @modelcontextprotocol/sdk source -- both SDKs share this
// phrasing), but v1's disguised/thrown text is always prefixed with
// McpError's own "MCP error {code}: " wrapper first (see
// classify/channel.js's MCP_ERROR_WRAPPER_RE), so it never starts with
// "Input validation error: " at position 0 -- only genuine v2 text (or a
// v1 message somehow already stripped of its wrapper before reaching
// here, which extractRenderedPaths() above would have to have failed to
// parse first; see extractValidationPaths()'s try-order) does.
const V2_ISSUES_PREFIX_RE =
  /^(?:Input validation error: Invalid arguments for tool [^:]+|Output validation error: Invalid structured content for tool [^:]+): /;

// A path as v2's formatIssue() renders it: `issue.path.map(...).join('.')`
// -- always dot-joined, confirmed live, unlike format 2's bracket-index
// convention (`items[3]`). The `\[\d+\]` alternative is kept anyway, for
// the same reason RENDERED_DOT_PATH_RE keeps its own: defensive tolerance
// for a future rendering change, not because v2 emits it today -- paired
// with normalizeRenderedDotPath() below on the (currently unreachable)
// chance it ever does. Only matches when immediately preceded by the
// start of the (already prefix-stripped) issues text or by ", " -- the
// separator formatIssue()'s caller joins issues with -- so a path-shaped
// token appearing INSIDE a message's own prose (never preceded by ", ")
// is not mistaken for the start of a new issue.
const V2_ISSUE_START_RE = /(?:^|, )([\w$]+(?:\.[\w$]+|\[\d+\])*): /g;

/**
 * Parses @modelcontextprotocol/server (v2)'s rendered `"<path>:
 * <message>"` format: one issue per pair, comma-joined onto a single
 * line, generated by v2's own `formatIssue()`/`validateStandardSchema()`
 * over the generic Standard Schema `~standard.validate()` interface — see
 * this module's docblock for why that makes it schema-library-agnostic
 * (Zod, Valibot, ArkType, ...), unlike formats 1/2's Zod-specific
 * rendering.
 *
 * Gated on `V2_ISSUES_PREFIX_RE` first — both a confidence check (this
 * really is v2's own rendered issues text, not arbitrary business-logic
 * prose that happens to contain a colon) and, critically, what makes
 * `V2_ISSUE_START_RE`'s `^` alternative line up with the FIRST real issue:
 * without stripping the "Invalid arguments/structured content for tool
 * <name>: " prefix first, `^` would anchor at the tool-name prefix instead,
 * and the first issue (not preceded by ", ", since it's not preceded by
 * any earlier issue) would be silently missed.
 *
 * Best-effort like extractRenderedPaths(): a root-level issue (`formatIssue()`
 * renders it as just the bare message, no "path: " prefix at all)
 * contributes no path, not a guessed one — same "omit, don't guess"
 * behavior extractRenderedPaths() already documents for its own
 * root-level case, and for the same reason: a root-level issue is real,
 * confirmed information (there is no field to blame), not a parsing
 * failure to work around.
 *
 * @param {string} text
 * @returns {readonly string[]}
 */
function extractV2Paths(text) {
  const prefixMatch = V2_ISSUES_PREFIX_RE.exec(text);
  if (!prefixMatch) return [];

  const issuesText = text.slice(prefixMatch[0].length);
  const paths = [];
  for (const issueMatch of issuesText.matchAll(V2_ISSUE_START_RE)) {
    paths.push(normalizeRenderedDotPath(issueMatch[1]));
  }
  return paths;
}

/**
 * Extracts which schema field(s) a validation failure named, from
 * whichever shape the caller has in hand: a CallToolResult with
 * `isError: true` (read from `content[0].text` — this is also where
 * McpServer's disguised protocol failures live, see this module's
 * docblock), or an error-like object with a string `.message`.
 *
 * Tries the JSON issues array first (SDK <=1.29.0, and any low-level
 * `Server` author who throws a raw, unrendered `ZodError`); then the SDK
 * 1.30.0+ rendered "<message> at <path>" format; then
 * @modelcontextprotocol/server (v2)'s rendered "<path>: <message>" format
 * (ADR 015 Phase 3) — each only when no confident match was found by the
 * one(s) before it. See this module's docblock for why all three exist,
 * why trying them in this order is safe (formats 2 and 3 are mutually
 * exclusive by construction), and the fragility of depending on any of
 * them.
 *
 * Never throws, never guesses: returns `[]` — not a partial or
 * best-guess result — whenever no format confidently matches.
 *
 * @param {unknown} failure
 * @returns {readonly string[]} One dot-joined path per failing issue
 *   (e.g. `["email"]` or `["user.profile.age", "status"]`), or `[]`.
 */
export function extractValidationPaths(failure) {
  try {
    if (!isPlainObject(failure)) return [];

    const text = failure.isError === true ? firstContentText(failure) : failure.message;
    if (typeof text !== 'string') return [];

    const jsonSubstring = extractJsonArraySubstring(text);
    if (jsonSubstring !== null) {
      const jsonPaths = parseZodIssuesArray(jsonSubstring);
      if (jsonPaths !== null) return jsonPaths;
    }

    const renderedPaths = extractRenderedPaths(text);
    if (renderedPaths.length > 0) return renderedPaths;

    return extractV2Paths(text);
  } catch {
    return [];
  }
}
