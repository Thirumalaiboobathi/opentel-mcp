# ADR 025: Flagging unactionable tool errors

**Status:** Proposed — awaiting approval. Investigation and design only; nothing in this ADR is implemented.

## Context

A silent failure (`isError: true` inside a successful JSON-RPC response) is
already detected, classified and fingerprinted. What isn't visible is whether
the error **gives the agent anything to act on**. A tool returning
`{ isError: true, content: [] }` or `content: [{ type: 'text', text: 'Error' }]`
leaves the model guessing. That is a common cause of retries and thrash, and
it's the tool author's bug, not the agent's.

Goal: flag those failures **without capturing argument values or result
content**. Only derived, non-reversible signals (lengths, counts, booleans).

## Step 0 findings

### Where result content is available

The only place core sees tool result content is the resolved branch of the
tool-call wrapper, `wrapToolCallHandler()` (`packages/core/src/instrument.js:1697`):

- `const result = await handler(request, extra)` (`instrument.js:1770`)
- `isToolResultError(result)` (`instrument.js:839-841`, `result?.isError === true`)
  gates the silent-failure branch (`instrument.js:1772`)

The thrown branch (`instrument.js:1852` onward) has an `Error`, not a
`CallToolResult`, so this ADR doesn't apply there.

### What's already derived from that content today

All of it lives inside `if (fingerprintingEnabled)` (`instrument.js:1779`):

| Derivation | Reads | Lands on span as | Source |
| --- | --- | --- | --- |
| Fingerprint | `content[0].text` only (as the coerced message) | `mcp.failure.fingerprint`: a hash, never the text | `normalize/exception.js:65-68`, hashed at `fingerprint/compose.js:118-120` |
| Category | same message text, through the classifier chain | `mcp.failure.category` (bounded enum; `"unknown"` fallback) | `fingerprint/classify/index.js:48-58` |
| Channel | same message text | `mcp.failure.channel` (bounded enum) | `fingerprint/classify/channel.js`; set at `instrument.js:1795-1796` |
| Validation paths | `content[0].text` | `mcp.failure.validation_paths`: **schema field names** parsed from the SDK's validation message | `classify/validation-paths.js:100-102`; set at `instrument.js:1804` |
| Cost/usage | `result` usage fields (numbers) | `mcp.tool.tokens.*`, `mcp.tool.cost.usd` | `applyCostAttribution()` |

Two facts matter for this ADR:

1. **Only `content[0]` is read anywhere.** A result whose useful text sits in
   `content[1]` looks empty to every existing derivation.
2. **An empty-content failure already has a stable identity.** The coerced
   message is `''` (`exception.js:68`), so the classifiers fall back to
   `"unknown"` (`classify/index.js:58`), and every empty failure of one tool
   shares one fingerprint. The new signal must not change that.

### Metrics today

The silent-failure counter (`metrics.js:121-126`) is labeled
`gen_ai.tool.name` + `mcp.failure.category`. `METRIC_SAFE_ATTRIBUTES`
(`src/attributes.js:279-285`, `src/fingerprint/attributes.js:87`) is enforced
against real call sites by the ADR 021 cross-check
(`test/metrics.test.js:262`).

## Decision (proposed)

### What's computed, and from what

Computed only in the `isError` branch, from the shape of `result.content`.
**No content text is ever stored, hashed, compared or emitted by this
feature.** It reads strings only to measure them.

```
textItems   = content items with type === 'text' and a string .text
textLength  = sum over textItems of item.text.trim().length
nonText     = count of other content items (image, audio, resource, resource_link)
```

`trim()` inspects characters only to drop whitespace. The output is still a
number. Whitespace-only text is the same "nothing to act on" as no text.

**Unactionable** when **either**:

- `content` is missing, not an array, or empty; **or**
- `textLength < minTextLength` **and** `nonText === 0`.

A failure that carries an image or a resource link has handed the agent
*something*, so it isn't flagged on length alone.

### Attributes (span only)

| Attribute | Type | Values | Set when |
| --- | --- | --- | --- |
| `mcp.failure.unactionable` | boolean | `true` / `false` | every `isError: true` result (both values, so "checked and fine" is distinguishable from "not computed") |
| `mcp.failure.content_length_bucket` | string enum | `empty`, `tiny`, `short`, `medium`, `long` | every `isError: true` result |

Buckets on `textLength`: `empty` = 0; `tiny` = 1 to `minTextLength − 1`;
`short` < 80; `medium` < 500; `long` ≥ 500. Five fixed values. The exact
length is never emitted.

### Threshold and configuration

```ts
instrumentMcpServer(server, {
  unactionableErrors: { enabled: true, minTextLength: 10 },
});
```

- `minTextLength` default **10** (trimmed characters). Catches `""`, `"Error"`
  (5), `"failed"` (6), `"undefined"` (9), `"error: null"` (11 → not flagged,
  borderline). Integers 0–200 accepted; `0` means "only empty is
  unactionable". Invalid values fall back to the default and never throw.
- `enabled` default **true**, and **independent of `fingerprinting`**. This
  signal reads lengths only, a strictly smaller read than fingerprinting's
  hash of normalized text, so opting out of fingerprinting shouldn't silently
  disable it. Same env-var pattern as `schemaDrift` (`OPENTEL_MCP_…`) for
  parity.
- Length is a proxy, not semantics. `"Something went wrong"` (20) isn't
  flagged although it's useless. Accepted: detecting that would mean matching
  on content, which is out of bounds (see Alternatives).

### Metric: none in this release

`mcp.failure.unactionable` is bounded (2 values) and would be **metric-safe**
by ADR 021's criteria, and the bucket (5 values) would be too. Adding either as
a label on `mcp.tool.silent_failures` still multiplies that counter's series
(×2 or ×5 per tool × category) and changes the allowlist the ADR 021 test
enforces. **Proposal: span-only for now.** The UI derives counts from spans,
and a backend can count spans by attribute. Revisit a metric label if users
ask for alerting on it. **Not** added to `METRIC_SAFE_ATTRIBUTES` in this
change, so the ADR 021 cross-check stays exactly as it is.

### Interaction with fingerprinting and classification

- **Fingerprint unchanged.** The new attributes aren't hash inputs, and
  `HASH_INPUT_VERSION` doesn't change. Existing fingerprints stay stable
  across the upgrade.
- **Category unchanged.** An empty failure stays `"unknown"`. Unactionable is
  an orthogonal axis (a validation error can be actionable; an `"unknown"` one
  can be perfectly actionable).
- **Channel unchanged.**
- **Thrash.** No change to detection. Later work could correlate
  "unactionable" with thrash episodes in the UI; that needs no core change.
- **Order.** Computed before `computeFingerprint`, so a classifier failure
  can't suppress it. Wrapped in its own `try/catch`; on any exception, both
  attributes are omitted, never guessed.

### UI (opentel-mcp-ui)

- A count, "errors your agent can't act on", next to the silent-failure
  numbers, from spans with `mcp.failure.unactionable === true`.
- A filter on the silent-failure feed for the same.
- Demo fixtures: a few `tool_error` spans carrying
  `mcp.failure.unactionable: true` and `content_length_bucket: 'empty' | 'tiny'`.
- Version-compatible by construction: older cores never set the attribute, and
  the UI shows "—" / hides the filter rather than "0" when no span in the
  buffer carries it.

## How a test proves no content reaches spans or metrics

1. Fixture tools return `isError: true` with canary strings that can't
   occur anywhere else, e.g. `CANARY-7f3a…` in `content[0]`, in `content[1]`,
   and padded to every bucket boundary, plus whitespace-only and empty cases.
2. Run them through a real `McpServer` (v1 and v2) with an
   `InMemorySpanExporter` and an `InMemoryMetricExporter`, fingerprinting
   **off**, so only this feature reads content.
3. `JSON.stringify` every exported span (attributes, events, status message)
   and every metric data point. Assert no canary substring appears, and assert
   the only new keys are the two above, with values from their fixed domains.
4. Repeat with fingerprinting **on** and assert the same canary absence.
   Existing derivations (`validation_paths` carries schema field *names* by
   design, ADR 009) are excluded by choosing canaries that aren't validation
   messages, and the test says so explicitly.
5. Boundary tests: `minTextLength − 1` → `tiny` + unactionable; exactly
   `minTextLength` → `short`/not unactionable (when < 80); image-only content →
   not unactionable; `content` absent → unactionable.

## Alternatives considered

1. **Phrase matching** (`"error"`, `"failed"`, `"something went wrong"`).
   Rejected: classifies on content text, ships a word list that becomes
   policy, and is language-specific.
2. **Emit the exact length** (`mcp.failure.content_length`). Rejected:
   unbounded, and exact lengths of short strings can leak information
   ("length 4" for a known error set). Buckets are enough.
3. **Hash the text** to detect "same useless message repeated". Already
   covered by the fingerprint; no new hash needed.
4. **Fold into category** (`category: "unactionable"`). Rejected: overwrites a
   real category (a `validation_error` with no detail is still a validation
   error) and would change fingerprints.
5. **Metric label now.** Deferred, see "Metric".

## Open questions for the maintainer

1. `minTextLength` default: 10 (recommended), or 16 to also catch
   `"Internal error"`-style messages at the cost of flagging
   `"Not found: user"`?
2. Should non-text content (image, resource link) exempt a failure, as
   proposed, or count only if it's a `resource_link`?
3. Keep `enabled` independent of `fingerprinting` (recommended), or tie them
   together for a simpler mental model ("fingerprinting off = no content
   reads at all")?
4. Span-only for now (recommended), or add `mcp.failure.unactionable` to the
   silent-failure counter's labels in the same release?
5. Should only `content[0]` be measured, for parity with the existing
   derivations, or all text items (proposed)? All items is more correct; the
   asymmetry with fingerprinting would be documented.
