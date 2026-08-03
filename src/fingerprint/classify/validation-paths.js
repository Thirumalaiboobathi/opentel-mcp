/**
 * @module fingerprint/classify/validation-paths
 *
 * Extracts which schema field(s) a Zod validation failure named, per ADR
 * 009 (docs/adr/009-field-level-convergence.md). The MCP TypeScript SDK's
 * `getParseErrorMessage()` (server/zod-compat.js) falls back to a
 * ZodError's own `.message` getter, which — confirmed against the
 * installed `zod` package — is the full JSON-serialized issues array
 * (`JSON.stringify(this.issues, ..., 2)`), embedding each failing issue's
 * `path`. That JSON survives verbatim into the thrown McpError's message,
 * and — same mechanism `classifyFailureChannel()` relies on
 * (fingerprint/classify/channel.js) — verbatim again into McpServer's
 * `isError: true` disguise of it.
 *
 * This is best-effort, string-parsing extraction, not access to a live
 * ZodError: by the time a failure reaches this instrumentation, the
 * structured object is gone (see ADR 009's Q2) — only ever the rendered
 * text remains. Pure, synchronous, no OTel, never throws: any input that
 * doesn't confidently look like a Zod issues array resolves to an empty
 * array rather than a wrong or partial guess.
 *
 * Standalone, like channel.js: not wired into computeFingerprint() (the
 * path text is already implicit in the hashed normalized message — see
 * ADR 009's "Where would extraction belong" — so hashing it again would
 * be redundant, not more correct) and not re-exported from src/index.js.
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

/**
 * Extracts which schema field(s) a validation failure named, from
 * whichever shape the caller has in hand: a CallToolResult with
 * `isError: true` (read from `content[0].text` — this is also where
 * McpServer's disguised protocol failures live, see this module's
 * docblock), or an error-like object with a string `.message`.
 *
 * Never throws, never guesses: returns `[]` — not a partial or
 * best-guess result — whenever the message is missing, doesn't contain a
 * balanced JSON array, or that array doesn't confidently look like a Zod
 * issues array.
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
    if (jsonSubstring === null) return [];

    return parseZodIssuesArray(jsonSubstring) ?? [];
  } catch {
    return [];
  }
}
