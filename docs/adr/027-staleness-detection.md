# ADR 027: Staleness detection

**Status:** Accepted (implemented in core 0.17.0, ui 0.3.0).

**Suggested by:** the r/mcp community. A market-data MCP server operator
pointed out a failure nothing currently catches: a read tool returns data
older than the freshness it implies. The response is complete and
successful, the span is green, and the agent acts on stale data with full
confidence. For market data that's the worst kind of failure, because the
payload looks fine.

The design agreed in that thread:

- **The tool is the source of truth.** It knows its own data cadence, so it
  reports freshness in `result._meta`.
- **Instrumentation config is only an override.** Config "only knows what
  someone typed on setup day and drifts."
- **Per tool, opt in.** Quotes are fresh for seconds; daily bars are fresh
  until the trading session closes.

## Step 0 findings

All line numbers are as of core 0.16.0 (before this change).

### Where core reads `result._meta` today

Only the cost extractor reads a tool result's `_meta`, in
`packages/core/src/cost/extractor.js`:

- `extractor.js:87` reads `root._meta.model`, guarded by
  `isPlainObject(root._meta)`.
- `extractor.js:179-180` reads `toolResult._meta.usage`, guarded by
  `isPlainObject(toolResult._meta)`.
- The guard itself is `isPlainObject()` at `extractor.js:42-44`.

The extractor runs from `applyCostAttribution()`
(`src/instrument.js:1233`, the `costTracking.extractor(result)` call at
`:1237`), in both the `isError` branch and the success branch of
`wrapToolCallHandler()` (`:2049` and `:2087`).

`src/tracecontext/extract.js` also reads a `_meta`, but it's the
*request's* `params._meta` (`instrument.js:1963`), not the result's, so it
isn't the access path to reuse.

**Decision:** this change factors that guard-and-read into one helper,
`readResultMetaField(result, key)` in `src/result-meta.js`. The extractor's
two reads and the new freshness reader both go through it. There is still
exactly one way core reaches into `result._meta`, and it reads exactly the
key it's given, never the whole object.

### The MCP spec's rules for custom `_meta` keys

From the current specification (2025-11-25), Basic → General fields →
`_meta`, quoted:

> **Key name format:** valid `_meta` key names have two segments: an
> optional **prefix**, and a **name**.
>
> **Prefix:**
>
> * If specified, MUST be a series of labels separated by dots (`.`),
>   followed by a slash (`/`).
>   * Labels MUST start with a letter and end with a letter or digit;
>     interior characters can be letters, digits, or hyphens (`-`).
>   * Implementations SHOULD use reverse DNS notation (e.g., `com.example/`
>     rather than `example.com/`).
> * Any prefix where the second label is `modelcontextprotocol` or `mcp` is
>   **reserved** for MCP use.
>   * For example: `io.modelcontextprotocol/`, `dev.mcp/`,
>     `org.modelcontextprotocol.api/`, and `com.mcp.tools/` are all reserved.
>   * However, `com.example.mcp/` is NOT reserved, as the second label is
>     `example`.
>
> **Name:**
>
> * Unless empty, MUST begin and end with an alphanumeric character
>   (`[a-z0-9A-Z]`).
> * MAY contain hyphens (`-`), underscores (`_`), dots (`.`), and
>   alphanumerics in between.

(The 2025-06-18 revision has the same structure, minus the reverse-DNS
recommendation.)

**Chosen key:** `io.github.thirumalaiboobathi.opentel-mcp/freshness`

- Reverse DNS for a namespace this project actually controls: its GitHub
  repository, `github.com/Thirumalaiboobathi/opentel-mcp`. This is the same
  `io.github.<owner>` convention the official MCP Registry uses for server
  names.
- Every label starts with a letter and ends with a letter (`opentel-mcp`
  has an interior hyphen, which is allowed).
- The second label is `github`, so the prefix isn't reserved.
- The name `freshness` is alphanumeric.

The key is exported as `FRESHNESS_META_KEY`, so authors never need to type
it. A shorter, unowned prefix (`opentel-mcp/`, `dev.opentel-mcp/`) would
also be syntactically valid, but it would ignore the spec's SHOULD and
claim a namespace nobody owns.

### Where per-tool config lives today

Nowhere. No core option today is keyed by tool name:

- `costTracking.budget.perToolUsd` (`src/cost/budget.js:32`, read at `:116`)
  is a single number applied to every tool, not a per-tool map.
- `thrashDetection`, `schemaDrift`, `unactionableErrors` and `coverage` are
  all server-wide (`src/config.js:254` `resolveOptions()`, returned object at
  `:332-353`).

So the override introduces the first per-tool map, under its own feature
option (`staleness`), resolved by its own `resolveStalenessConfig()` like
every other feature.

## Decision

### 1. The `_meta` contract (what a tool author writes)

```js
return {
  content: [...],
  _meta: {
    'io.github.thirumalaiboobathi.opentel-mcp/freshness': {
      asOf: '2026-10-12T14:30:00.000Z', // when the data is from
      maxAgeMs: 5_000,                  // how old it may be
      // or, instead of maxAgeMs:
      // freshUntil: '2026-10-12T20:00:00Z', // absolute deadline
    },
  },
};
```

| Field | Type | Meaning |
| --- | --- | --- |
| `asOf` | ISO 8601 string **with** `Z` or `±hh:mm`, or epoch **milliseconds** (number) | When the data is from: the quote's exchange timestamp, the bar's close, the cache fill time. Not when the tool ran. |
| `maxAgeMs` | finite number ≥ 0 | How old the data may be and still count as fresh. |
| `freshUntil` | same formats as `asOf` | Absolute deadline, for windows that aren't a fixed duration ("until the session closes"). |

`asOf` is required, plus at least one of `maxAgeMs` / `freshUntil`.

**Both `maxAgeMs` and `freshUntil` given: the earlier deadline wins.** Both
are claims the tool made about its own data. If the data has outlived
either claim, the tool's own contract is broken, so the stricter one
decides. Picking one field by name ("`freshUntil` is more specific") would
let a tool contradict itself silently. Earliest-wins can only report stale
sooner, never later, which is the conservative direction for something an
agent acts on.

### 2. Config override

```js
instrumentMcpServer(server, {
  staleness: {
    tools: {
      get_quote: { maxAgeMs: 2_000 },
    },
  },
});
```

- `staleness.tools[toolName].maxAgeMs` is the only override. Config can't
  invent `asOf`: only the tool knows when its data is from. A response with
  no freshness key gets no verdict whatever the config says.
- When an override exists for a tool, it **replaces the tool's window**:
  the tool's `maxAgeMs` and `freshUntil` aren't read at all, and
  `mcp.tool.freshness.limit_source` is `config`. An override that only
  sometimes applied would be impossible to reason about.
- An invalid override value (negative, non-finite, non-number) is dropped at
  startup with one `diag.warn`, and that tool falls back to its own window.
- `staleness.enabled: false` turns the feature off: `_meta` isn't read and
  no attributes or metrics are emitted. It defaults to `true`, which costs
  nothing for tools that don't report freshness (one property check per
  successful call).

### 3. The verdict

Computed once per successful `tools/call`, right after the handler
resolves, using `Date.now()`:

- `ageMs = now − asOf`
- `deadline = min(asOf + maxAgeMs, freshUntil)` (or `asOf + override` when
  an override exists)
- **`fresh`** if `now ≤ deadline`; **`stale`** if `now > deadline`
- **`unknown`** if the tool sent the freshness key but no verdict can be
  computed from it (see edge cases)
- **No verdict and no attributes at all** if the result has no freshness
  key. This is "unknown" in the sense of the brief; it's left as an absent
  attribute rather than an `unknown` value on every span of every tool
  that never opted in. Those tools' spans stay byte-identical to 0.16.0.

### 4. Edge cases

| Input | Outcome |
| --- | --- |
| No `_meta`, or `_meta` without the key | Nothing. No attributes, no warn. |
| Key present but not a plain object (string, array, null) | `unknown`, reason `invalid_as_of`, one warn per tool. |
| `asOf` missing, or unparseable | `unknown`, reason `invalid_as_of`. |
| `asOf` string without a timezone (`2026-10-12T14:30:00`), or a date only | `unknown`, reason `invalid_as_of`. Local-time interpretation would make the verdict depend on the server's timezone. |
| `asOf` is a numeric string (`"1791799200000"`) | `unknown`, reason `invalid_as_of`. Numbers must be numbers. |
| `asOf` number below 1e11 (before March 1973 as ms) | `unknown`, reason `invalid_as_of`. That's almost certainly epoch **seconds**; read as ms it would be "55 years stale" on every call. The warn says so. |
| `asOf` outside JavaScript's Date range, `NaN`, `Infinity` | `unknown`, reason `invalid_as_of`. |
| `asOf` in the future by ≤ 5 s | Treated as clock skew: age clamps to 0, verdict computed normally. |
| `asOf` in the future by > 5 s | `unknown`, reason `future_as_of`. Data from the future isn't fresh; it's a broken clock. |
| Neither `maxAgeMs` nor `freshUntil`, and no override | `unknown`, reason `missing_window`. Age is still recorded. |
| `maxAgeMs` negative, `NaN`, `Infinity`, a string, etc. | `unknown`, reason `invalid_window`. If **any** supplied window field is malformed, the whole window is rejected, rather than silently using the other one. |
| `freshUntil` unparseable | `unknown`, reason `invalid_window`. |
| `freshUntil` before `asOf` | `unknown`, reason `invalid_window`. |
| `maxAgeMs: 0` | Valid: fresh only if age is 0 (after skew clamping). |
| Huge finite `maxAgeMs` (e.g. `Number.MAX_SAFE_INTEGER`) | Valid; effectively never stale. The deadline is capped at the Date range, never overflows. |
| String fields longer than 64 characters | `invalid_as_of` / `invalid_window` without being parsed. |
| A getter that throws, a Proxy, a cyclic object | Caught. No attributes. The tool call result is returned untouched. |
| `isError: true` result | Skipped entirely. Freshness of an error is meaningless, and the response is already counted as a silent failure. |
| Thrown error / protocol error | Skipped. There's no result. |

**Never-throw:** the whole computation runs inside one `try/catch`. Bad
input produces no verdict (or `unknown`) and **at most one `diag.warn` per
tool name per instrumented server**. The warned set is capped at 256 tool
names, so a flood of bogus names can't grow it.

### 5. Span attributes

Set on the `tools/call` span only when the freshness key is present:

| Attribute | Type | When |
| --- | --- | --- |
| `mcp.tool.freshness.verdict` | string: `fresh` \| `stale` \| `unknown` | Always, when the key is present |
| `mcp.tool.freshness.data_age_ms` | number (integer ms) | Whenever `asOf` parsed and wasn't too far in the future |
| `mcp.tool.freshness.max_age_ms` | number (integer ms) | When a verdict exists. The effective window: `deadline − asOf`, so a `freshUntil` window is reported in the same unit as a `maxAgeMs` one. |
| `mcp.tool.freshness.limit_source` | string: `max_age_ms` \| `fresh_until` \| `config` | When a verdict exists. Which input set the deadline (with both tool fields, whichever was earlier). |
| `mcp.tool.freshness.unknown_reason` | string: `invalid_as_of` \| `future_as_of` \| `missing_window` \| `invalid_window` | Only when the verdict is `unknown` |

Data age is on spans only, never on a metric.

**Privacy:** core reads `_meta[FRESHNESS_META_KEY]` and then only its
`asOf`, `maxAgeMs` and `freshUntil` properties. It never enumerates
`_meta`, never reads `content` or `structuredContent` for this feature, and
never emits a raw input value. The timestamps are converted to numbers,
and only the derived age and window reach the span.

**Span status is untouched.** A stale response stays `OK`, with no
`error.type`. Staleness is a property of the data, not a failure of the
call; it's its own signal, read from its own attribute.

### 6. Metric

One new counter: **`mcp.tool.stale_responses`**, `+1` per `stale` verdict,
labelled with `gen_ai.tool.name` only.

- No new label key. `gen_ai.tool.name` is already in
  `METRIC_SAFE_ATTRIBUTES`, and the ADR 021 cross-check test covers
  `src/metrics.js`, where the counter lives.
- Cardinality is no worse than `mcp.tool.calls`, which already carries the
  same label on every call. It's actually tighter: a series only appears
  for a tool name whose handler ran and returned a successful result
  containing a well-formed freshness key and a stale verdict. Bogus tool
  names from a misbehaving client never get there.
- No counter for `fresh`/`unknown` and no verdict label: either would need a
  new label key or two more instruments. The rate denominator is available
  from spans; a metric denominator can come later if someone asks for it
  (follow-up).

### 7. Interaction with existing signals

- **Silent failures:** none. `mcp.tool.silent_failures` and
  `error.type = tool_error` are only for `isError: true`, and staleness is
  never computed for those.
- **ToolOutcome counter / observation matrix:** a stale response is a
  `SUCCESS` outcome. The matrix is about whether the call failed; staleness
  is a separate axis.
- **Fingerprinting:** untouched. Fingerprints are for failures.
- **Thrash:** a stale response is a success, so it clears the tool's thrash
  state exactly as before (`applyThrashSuccessClear()`). An agent re-polling
  a stale quote isn't thrash in the ADR 007 sense (it isn't failing), and
  bending thrash to cover it would mix two signals.
- **Health grades (UI):** staleness becomes the fifth signal: the stale
  rate among responses **with a verdict** (`fresh` or `stale`; `unknown`
  is excluded from both numerator and denominator). A tool with fewer than
  10 verdicts gets `n/a` for this signal and is graded on the other four,
  the same minimum-sample rule the grade itself uses. Thresholds are in
  `docs/health-grades.md`.
- **Cost, budget, unactionable errors, schema drift:** independent.

## Alternatives considered

1. **Config-only (`staleness.tools.get_quote.maxAgeMs` plus a result
   timestamp path).** Rejected: this is the drift problem the thread
   raised. The window lives in setup code while the cadence lives in the
   tool, and the two diverge silently. It also can't express "until the
   session closes", which changes every day. Config stays as an override.
2. **Freshness as a separate tool call, or a `tools/list` annotation.**
   Rejected: a static annotation can't carry `asOf`, which differs per
   response. A side channel means an extra round trip and a race between
   the data and its metadata. The response that carries the data must
   carry its age.
3. **Parsing timestamps out of `content` / `structuredContent`.** Rejected
   on privacy grounds: core would have to read result content, which no
   feature in this codebase does for successes. It would also mean guessing
   field names.
4. **Marking stale responses as span `ERROR` / `isError`.** Rejected:
   every backend alerting on error rate would page on a market being
   closed. Staleness is a data-quality signal, not a call failure.
5. **An un-namespaced key (`_meta.freshness`, `_meta.asOf`).** Rejected:
   unprefixed names are where the spec and SDKs add their own keys, so a
   collision is only a matter of time.
6. **Emitting `verdict: unknown` on every span without the key.** Rejected:
   it adds an attribute to every tool span in every deployment that never
   opted in, and changes span shape for existing users. Absence already
   means "no verdict".
7. **A `verdict` label on a single `mcp.tool.freshness` counter.** Rejected:
   it's a new metric label key, which this release rules out.

## Consequences

- Tool authors get a stable, exported key and type (`FRESHNESS_META_KEY`,
  `FreshnessMeta`). The key string is now public contract; changing it
  would be a breaking change.
- One new metric instrument: dev-mode metrics now print 13 instruments.
- The UI can show data age, a "Stale data" filter, and a fifth health
  signal, and hides all of it against older cores, which never emit the
  attributes.
- Freshness is judged at response time. Data that goes stale between the
  response and the agent acting on it isn't caught, which is inherent to
  observing on the server.
