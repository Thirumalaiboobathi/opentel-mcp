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
 * TWO rendering formats are parsed, because the SDK has changed this
 * rendering once already (confirmed empirically going from
 * @modelcontextprotocol/sdk@1.29.0 to 1.30.0 — see ADR 009's addendum):
 *
 *   1. JSON issues array — `JSON.stringify(error.issues, ..., 2)`, the
 *      whole-array-with-`path`-fields shape `getParseErrorMessage()` used
 *      through SDK 1.29.0 (and still what you get if a low-level `Server`
 *      author throws a raw, unrendered `ZodError` directly — nothing
 *      guarantees they've upgraded, or ever rendered it through the SDK's
 *      helper at all).
 *   2. Rendered "`<message> at <dotPath>`" lines, one per issue, joined by
 *      `\n` — what `getParseErrorMessage()` produces as of SDK 1.30.0.
 *      Root-level issues (empty `path`) render as just `<message>`, no
 *      " at " suffix at all.
 *
 * JSON is tried first (it's self-validating — a successful, Zod-issue-
 * shaped parse is strong evidence either way — see `parseZodIssuesArray`)
 * and unconditionally preferred when it confidently matches. The rendered
 * form is tried only as a fallback, and only within a message that already
 * confirms it's SDK-validation-shaped text (see `extractRenderedPaths`) —
 * unlike the JSON path, a bare "<x> at <y>" line is not self-validating,
 * so this format leans on the same INPUT/OUTPUT_VALIDATION marker
 * `classify/channel.js` already trusts (ADR 007) rather than pattern-
 * matching arbitrary text.
 *
 * This is best-effort, string-parsing extraction. Pure, synchronous, no
 * OTel, never throws: any input that doesn't confidently look like either
 * known rendering resolves to an empty array rather than a wrong or
 * partial guess.
 *
 * Standalone, like channel.js: not wired into computeFingerprint() (the
 * path text is already implicit in the hashed normalized message — see
 * ADR 009's "Where would extraction belong" — so hashing it again would
 * be redundant, not more correct) and not re-exported from src/index.js.
 *
 * FRAGILITY, stated plainly: this is now coupled to TWO independent SDK
 * rendering formats instead of one. A third format in a future SDK
 * version breaks this again, exactly the way 1.30.0 broke the
 * JSON-only version — and the failure mode is silent: `[]`, not an
 * exception, not a warning. `test/fingerprint/classify.validation-paths.test.js`'s
 * SDK-version pin exists specifically so that a future SDK bump fails a
 * test loudly instead of only degrading data quality unnoticed.
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

    paths.push(path.join('.'));
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

/**
 * Extracts which schema field(s) a validation failure named, from
 * whichever shape the caller has in hand: a CallToolResult with
 * `isError: true` (read from `content[0].text` — this is also where
 * McpServer's disguised protocol failures live, see this module's
 * docblock), or an error-like object with a string `.message`.
 *
 * Tries the JSON issues array first (SDK <=1.29.0, and any low-level
 * `Server` author who throws a raw, unrendered `ZodError`); falls back to
 * the SDK 1.30.0+ rendered "<message> at <path>" format only when no
 * confident JSON match was found. See this module's docblock for why both
 * exist and the fragility of depending on either.
 *
 * Never throws, never guesses: returns `[]` — not a partial or
 * best-guess result — whenever neither format confidently matches.
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

    return extractRenderedPaths(text);
  } catch {
    return [];
  }
}
