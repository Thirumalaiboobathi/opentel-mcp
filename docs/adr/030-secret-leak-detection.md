# ADR 030: Secret leak detection in tool outputs

**Status:** Accepted (core 0.18.0).

## Context

A tool can return a credential it should not: a debug dump that includes an
environment variable, a config file read, an upstream error echoing an
`Authorization` header. The result goes to the model and then to the user, the
transcript and logs. Nothing in opentel-mcp looks at result content today, and
by design nothing may *record* it.

What exists:

- Credential detectors for **error text**: `SECRET_STEPS` (a frozen list of
  `{pattern, replacement}`) and `scrubSecrets()`
  (`fingerprint/normalize/secrets.js:28-93`). Six shapes: credentials in URLs,
  JWTs, `Bearer`/`Basic` tokens, AWS key ids, provider-prefixed API keys, and
  secret-named key assignments (three steps). They have no names or types.
- They are applied to error messages before fingerprinting and to
  `errorRecording.mode: 'full'` messages/stacks (v0.17.0), with inputs capped
  at 2048/4096/16384 characters (`fingerprint/normalize/message.js`,
  `instrument.js` `MAX_FULL_*`). They have never run on 64 KiB of text.
- The tool-call wrapper has the result in hand in both branches: `isError`
  results at `instrument.js:2077-2160` and successes at `:2151-2162`.
- The patterns are also exported as language-neutral fixtures to
  `conformance/patterns.json` through `gen-conformance.mjs:step()`, which reads
  only `pattern`, `flags`, `replacement`, so extra fields on a step do not
  change those fixtures.

## Decision

An opt-in signal that reuses the existing detectors and reports **that** a
secret-shaped string was returned, never **what**.

### 1. Option

```js
secretLeakDetection: { enabled: false, maxScanBytes: 65536 }
```

`enabled` defaults to **false**. `maxScanBytes` must be a positive finite
integer; otherwise warn once and use 65536. Non-object values warn once and are
ignored.

### 2. What is scanned

`result.content[]` items with `type === 'text'` and a string `text`, for both
successful results and `isError: true` results, in order, until the budget is
used. Images, resources, `structuredContent` and `_meta` are not scanned (limit,
documented). Each item is scanned on its own: a secret split across two items is
missed.

Budget: `maxScanBytes` is measured in **JavaScript string length (UTF-16 code
units)**, not UTF-8 bytes, so no encoding pass over a large result is needed.
The name follows the brief; the unit is documented. When the budget runs out,
the current item is sliced to the remaining length, scanning stops, and the span
records `scan_truncated`. A result above the cap is truncated, never rejected.
A secret cut at the boundary is missed (limit).

### 3. Detector types

Each `SECRET_STEPS` entry gets an internal `type` from a closed enum, without
touching `pattern` or `replacement`, so scrubbing and fingerprints are
byte-identical and `conformance/patterns.json` is unchanged:

`url_credentials`, `jwt`, `http_auth_credential`, `aws_access_key_id`,
`provider_api_key`, `secret_assignment` (three steps share it).

A new export `detectSecretTypes(text)` returns `{ types: Set, count }` using
`String.prototype.matchAll` (which clones the regex, so the shared global
patterns' `lastIndex` is never mutated). The matched substring, its index and
its context are never kept: only a type name enters the result. `count` is the
number of matches summed over steps, capped at 1000 (overlapping steps can
match the same text twice, so it is a magnitude, not a distinct-secret count).

### 4. Output

On the `tools/call` span, only when a detection occurs (plus `scan_truncated`
when true):

| Attribute | Type |
|---|---|
| `mcp.tool.secret_leak.detected` | boolean (`true`) |
| `mcp.tool.secret_leak.types` | string[] (sorted, deduplicated, from the enum) |
| `mcp.tool.secret_leak.count` | int |
| `mcp.tool.secret_leak.scan_truncated` | boolean, only when `true` |

Counter `mcp.tool.secret_leaks` (+1 per call with a detection), label
`gen_ai.tool.name` only. **Type is span-only.** A six-value enum would be
set-bounded and safe under ADR 021, but this release adds no new metric label
keys and `METRIC_SAFE_ATTRIBUTES` (`attributes.js:302`) stays as is. Per-type
metrics can be revisited in a later ADR.

A leak does **not** change span status and is not an error: it is a signal.
`isError` results keep their existing ERROR status; successes stay OK.

### 5. Never throws, never records

Everything runs in its own `try/catch`; failures degrade to one `diag.debug`.
Hostile input is bounded by the scan cap and match cap. Getters that throw on
`result.content` are caught. The detector's return value contains no text. A
canary test asserts matched secrets appear in no span, metric, event or log.

### 6. False positives and wording

The detectors are pattern-based. They will miss formats (no entropy analysis,
no cloud-specific keys beyond the list, secrets split across items or cut by the
cap) and they can fire on benign text (a documentation example `password=...`,
an AKIA-shaped test value, a JWT in a demo). The signal is "this output
**looked like** a credential", never "no secret was returned". Documentation
uses "signal, not a guarantee", and recommends routing the span attribute to an
alert and reviewing the tool, not auto-acting.

## Alternatives considered

- **Add a new detector set for outputs.** Rejected: two lists would drift; the
  existing set is already conformance-tested and Python-ported.
- **Record the secret type as a metric label.** Rejected for this release (no
  new label keys); see above.
- **Redact the output** (act as a DLP). Rejected: observability must not alter
  responses; that is enforcement.
- **Scan `structuredContent` and resource blobs.** Deferred: the shape space
  is larger and the false-positive and cost story needs its own design.
- **Byte-exact budget.** Rejected: encoding large strings to count bytes
  would add cost to the exact path the cap is meant to bound.

## Consequences

Cost is zero when disabled (one boolean check) and linear in the scanned
characters when enabled; a performance test pins the 64 KiB case. The patterns
had only been run on short error strings, so Task 7 includes adversarial
inputs against the URL-credential pattern.
