# ADR 006: Deep failure fingerprinting

**Status:** Accepted

## Context

v0.4 adds `mcp.failure.*` span attributes and an `mcp.failure.category`
metric attribute (see `src/fingerprint/`), aimed at the "silent failure"
problem this package already surfaces via `mcp.tool.silent_failures` and
`error.type` (ADR 004, ADR 005): once a failure is visible, the next
question an operator asks is "is this the *same* failure happening
repeatedly, or a new one?" Grouping thrown errors and `isError: true`
tool results by underlying cause — not by their literal text — is what
this feature answers.

Two design questions had to be settled before implementation:

1. **Why not just hash the raw error message?** Real error messages are
   full of high-cardinality, run-specific values — UUIDs, request ids,
   timestamps, ports, file paths, quoted opaque tokens. Two occurrences of
   the exact same bug ("user X not found") would hash to two different
   fingerprints every single time, because `X` differs. A naive
   `sha256(message)` fingerprint is therefore useless for grouping: it has
   the cardinality of individual failures, not of underlying causes,
   which defeats the entire point of fingerprinting.
2. **Why not send failures to a hosted grouping service (Sentry-style)?**
   That's the industry-standard approach for this exact problem, but it
   requires a network call, an API key, and a third-party account in the
   critical path of instrumenting an MCP server — directly against this
   package's zero-new-runtime-dependency, API-only stance (ADR 005) and
   its goal of being a one-line, infra-free `instrumentMcpServer()` call.
   Fingerprinting needed to be computed locally, synchronously, from
   nothing but the error/result object already in hand.

## Decision

- **Hash: SHA-256, truncated to the first 16 hex characters (64 bits)**
  (`src/fingerprint/hash.js`). This is an identity hash, not a security
  hash — 64 bits gives acceptable collision odds at realistic
  distinct-failure-fingerprint volumes (see the birthday-bound math in
  `hash.js`'s own docblock), truncation of a good hash is safe for this
  purpose per NIST SP 800-107, and it's fast enough to stay inside the
  pipeline's p99 < 200µs budget (`test/fingerprint/benchmark.test.js`).
- **Versioned input format**: the hashed string is always
  `v1|{errorClass}|{category}|{origin}|{toolName}|{normalizedMessage}|{stackSignature}`
  (`HASH_INPUT_VERSION` in `src/fingerprint/compose.js`). The leading
  version tag means a future change to what goes into the hash (e.g.
  adding a field, changing normalization rules) can ship as `v2` without
  silently colliding with or silently reinterpreting `v1` fingerprints
  already recorded/dashboarded by consumers.
- **Normalization before hashing, not the raw message**: the message goes
  through an ordered `NORMALIZE_STEPS` pipeline
  (`src/fingerprint/normalize/patterns.js`) that strips UUIDs, emails,
  URLs, IPs, timestamps, paths, hex blobs, ports, bare numbers, and quoted
  opaque ids down to placeholder tokens (`<UUID>`, `<EMAIL>`, ...) before
  hashing — this is what makes two occurrences of "the same bug" collapse
  to the same fingerprint despite differing embedded values. The stack is
  independently normalized and reduced to a `fn@file:line` signature over
  the top N user frames (`src/fingerprint/normalize/stack.js`), so the
  *origin* of a failure (not just its message shape) is part of its
  identity — two different call sites producing textually identical
  messages still fingerprint differently.
- **8-category classifier registry with a deferred dependency override**
  (`src/fingerprint/classify/`): an ordered list of pure, never-throwing
  classifiers (`validation`, `timeout`, `network`, `auth`, `dependency`,
  `serialization`, `internal` catch-all, plus `unknown` as
  `runClassifiers()`'s own defensive fallback) gives each failure a
  low-cardinality category from its `name`/`code`/`status`/`message`
  shape alone. `dependency` classification from stack-frame origin (top
  frame under `node_modules/`) is deliberately *not* done inside the
  `dependency` classifier itself — the classifier only sees the raw error,
  not the normalized stack, which is computed later in the pipeline.
  Instead, `computeFingerprint()` (`compose.js`) applies it as a
  post-classification override, and only when the classifier stage found
  no signal at all (`category === "internal"`) — a classifier that
  positively matched something more specific (e.g. `timeout`) always wins,
  since a real signal from the error's own shape is stronger evidence than
  "which package's code happened to be on top of the stack."
- **`METRIC_SAFE_ATTRIBUTES` as a structural cardinality guardrail**
  (`src/fingerprint/attributes.js`): rather than trusting every call site
  to remember which of the five `mcp.failure.*` attributes are safe to put
  on a metric label, the safe subset (`category`, `origin` — a closed
  8 × 3 = 24-combination space) is exported as its own frozen array,
  and `src/metrics.js` only ever reads `ATTRIBUTE_KEYS.CATEGORY` off it by
  name, never `fingerprint`/`signature`/`error_class` (unbounded or
  medium-cardinality — span-only). The guardrail is enforced by what the
  metrics code imports and calls, not by a runtime cardinality check.

## Alternatives rejected

- **xxhash / murmurhash for the fingerprint hash.** Faster than SHA-256,
  but both require a new runtime dependency (most non-cryptographic hash
  libraries for Node are native addons or WASM), which this feature — and
  this package as a whole (ADR 005's "no new dependencies without
  discussion") — avoids. SHA-256 via Node's built-in `crypto` module is
  fast enough at this input size (low single-digit microseconds) that the
  speed difference isn't worth the dependency.
- **SHA-1.** Marginally faster than SHA-256 with no measurable difference
  at these input sizes, and using it in a new 2026 feature invites a
  "why SHA-1" code-review question this package doesn't need to answer,
  for a security property (collision resistance) this hash doesn't
  actually rely on anyway. SHA-256 sidesteps the optics for free.
- **Naive `sha256(rawMessage)` fingerprinting.** Rejected per the Context
  section above — collapses to per-occurrence rather than per-cause
  granularity because of embedded dynamic values, making it useless for
  the grouping problem this feature exists to solve.
- **Server-side/hosted grouping rules (Sentry-style fingerprinting
  rules).** Rejected per the Context section above — requires network
  I/O, credentials, and third-party infrastructure in what is meant to
  stay a synchronous, local, one-line `instrumentMcpServer()` call.

## Consequences

- **Line-number sensitivity is a known, accepted limitation.** The stack
  signature includes line numbers (`fn@file:line`), so a pure refactor
  that shifts line numbers without changing behavior — reformatting,
  adding a comment, moving a function a few lines — changes the
  fingerprint even though the underlying bug didn't change. This is
  mitigated, not eliminated, by `category` grouping: dashboards/alerts
  built primarily on `mcp.failure.category` (metric-safe, per
  `METRIC_SAFE_ATTRIBUTES` above) stay stable across such refactors even
  when the finer-grained `mcp.failure.fingerprint` (span-only) churns. A
  fingerprinting scheme insensitive to line numbers (e.g. hashing only
  function names, or a fuzzy/AST-based stack comparison) was considered
  out of scope for this pass — it trades false-collapsing risk (two
  genuinely different bugs in the same function looking identical) for
  refactor-stability, and that tradeoff deserves its own design pass
  rather than a default baked in on day one.
- **Cardinality on metrics is bounded structurally, not by convention.**
  Because `src/metrics.js` can only reach `mcp.failure.category` through
  `METRIC_SAFE_ATTRIBUTES`/`ATTRIBUTE_KEYS.CATEGORY`, there is no code
  path today that could accidentally attach `mcp.failure.fingerprint` (or
  `signature`/`error_class`) to a counter or histogram label and quietly
  blow up a metrics backend's series cardinality. Extending the metrics
  integration in the future (e.g. a per-fingerprint counter) would need a
  deliberate, reviewed change to `METRIC_SAFE_ATTRIBUTES` or a parallel
  high-cardinality-aware mechanism, not just a call-site edit.
- **`fingerprinting: true` is the default** (`src/config.js`), consistent
  with `enableMetrics`'s existing opt-out-not-opt-in stance (ADR 005):
  `computeFingerprint()` is guaranteed never to throw (single top-level
  try/catch, `FALLBACK` result on any internal failure), so enabling it by
  default trades a small, bounded amount of per-failure CPU for the
  grouping signal, with no new failure mode for host applications to
  guard against.
- Failure clustering, regression detection, and cross-span root-cause
  chaining that *consume* these fingerprints are explicitly out of scope
  here and tracked in the README roadmap (v0.5+) — this ADR covers only
  how a single failure gets a stable identity, not what's built on top of
  it.
