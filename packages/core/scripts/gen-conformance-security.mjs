/**
 * Fixture builders for the v0.18 security signals (ADR 034 amendment, contract version 2): tool definition hash
 * vectors, secret type detection and result scanning, auth classification, sensitive tool matching and the
 * integrity tracker. Imported by gen-conformance.mjs. Only INPUTS live here; every `expect` is whatever the
 * unmodified core produces.
 *
 * Key-shaped strings are the same documentation-style placeholders gen-conformance.mjs already uses for the
 * scrubber fixtures; none is a working credential.
 */
import { computeToolDefinitionHash } from '../src/tool-integrity/hash.js';
import { ToolIntegrityTracker } from '../src/tool-integrity/tracker.js';
import { detectSecretTypes } from '../src/fingerprint/normalize/secrets.js';
import { scanResultForSecrets } from '../src/secret-leak.js';
import { compileSensitiveTools } from '../src/sensitive-tools.js';
import { computeFingerprint } from '../src/fingerprint/compose.js';

const CWD = '/fixed/cwd';
const BOTH = ['js', 'py'];

function mk() {
  const cases = [];
  const ids = new Set();
  return {
    cases,
    add(id, input, expect, extra = {}) {
      if (ids.has(id)) throw new Error('duplicate fixture id ' + id);
      ids.add(id);
      cases.push({ id, input, ...extra, expect, languages: BOTH });
    },
  };
}

// ---------------------------------------------------------------------------
// tool-hash.json: `definitionJson` is JSON TEXT, parsed by each language's own parser, so number spellings
// (1 vs 1.0 vs 1e0), duplicate-looking escapes and `__proto__` reach the hasher exactly as written.
// ---------------------------------------------------------------------------

export function buildToolHashCases() {
  const { cases, add } = mk();
  const hashOf = (text) => {
    const hash = computeToolDefinitionHash(JSON.parse(text));
    return { hash };
  };
  const t = (id, text) => add(id, { definitionJson: text }, hashOf(text));

  const base = '{"name":"get_quote","description":"Latest quote","inputSchema":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}';
  t('base', base);
  t('key-order-top', '{"inputSchema":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]},"description":"Latest quote","name":"get_quote"}');
  t('key-order-nested', '{"name":"get_quote","description":"Latest quote","inputSchema":{"required":["symbol"],"properties":{"symbol":{"type":"string"}},"type":"object"}}');
  t('whitespace-in-source', '{\n  "name" : "get_quote",\n  "description": "Latest quote",\n  "inputSchema": {"type":"object", "properties":{"symbol":{"type":"string"}}, "required":["symbol"]}\n}');
  t('description-trailing-space', '{"name":"get_quote","description":"Latest quote ","inputSchema":{"type":"object"}}');
  t('array-order-matters-a', '{"name":"t","inputSchema":{"enum":["a","b","c"]}}');
  t('array-order-matters-b', '{"name":"t","inputSchema":{"enum":["c","b","a"]}}');
  t('array-of-objects', '{"name":"t","inputSchema":{"anyOf":[{"type":"string","format":"uri"},{"format":"date","type":"string"}]}}');
  t('nested-deep', '{"name":"t","inputSchema":{"a":{"b":{"c":{"d":{"e":{"f":[1,[2,[3,[4]]]]}}}}}}}');
  t('empty-objects-and-arrays', '{"name":"t","inputSchema":{},"annotations":{},"outputSchema":{"type":"object","properties":{}},"description":""}');
  t('empty-array-values', '{"name":"t","inputSchema":{"required":[],"enum":[]}}');

  // optional fields present vs absent (and null is PRESENT)
  t('only-name', '{"name":"only"}');
  t('title-present', '{"name":"t","title":"A Title","description":"d"}');
  t('title-absent', '{"name":"t","description":"d"}');
  t('output-schema-present', '{"name":"t","outputSchema":{"type":"object","properties":{"x":{"type":"number"}}}}');
  t('annotations-present', '{"name":"t","annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false,"title":"x"}}');
  t('annotations-key-order', '{"name":"t","annotations":{"title":"x","openWorldHint":false,"idempotentHint":true,"destructiveHint":false,"readOnlyHint":true}}');
  t('description-null-is-present', '{"name":"t","description":null}');
  t('description-empty-string', '{"name":"t","description":""}');
  t('no-name', '{"description":"nameless","inputSchema":{"type":"object"}}');
  t('uncovered-fields-ignored-meta', '{"name":"t","description":"d","_meta":{"x":1}}');
  t('uncovered-fields-ignored-icons', '{"name":"t","description":"d","icons":[{"src":"https://x/y.png"}],"execution":{"taskSupport":"optional"},"vendor":"v"}');
  t('uncovered-fields-only', '{"_meta":{"a":1},"icons":[]}');

  // unicode
  t('unicode-bmp', '{"name":"t","description":"café ☃ naïve"}');
  t('unicode-escaped-same-as-literal', '{"name":"t","description":"caf\\u00e9 \\u2603 na\\u00efve"}');
  t('unicode-nfd', '{"name":"t","description":"cafe\\u0301"}');
  t('unicode-nfc', '{"name":"t","description":"caf\\u00e9"}');
  t('unicode-astral-description', '{"name":"t","description":"rocket \\ud83d\\ude80 and \\ud83d\\udd11 key"}');
  t('unicode-astral-literal', '{"name":"t","description":"rocket 🚀 and 🔑 key"}');
  t('unicode-homoglyph', '{"name":"t","description":"p\\u0430ypal"}');
  t('unicode-zero-width', '{"name":"t","description":"a\\u200bb"}');
  t('unicode-bom-and-nbsp', '{"name":"t","description":"\\ufeff\\u00a0x"}');
  t('unicode-line-separators', '{"name":"t","description":"a\\u2028b\\u2029c"}');
  t('unicode-lone-high-surrogate', '{"name":"t","description":"x\\ud800y"}');
  t('unicode-lone-low-surrogate', '{"name":"t","description":"x\\udc00y"}');
  t('unicode-reversed-surrogates', '{"name":"t","description":"\\udc00\\ud800"}');
  t('unicode-astral-name', '{"name":"t\\ud83d\\ude80"}');

  // key sorting: UTF-16 code units, not code points (astral keys sort BEFORE U+E000..U+FFFF)
  t('sort-astral-vs-bmp-high', '{"name":"t","inputSchema":{"properties":{"\\uffff":1,"\\ud83d\\ude00":2,"\\ue000":3,"a":4}}}');
  t('sort-astral-vs-bmp-high-reversed-source', '{"name":"t","inputSchema":{"properties":{"a":4,"\\ue000":3,"\\ud83d\\ude00":2,"\\uffff":1}}}');
  t('sort-astral-keys-among-themselves', '{"name":"t","inputSchema":{"properties":{"\\ud83d\\ude00":1,"\\ud83c\\udf89":2,"\\ud83d\\udd11":3,"\\ud800\\udc00":4}}}');
  t('sort-case-and-digits', '{"name":"t","inputSchema":{"properties":{"b":1,"B":2,"a":3,"A":4,"10":5,"9":6,"_":7,"-":8}}}');
  t('sort-prefix-keys', '{"name":"t","inputSchema":{"properties":{"ab":1,"a":2,"abc":3,"":4}}}');
  t('sort-numeric-looking-keys', '{"name":"t","inputSchema":{"properties":{"2":1,"1":2,"11":3,"01":4}}}');
  t('sort-lone-surrogate-key', '{"name":"t","inputSchema":{"properties":{"\\ud800":1,"a":2,"\\uffff":3}}}');

  // numbers
  t('number-int-one', '{"name":"t","inputSchema":{"minimum":1}}');
  t('number-float-one', '{"name":"t","inputSchema":{"minimum":1.0}}');
  t('number-exp-one', '{"name":"t","inputSchema":{"minimum":1e0}}');
  t('number-zero', '{"name":"t","inputSchema":{"minimum":0}}');
  t('number-negative-zero-int', '{"name":"t","inputSchema":{"minimum":-0}}');
  t('number-negative-zero-float', '{"name":"t","inputSchema":{"minimum":-0.0}}');
  t('number-fraction', '{"name":"t","inputSchema":{"minimum":0.1,"maximum":0.30000000000000004}}');
  t('number-half', '{"name":"t","inputSchema":{"default":1.5,"x":-2.25}}');
  t('number-large-int-safe', '{"name":"t","inputSchema":{"maximum":9007199254740991}}');
  t('number-large-int-unsafe', '{"name":"t","inputSchema":{"maximum":9007199254740993}}');
  t('number-large-int-20-digits', '{"name":"t","inputSchema":{"maximum":12345678901234567890}}');
  t('number-large-int-30-digits', '{"name":"t","inputSchema":{"maximum":123456789012345678901234567890}}');
  t('number-1e21', '{"name":"t","inputSchema":{"maximum":1e21}}');
  t('number-1e20', '{"name":"t","inputSchema":{"maximum":1e20}}');
  t('number-1e22', '{"name":"t","inputSchema":{"maximum":1E22}}');
  t('number-1e-6', '{"name":"t","inputSchema":{"minimum":1e-6}}');
  t('number-1e-7', '{"name":"t","inputSchema":{"minimum":1e-7}}');
  t('number-1e-10', '{"name":"t","inputSchema":{"minimum":1e-10}}');
  t('number-1_5e-7', '{"name":"t","inputSchema":{"minimum":1.5e-7}}');
  t('number-1_5e300', '{"name":"t","inputSchema":{"maximum":1.5e300}}');
  t('number-max-double', '{"name":"t","inputSchema":{"maximum":1.7976931348623157e308}}');
  t('number-min-subnormal', '{"name":"t","inputSchema":{"minimum":5e-324}}');
  t('number-overflow-to-infinity', '{"name":"t","inputSchema":{"maximum":1e999}}');
  t('number-underflow-to-zero', '{"name":"t","inputSchema":{"minimum":1e-999}}');
  t('number-negative-large', '{"name":"t","inputSchema":{"minimum":-1e21,"maximum":-123456789012345678}}');
  t('number-exponent-forms', '{"name":"t","inputSchema":{"a":1E3,"b":1e+3,"c":10e2,"d":0.001e6,"e":100e-2}}');
  t('number-in-array', '{"name":"t","inputSchema":{"examples":[1,1.0,2.50,-0,1e2]}}');
  t('number-trailing-zeros', '{"name":"t","inputSchema":{"default":2.50,"x":100.0,"y":0.0}}');

  // booleans / null
  t('bool-null', '{"name":"t","inputSchema":{"additionalProperties":false,"nullable":true,"default":null,"readOnly":false}}');
  t('null-in-array', '{"name":"t","inputSchema":{"enum":[null,true,false,0,""]}}');
  t('annotations-null', '{"name":"t","annotations":null}');

  // strings / escaping
  t('escape-quotes-backslash', '{"name":"t","description":"say \\"hi\\" \\\\ back"}');
  t('escape-control-chars', '{"name":"t","description":"a\\nb\\tc\\rd\\be\\ff\\u0000g\\u001fh"}');
  t('escape-slash-and-del', '{"name":"t","description":"a/b\\/c\\u007fd"}');
  t('escape-key-needs-escaping', '{"name":"t","inputSchema":{"properties":{"a\\"b":1,"c\\\\d":2,"e\\nf":3}}}');
  t('long-description', JSON.stringify({ name: 't', description: 'x'.repeat(20000) }));

  // dangerous keys
  t('proto-key-top', '{"name":"t","__proto__":{"polluted":true}}');
  t('proto-key-nested', '{"name":"t","inputSchema":{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}}}}');
  t('proto-key-scalar', '{"name":"t","inputSchema":{"__proto__":1}}');
  t('proto-key-sorting', '{"name":"t","inputSchema":{"properties":{"b":1,"__proto__":2,"a":3,"constructor":4,"prototype":5}}}');
  t('key-named-name-nested', '{"name":"t","inputSchema":{"properties":{"name":{"type":"string"},"description":{"type":"string"}}}}');

  // not hashable
  t('not-an-object-null', 'null');
  t('not-an-object-array', '[{"name":"t"}]');
  t('not-an-object-string', '"get_quote"');
  t('not-an-object-number', '42');
  t('empty-object', '{}');
  t('depth-256-ok', `{"name":"t","inputSchema":${'['.repeat(250)}1${']'.repeat(250)}}`);
  t('depth-300-too-deep', `{"name":"t","inputSchema":${'['.repeat(300)}1${']'.repeat(300)}}`);

  // a realistic definition
  t(
    'realistic',
    JSON.stringify({
      name: 'search_documents',
      title: 'Search documents',
      description: 'Search the knowledge base. Returns the top matches. Use quotes for exact phrases.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 512, description: 'Search text' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          filters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
        },
        required: ['query'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),
  );
  return cases;
}

// ---------------------------------------------------------------------------
// secret-types.json (detectSecretTypes on whole text) and secret-scan.json (scanResultForSecrets)
// ---------------------------------------------------------------------------

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const OPENAI = 'sk-abcdefghijklmnopqrstuvwxyz1234';
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop_-qrstuv';

export function buildSecretTypeCases() {
  const { cases, add } = mk();
  const t = (id, text) => {
    const found = detectSecretTypes(text);
    add(id, { text }, { types: [...found.types].sort(), count: found.count });
  };
  t('none-empty', '');
  t('none-plain', 'The quick brown fox jumps over the lazy dog.');
  t('none-bearer-short', 'Bearer token missing');
  t('none-password-word', 'password reset instructions were sent');
  t('none-url-no-creds', 'see https://example.com/path?x=1 for details');
  t('none-url-user-only', 'ftp://user@example.com/file');
  t('none-short-sk', 'sk-short');
  t('none-aws-lowercase', 'akiaiosfodnn7example');
  t('none-aws-too-short', 'AKIAIOSFODNN7EXAMP');
  t('none-jwt-two-segments', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');
  t('url-credentials', 'connect to postgres://admin:hunter2pass@db.internal:5432/app');
  t('url-credentials-https', 'GET https://user:p%40ss@example.com/x failed');
  t('url-credentials-ftp', 'ftp://anonymous:guest@ftp.example.com');
  t('jwt', `token ${JWT} was rejected`);
  t('jwt-in-json', `{"id_token":"${JWT}"}`);
  t('http-auth-bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
  t('http-auth-basic', 'Authorization: Basic dXNlcjpwYXNzd29yZHBhc3N3b3Jk');
  t('http-auth-lowercase-bearer', 'authorization: bearer abcdefghijklmnopqrstuvwxyz012345');
  t('aws-key-id', `key ${AWS} rejected`);
  t('aws-key-id-asia', 'key ASIAIOSFODNN7EXAMPLE rejected');
  t('provider-key-openai', `invalid key ${OPENAI} provided`);
  t('provider-key-anthropic', 'invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz provided');
  t('provider-key-github', `invalid key ${GH} provided`);
  t('provider-key-github-pat', 'github_pat_11ABCDEFG0abcdefghijklmnopqr');
  t('provider-key-slack', 'xoxb-1234567890-abcdefghijkl');
  t('provider-key-google', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345');
  t('provider-key-stripe', 'sk_live_abcdefghijklmnop1234');
  t('secret-assignment-equals', 'password=hunter2');
  t('secret-assignment-api-key', 'api_key=abcd1234&other=1');
  t('secret-assignment-token-quoted', 'token="abcd1234efgh"');
  t('secret-assignment-json', '{"client_secret": "s3cr3t-value"}');
  t('secret-assignment-colon', 'password: hunter22');
  t('secret-assignment-colon-no-digit', 'password: hunterxx');
  t('secret-assignment-mixed-case', 'API_KEY=Zm9vYmFy');
  t('secret-assignment-aws-secret', 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  t('multi-types', `a=1 token=aaa password=bbb ${OPENAI}`);
  t('multi-same-type', `${AWS} and ${AWS} and ${AWS}`);
  t('overlap-counts-twice', `password=${OPENAI}`);
  t('overlap-url-and-assignment', 'postgres://admin:password=abc@db/x');
  t('adjacent-no-space', `${AWS}${AWS}`);
  t('unicode-around-secret', `🔑 ${AWS} 🔑`);
  t('unicode-astral-before-assignment', `😀😀😀 password=hunter2`);
  t('newlines', `line1\n${OPENAI}\nline3\r\n${AWS}`);
  t('boundary-word-char-before', `x${AWS}`);
  t('boundary-underscore-before', `_${AWS}`);
  t('boundary-nbsp-before', `\u00a0${AWS}`);
  t('case-insensitive-secret-name', 'PASSWORD=Hunter2 Token=abc');
  t('unicode-lookalike-keyword', 'pa\u0455sword=hunter2');
  t('count-cap-1000', `${AWS} `.repeat(1100));
  t('count-just-under-cap', `${AWS} `.repeat(999));
  t('count-exactly-cap', `${AWS} `.repeat(1000));
  t('long-benign', 'lorem ipsum dolor sit amet '.repeat(300));
  return cases;
}

export function buildSecretScanCases() {
  const { cases, add } = mk();
  const textItem = (text) => ({ type: 'text', text });
  const t = (id, result, maxScanBytes) => {
    const scan = scanResultForSecrets(result, maxScanBytes);
    add(id, { result, maxScanBytes }, scan === null ? { scan: null } : { scan: { types: [...scan.types].sort(), count: scan.count, truncated: scan.truncated } });
  };
  t('no-content', {}, 65536);
  t('content-not-array', { content: 'AKIAIOSFODNN7EXAMPLE' }, 65536);
  t('empty-content', { content: [] }, 65536);
  t('clean', { content: [textItem('all good')] }, 65536);
  t('single-secret', { content: [textItem(`key ${AWS}`)] }, 65536);
  t('iserror-result', { isError: true, content: [textItem(`upstream said Bearer abcdefghijklmnopqrstuvwxyz012345`)] }, 65536);
  t('two-items-two-types', { content: [textItem(AWS), textItem(`password=hunter2`)] }, 65536);
  t('secret-split-across-items-missed', { content: [textItem('AKIAIOSFODNN7'), textItem('EXAMPLE')] }, 65536);
  t('non-text-items-ignored', { content: [{ type: 'image', data: AWS, mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'x://y', text: AWS } }] }, 65536);
  t('text-item-without-text', { content: [{ type: 'text' }, { type: 'text', text: 42 }, null, 'str', { type: 'text', text: '' }] }, 65536);
  t('structured-content-not-scanned', { content: [textItem('ok')], structuredContent: { token: OPENAI }, _meta: { k: AWS } }, 65536);
  t('mixed-bad-and-good-items', { content: [null, 5, { type: 'text', text: AWS }, { type: 'audio' }] }, 65536);
  // budget: UTF-16 code units
  t('cap-exact-fit', { content: [textItem(AWS)] }, AWS.length);
  t('cap-one-short-cuts-secret', { content: [textItem(AWS)] }, AWS.length - 1);
  t('cap-1', { content: [textItem(AWS)] }, 1);
  t('cap-first-item-uses-all', { content: [textItem('a'.repeat(100)), textItem(AWS)] }, 100);
  t('cap-second-item-sliced', { content: [textItem('a'.repeat(100)), textItem(`${AWS}`)] }, 110);
  t('cap-second-item-reaches-secret', { content: [textItem('a'.repeat(10)), textItem(AWS)] }, 30);
  // astral characters count as TWO code units
  const rockets = '\u{1F680}'.repeat(10); // 20 code units
  t('astral-cap-before-secret', { content: [textItem(`${rockets}${AWS}`)] }, 20);
  t('astral-cap-mid-secret', { content: [textItem(`${rockets}${AWS}`)] }, 30);
  t('astral-cap-full-secret', { content: [textItem(`${rockets}${AWS}`)] }, 40);
  t('astral-cap-cuts-pair', { content: [textItem(`${rockets}${AWS}`)] }, 19);
  t('astral-cap-secret-fits-only-in-code-units', { content: [textItem(`\u{1F511}${AWS}`)] }, 2 + AWS.length);
  t('astral-cap-secret-misses-by-one-unit', { content: [textItem(`\u{1F511}${AWS}`)] }, 2 + AWS.length - 1);
  t('bmp-wide-chars-count-one-unit', { content: [textItem(`\u4e2d\u6587\u6587\u5b57 ${AWS}`)] }, 5 + AWS.length);
  t('lone-surrogate-text', { content: [textItem(`\ud800 ${AWS} \udc00`)] }, 65536);
  // chunking: 4096-unit windows with 256 overlap
  const pad = (n) => 'x '.repeat(Math.ceil(n / 2)).slice(0, n);
  t('chunk-secret-at-4090', { content: [textItem(`${pad(4090)}${AWS} tail`)] }, 65536);
  t('chunk-secret-straddles-4096-short-enough', { content: [textItem(`${pad(4080)} ${AWS} tail`)] }, 65536);
  t('chunk-secret-just-inside-overlap', { content: [textItem(`${pad(4096 + 200)} ${AWS}`)] }, 65536);
  t('chunk-secret-in-second-window', { content: [textItem(`${pad(5000)} ${AWS}`)] }, 65536);
  t('chunk-secret-in-third-window', { content: [textItem(`${pad(9000)} ${AWS}`)] }, 65536);
  t('chunk-same-secret-twice-in-overlap', { content: [textItem(`${pad(4000)} ${AWS} ${pad(60)} ${AWS} ${pad(300)}`)] }, 65536);
  t('chunk-long-token-spanning-windows', { content: [textItem(`${pad(4000)} sk-${'a'.repeat(400)} tail`)] }, 65536);
  t('chunk-astral-straddle', { content: [textItem(`${'\u{1F680}'.repeat(2040)}${AWS}`)] }, 65536);
  t('chunk-many-secrets', { content: [textItem(Array.from({ length: 60 }, (_, i) => `${pad(200)} ${AWS}`).join('\n'))] }, 65536);
  t('chunk-match-cap-reached', { content: [textItem(`${AWS} `.repeat(1500))] }, 65536);
  t('cap-1000-across-items', { content: Array.from({ length: 30 }, () => textItem(`${AWS} `.repeat(50))) }, 65536);
  t('not-truncated-at-exactly-cap', { content: [textItem('a'.repeat(8192))] }, 8192);
  t('truncated-one-over-cap', { content: [textItem('a'.repeat(65537))] }, 65536);
  t('truncated-by-later-item', { content: [textItem('a'.repeat(10)), textItem('b')] }, 10);
  t('not-truncated-by-later-empty-item', { content: [textItem('a'.repeat(10)), textItem('')] }, 10);
  t('not-truncated-by-later-nontext-item', { content: [textItem('a'.repeat(10)), { type: 'image' }] }, 10);
  t('secret-after-cap-in-big-item', { content: [textItem(`${'a'.repeat(9000)} ${AWS}`)] }, 8192);
  t('secret-before-cap-in-big-item', { content: [textItem(`${AWS} ${'a'.repeat(9000)}`)] }, 8192);
  t('small-custom-cap-detects', { content: [textItem(`${AWS} ${'a'.repeat(5000)}`)] }, 100);
  t('items-limit-not-reached', { content: Array.from({ length: 200 }, (_, i) => textItem(i === 199 ? AWS : 'ok')) }, 65536);
  t('jwt-and-url', { content: [textItem(`${JWT}\npostgres://u:pw1234@h/db`)] }, 65536);
  return cases;
}

// ---------------------------------------------------------------------------
// auth.json: whether a failed call increments mcp.tool.auth_failures (ADR 031): category === 'auth'
// ---------------------------------------------------------------------------

export function buildAuthCases() {
  const { cases, add } = mk();
  const result = (id, text, options = {}) => {
    const r = { isError: true, content: [{ type: 'text', text }] };
    const category = computeFingerprint(r, { toolName: 'tool', origin: 'tool_error', cwd: CWD }).category;
    add(id, { kind: 'result', result: r, options }, { category, increments: options.fingerprinting === false ? false : category === 'auth' });
  };
  const thrown = (id, error, options = {}) => {
    const category = computeFingerprint(error, { toolName: 'tool', origin: 'thrown', cwd: CWD }).category;
    add(id, { kind: 'thrown', error, options }, { category, increments: options.fingerprinting === false ? false : category === 'auth' });
  };
  // silent (isError) failures that should count
  for (const [id, text] of [
    ['access-denied', 'Access denied for this resource'],
    ['unauthorized', '401 Unauthorized'],
    ['unauthorized-bare', 'unauthorized'],
    ['forbidden', 'Forbidden: you cannot do that'],
    ['not-authorized', 'You are not authorized to perform this action'],
    ['authentication-failed', 'Authentication failed for user'],
    ['authenticate', 'please authenticate first'],
    ['permission-denied', 'permission denied'],
    ['permissions-denied', 'permissions denied on /data'],
    ['insufficient-permissions', 'Insufficient permissions to delete'],
    ['insufficient-permission', 'insufficient permission'],
    ['upper-case', 'ACCESS DENIED'],
  ]) result(`result-auth-${id}`, text);
  // silent failures that should not count
  for (const [id, text] of [
    ['plain-error', 'something else went wrong'],
    ['not-found', 'record not found'],
    ['validation', 'Invalid arguments: expected string'],
    ['timeout', 'request timed out after 30s'],
    ['network', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['author-word', 'author not found'],
    ['authority-word', 'the authority returned 500'],
    ['empty', ''],
    ['bearer-missing', 'Bearer token missing'],
    ['quota', 'rate limit exceeded'],
    ['http-500', 'upstream returned 500'],
    ['http-404', 'upstream returned 404'],
  ]) result(`result-other-${id}`, text);
  result('result-auth-but-fingerprinting-off', 'Access denied for this resource', { fingerprinting: false });
  add('result-not-an-error', { kind: 'result', result: { content: [{ type: 'text', text: 'Access denied' }] }, options: {} }, { category: null, increments: false });
  add('result-iserror-string-true', { kind: 'result', result: { isError: 'true', content: [{ type: 'text', text: 'Access denied' }] }, options: {} }, { category: null, increments: false });
  // thrown
  thrown('thrown-status-401', { name: 'HttpError', message: 'x', status: 401 });
  thrown('thrown-status-403', { name: 'HttpError', message: 'x', status: 403 });
  thrown('thrown-statusCode-401', { name: 'HttpError', message: 'x', statusCode: 401 });
  thrown('thrown-status-404', { name: 'HttpError', message: 'x', status: 404 });
  thrown('thrown-status-500', { name: 'HttpError', message: 'x', status: 500 });
  thrown('thrown-status-401-string-not-number', { name: 'HttpError', message: 'x', status: '401' });
  thrown('thrown-name-UnauthorizedError', { name: 'UnauthorizedError', message: 'x' });
  thrown('thrown-name-ForbiddenError', { name: 'ForbiddenError', message: 'x' });
  thrown('thrown-name-AuthError', { name: 'AuthError', message: 'x' });
  thrown('thrown-name-other', { name: 'SomeError', message: 'x' });
  thrown('thrown-code-EACCES', { name: 'Error', message: 'x', code: 'EACCES' });
  thrown('thrown-code-EPERM', { name: 'Error', message: 'x', code: 'EPERM' });
  thrown('thrown-code-ENOENT', { name: 'Error', message: 'x', code: 'ENOENT' });
  thrown('thrown-message-unauthorized', { name: 'Error', message: '401 Unauthorized' });
  thrown('thrown-message-permission-denied', { name: 'Error', message: 'permission denied, open /etc/shadow' });
  thrown('thrown-message-access-denied', { name: 'Error', message: 'Access denied' });
  thrown('thrown-message-plain', { name: 'Error', message: 'boom' });
  thrown('thrown-validation-wins-over-auth-message', { name: 'ZodError', message: 'access denied' });
  thrown('thrown-auth-but-fingerprinting-off', { name: 'UnauthorizedError', message: 'x' }, { fingerprinting: false });
  return cases;
}

// ---------------------------------------------------------------------------
// sensitive-tools.json
// ---------------------------------------------------------------------------

export function buildSensitiveToolCases() {
  const { cases, add } = mk();
  const t = (id, patterns, names) => {
    const m = compileSensitiveTools(patterns);
    add(id, { patterns, names }, { size: m === null ? 0 : m.size, matches: names.map((n) => (m === null ? false : m.matches(n))) });
  };
  t('exact', ['delete_record'], ['delete_record', 'delete_records', 'Delete_record', 'xdelete_record', 'delete_record ', '']);
  t('exact-multiple', ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'ab']);
  t('prefix-wildcard', ['deploy_*'], ['deploy_', 'deploy_prod', 'deploy_prod_eu', 'deploy', 'redeploy_x', 'Deploy_x']);
  t('suffix-wildcard', ['*_delete'], ['_delete', 'x_delete', 'x_deleted', 'delete', 'a_b_delete']);
  t('infix-wildcard', ['db_*_drop'], ['db__drop', 'db_x_drop', 'db_x_y_drop', 'db_drop', 'db_x_dropx', 'xdb_x_drop']);
  t('star-only', ['*'], ['', 'anything', 'a*b']);
  t('double-star', ['a**b'], ['ab', 'axb', 'axxb', 'a', 'b']);
  t('star-at-both-ends', ['*admin*'], ['admin', 'xadmin', 'adminx', 'xadminx', 'adm in', 'ADMIN']);
  t('multiple-segments-in-order', ['a*b*c'], ['abc', 'axbyc', 'acb', 'abcabc', 'ab', 'bc', 'a_b_c_d']);
  t('segments-do-not-overlap', ['ab*ba'], ['aba', 'abba', 'ababa', 'ba', 'abxba']);
  t('segments-do-not-overlap-2', ['a*a*a'], ['a', 'aa', 'aaa', 'aaaa', 'aba', 'abababa']);
  t('first-and-last-anchored', ['x*y'], ['xy', 'xay', 'xya', 'axy', 'xyxy']);
  t('literal-regex-metachars', ['a.b', 'c+d', '(e)', '[f]', 'g|h', 'i?j', '^k$'], ['a.b', 'axb', 'c+d', 'ccd', '(e)', 'e', '[f]', 'f', 'g|h', 'g', 'i?j', 'ij', '^k$', 'k']);
  t('question-mark-is-literal', ['file_?'], ['file_?', 'file_1', 'file_']);
  t('case-sensitive', ['Send_Email'], ['Send_Email', 'send_email']);
  t('unicode-names', ['caf\u00e9_*', '\u{1F680}*'], ['caf\u00e9_x', 'cafe\u0301_x', '\u{1F680}', '\u{1F680}go', 'cafe_x']);
  t('empty-list', [], ['a', '']);
  t('invalid-entries-skipped', ['ok', '', 5, null, { a: 1 }, ['x'], true, 'deploy_*'], ['ok', 'deploy_x', '', '5', 'null']);
  t('all-invalid', ['', 5, null], ['a', '']);
  t('not-an-array', 'delete_record', ['delete_record']);
  t('null-option', null, ['x']);
  t('object-option', { a: 1 }, ['a']);
  t('too-long-entry-skipped', ['a'.repeat(257), 'b'.repeat(256), 'ok'], ['a'.repeat(257), 'b'.repeat(256), 'ok']);
  t('entry-max-length-with-wildcard', [`${'a'.repeat(255)}*`], [`${'a'.repeat(255)}`, `${'a'.repeat(255)}zzz`, 'a']);
  t('over-1000-entries-ignored', Array.from({ length: 1005 }, (_, i) => `tool_${i}`), ['tool_0', 'tool_999', 'tool_1000', 'tool_1004']);
  t('exactly-1000-entries', Array.from({ length: 1000 }, (_, i) => `tool_${i}`), ['tool_0', 'tool_999', 'tool_1000']);
  t('duplicates-collapse-exact', ['a', 'a', 'a'], ['a']);
  t('name-over-1024-never-matches-wildcard', ['a*'], [`a${'b'.repeat(1023)}`, `a${'b'.repeat(1024)}`, 'ab']);
  t('name-over-1024-exact-still-matches', [`${'z'.repeat(256)}`], ['z'.repeat(256), 'z'.repeat(2000)]);
  t('non-string-names', ['a', '*'], [null, 5, true, ['a'], { a: 1 }]);
  t('adversarial-many-stars', ['*a*a*a*a*a*a*a*a*a*a*a*a*b'], ['a'.repeat(1000), `${'a'.repeat(500)}b`, 'a'.repeat(20)]);
  t('adversarial-many-stars-long-pattern', [`${'a*'.repeat(120)}b`], ['a'.repeat(1000), `${'a'.repeat(300)}b`]);
  t('adversarial-regex-bomb-literals', ['(a+)+$', '(a|aa)+$'], [`${'a'.repeat(1000)}!`, '(a+)+$']);
  return cases;
}

// ---------------------------------------------------------------------------
// integrity-tracker.json: sequences of tools/list observations
// ---------------------------------------------------------------------------

export function buildIntegrityTrackerCases() {
  const { cases, add } = mk();
  const A = { name: 'a', description: 'tool a', inputSchema: { type: 'object' } };
  const A2 = { name: 'a', description: 'tool a (changed)', inputSchema: { type: 'object' } };
  const A3 = { name: 'a', description: 'tool a (changed again)', inputSchema: { type: 'object' } };
  const B = { name: 'b', description: 'tool b', inputSchema: { type: 'object' } };
  const C = { name: 'c', description: 'tool c', inputSchema: { type: 'object' } };
  const h = (d) => computeToolDefinitionHash(d);
  const seq = (id, pins, steps) => {
    const tracker = new ToolIntegrityTracker(new Map(Object.entries(pins)));
    const out = steps.map((s) => {
      const o = tracker.observe(s.tools, s.complete);
      return JSON.parse(JSON.stringify({ findings: o.findings, violationTools: o.violationTools, firstSnapshot: o.firstSnapshot }));
    });
    add(id, { pins, steps }, { steps: out, hashes: tracker.getHashes() });
  };
  seq('first-listing-no-events', {}, [{ tools: [A, B], complete: true }]);
  seq('stable-listing-no-events', {}, [{ tools: [A, B], complete: true }, { tools: [A, B], complete: true }, { tools: [B, A], complete: true }]);
  seq('change-detected-once', {}, [{ tools: [A], complete: true }, { tools: [A2], complete: true }, { tools: [A2], complete: true }]);
  seq('change-then-another-change', {}, [{ tools: [A], complete: true }, { tools: [A2], complete: true }, { tools: [A3], complete: true }]);
  seq('change-then-revert-then-change-again', {}, [{ tools: [A], complete: true }, { tools: [A2], complete: true }, { tools: [A], complete: true }, { tools: [A2], complete: true }]);
  seq('pin-matches', { a: h(A) }, [{ tools: [A], complete: true }, { tools: [A], complete: true }]);
  seq('pin-mismatch-on-first-observation', { a: h(A2) }, [{ tools: [A], complete: true }, { tools: [A], complete: true }]);
  seq('pin-mismatch-after-change', { a: h(A) }, [{ tools: [A], complete: true }, { tools: [A2], complete: true }, { tools: [A2], complete: true }]);
  seq('pin-mismatch-then-back-to-pin-then-mismatch', { a: h(A) }, [{ tools: [A2], complete: true }, { tools: [A], complete: true }, { tools: [A2], complete: true }]);
  seq('change-and-pin-mismatch-one-violation', { a: h(A) }, [{ tools: [A], complete: true }, { tools: [A2], complete: true }]);
  seq('pinned-tool-never-listed', { zzz: h(A) }, [{ tools: [A], complete: true }]);
  seq('added-on-second-complete-listing', {}, [{ tools: [A], complete: true }, { tools: [A, B], complete: true }]);
  seq('removed-on-second-complete-listing', {}, [{ tools: [A, B], complete: true }, { tools: [A], complete: true }]);
  seq('removed-then-added-back', {}, [{ tools: [A, B], complete: true }, { tools: [A], complete: true }, { tools: [A, B], complete: true }]);
  seq('removed-and-added-same-listing', {}, [{ tools: [A, B], complete: true }, { tools: [A, C], complete: true }]);
  seq('pagination-skips-added-removed', {}, [{ tools: [A, B], complete: true }, { tools: [A], complete: false }, { tools: [A, B], complete: true }]);
  seq('pagination-pages-before-first-complete', {}, [{ tools: [A], complete: false }, { tools: [B], complete: false }, { tools: [A, B], complete: true }]);
  seq('pagination-still-checks-hashes', {}, [{ tools: [A], complete: true }, { tools: [A2], complete: false }]);
  seq('pagination-pin-mismatch', { a: h(A) }, [{ tools: [A2], complete: false }]);
  seq('first-snapshot-only-from-first-complete', {}, [{ tools: [A], complete: false }, { tools: [A, B], complete: true }, { tools: [A, B, C], complete: true }]);
  seq('empty-then-tools', {}, [{ tools: [], complete: true }, { tools: [A], complete: true }]);
  seq('tools-then-empty', {}, [{ tools: [A, B], complete: true }, { tools: [], complete: true }]);
  seq('tools-not-array', {}, [{ tools: null, complete: true }, { tools: 'x', complete: true }, { tools: { a: 1 }, complete: true }]);
  seq('invalid-entries-skipped', {}, [{ tools: [null, 5, 'x', {}, { name: '' }, { name: 7 }, A], complete: true }]);
  seq('duplicate-names-in-one-listing', {}, [{ tools: [A, A2], complete: true }]);
  seq('definition-fields-outside-hash-ignored', {}, [{ tools: [{ ...A, _meta: { v: 1 } }], complete: true }, { tools: [{ ...A, _meta: { v: 2 }, icons: [] }], complete: true }]);
  seq('annotation-change-is-a-change', {}, [{ tools: [{ ...A, annotations: { readOnlyHint: true } }], complete: true }, { tools: [{ ...A, annotations: { readOnlyHint: false } }], complete: true }]);
  seq('schema-change-is-a-change', {}, [{ tools: [A], complete: true }, { tools: [{ ...A, inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }], complete: true }]);
  return cases;
}
