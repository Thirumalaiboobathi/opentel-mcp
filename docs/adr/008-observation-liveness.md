# ADR 008: Observation liveness

**Status:** Accepted, implementation deferred to a future release. The
investigation and design below (the four-state contract, the top-level
accessor) are accepted as the right direction; no code has been written
against it yet. This ADR answers the question `docs/known-gaps.md`'s
"Observation liveness contract" entry left open: can opentel-mcp detect
that its observation path is unbound or no-op, without coupling to
unstable `@opentelemetry` SDK internals? The honest answer the
investigation below reached — only failure mode (a) is detectable, and
only for tracing, via a mechanism fragile enough on two independent axes
that a fourth, low-confidence state is required — is itself a reason to
defer: implementing a narrow, fragile capability is a real decision with
real tradeoffs (see Consequences), not a mechanical follow-up. Nothing in
`src/` has changed as a result of this document.
`test/thrash/observation-liveness.test.js` remains `describe.skip` — this
ADR does not turn it on; whenever implementation happens, it needs a
rewrite (see Consequences), not just an unskip, since it speculatively
encoded a different contract than the one accepted here.

## Context

`instrumentMcpServer()` with no `TracerProvider`/`MeterProvider`
registered globally silently no-ops: `@opentelemetry/api` hands back its
default no-op implementations, spans and metrics are dropped, and
nothing throws or warns. A tool call that returns `isError: true` in
that state is indistinguishable, from outside the process, from a tool
that never failed — both produce zero recorded telemetry. This gap was
raised in external review (Massimiliano Brighindi) and is tracked in
`docs/known-gaps.md`.

This investigation checked, against the actually-installed
`@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-trace@2.9.0`, and
`@opentelemetry/core@2.9.0` (not assumed), whether a reliable,
stable-public-API-only signal exists for three distinct failure modes:

- **(a) no provider registered at all**
- **(b) a real provider whose exporter is failing or unreachable**
- **(c) a real provider whose queue is dropping spans**

### Finding: (a) is partially detectable; (b) and (c) are not, without unsafe or internal means

**Trace** (`api/trace.js:47-49`): `trace.getTracerProvider()` always
returns a `ProxyTracerProvider` — a class that **is** exported publicly,
but is marked `@deprecated` in its own docblock and carries a `// TODO:
Remove ... in the next major version` comment at its export site. Its
public `getDelegate()` method returns `this._delegate ?? NOOP_TRACER_PROVIDER`,
where `NOOP_TRACER_PROVIDER` is a module-scoped singleton — `NoopTracerProvider`
itself is not exported. A reference-equality trick
(`provider.getDelegate() === new ProxyTracerProvider().getDelegate()`)
can detect "no delegate set" using only exported symbols, but it carries
two independent, compounding fragilities confirmed by reading the
source: (1) it leans on a class the API's own maintainers have announced
they intend to remove, and (2) the comparison singleton is a plain
per-module `const`, not registered via the `globalThis`-keyed mechanism
(`Symbol.for('opentelemetry.js.api.<major>')`, `internal/global-utils.js`)
this same API otherwise uses specifically to survive multiple installed
copies of itself — meaning the trick is *itself* susceptible to the
dual-package-hazard class of bug this project already guards against
elsewhere (ADR 001's `detectServerKind()`), and can silently misfire in
either direction under module duplication, with no way to tell that it
has.

**Metrics** (`api/metrics.js:29-31`): `metrics.getMeterProvider()`
returns the raw `NOOP_METER_PROVIDER` singleton with **no Proxy wrapper
at all** — `setGlobalMeterProvider()` registers the incoming provider
directly, unlike trace's proxy-based indirection. Neither the class nor
the singleton is exported. There is no `ProxyMeterProvider` equivalent.
**No public-API path of any kind exists to detect an absent MeterProvider.**

**`span.isRecording()` is not a usable proxy for any of this.** A
`NonRecordingSpan.isRecording()` (the no-op case) hardcodes `false` —
but `@opentelemetry/sdk-trace`'s real `Tracer.startSpan()`
(`Tracer.js:74-86`) returns the exact same `NonRecordingSpan` class
whenever its configured `Sampler` decides `NOT_RECORD`, which is normal,
intentional, healthy behavior for any ratio-based or parent-based
sampler in ordinary production use. `false` is genuinely ambiguous
between "nothing is registered" and "a real, correctly-configured
provider chose not to sample this span."

**Modes (b) and (c) have no safe, stable, public-API path at all.**
`ExportResult`/`ExportResultCode` (`@opentelemetry/core`) is a real,
well-designed status type, but it is delivered only to the
`resultCallback` of whoever constructs and calls the `SpanExporter`
directly — the `SpanProcessor` itself, never arbitrary third-party code.
The only signals reachable from outside that construction — `diag`
(`diag.setLogger()`) and `ErrorHandler`
(`setGlobalErrorHandler`/`globalErrorHandler`, `@opentelemetry/core`,
confirmed call sites in `BatchSpanProcessorBase.js` and
`sdk-metrics`'s `PeriodicExportingMetricReader.js`) — are both **single
global slots**. Registering opentel-mcp's own handler on either would
silently replace whatever the host application (or another
instrumentation library sharing the process) already registered;
`setGlobalErrorHandler` does this with **no warning at all**, unlike
`diag.setLogger` which at least logs one. This project's own established
principle (ADR 001: never override a host application's own OpenTelemetry
setup) rules this out as an acceptable mechanism.

One genuinely new, real finding for mode (c) specifically: `@opentelemetry/sdk-trace`
2.x ships spec-defined SDK self-observability metrics
(`export/SpanProcessorMetrics.js`) — `otel.sdk.processor.span.processed`
(tagged `error.type: queue_full` when the queue drops spans) and queue
size/capacity gauges. This is real, public, and "designed for this" —
but it requires an explicit `selfObsMeterProvider` option passed to
`BatchSpanProcessor`'s constructor (`BatchSpanProcessorBase.js:36-38`;
silently defaults to a no-op meter if omitted), which only the code that
*constructs* the processor can supply. opentel-mcp's own
`setupNodeSdk: true` path constructs its own `BatchSpanProcessor`
without this option today, so it doesn't currently benefit even there —
and for the default `setupNodeSdk: false` path, the host owns processor
construction entirely, putting this fully outside opentel-mcp's reach.

**Conclusion carried into the Decision below: only mode (a) is
detectable, only on the trace side, only via a fragile mechanism, and
even that detection cannot be made fully reliable.** Modes (b) and (c)
require either unstable internals or claiming a global hook this
project has already, elsewhere, ruled out overriding. This is the
result of the investigation, not a dead end to route around.

## Decision

### The contract: four states, not three

The originally speculated three states — `OBSERVED_CLEAN` |
`OBSERVED_FAILING` | `OBSERVATION_UNAVAILABLE` (the provisional names in
`test/thrash/observation-liveness.test.js`, itself using still-earlier
provisional names `'healthy' | 'unavailable' | 'unknown'`) — need a
fourth: **`LIVENESS_INDETERMINATE`**, never confidently exercised as any
of the other three. Given the compounding fragility of the only
detection mechanism this investigation found (a deprecated class, plus
a dual-package-hazard-prone singleton comparison), the contract must
have a defined behavior for "our own detection mechanism didn't produce
a trustworthy answer" — collapsing that into `OBSERVATION_UNAVAILABLE`
would misreport "a provider is definitely absent" when the true
situation is "we don't know," which is exactly the kind of overclaiming
this investigation was asked to avoid. This mirrors
`classifyFailureChannel()`'s own `'unknown'` value (ADR 007) and the
same never-guess discipline established there.

Given the findings above, what each state can actually mean:

- **`OBSERVATION_UNAVAILABLE`** — the trace-provider-absence check (the
  `ProxyTracerProvider` reference-equality trick) confidently resolved
  to "no delegate set." Says nothing about `MeterProvider` state,
  exporter health, or queue health — it cannot, per the findings above.
- **`OBSERVED_CLEAN`** — the trace-provider-absence check did *not*
  detect absence (some delegate appears set), **and** this library's own
  always-accurate in-process bookkeeping (fingerprinting/thrash
  counters, which run identically regardless of OTel registration —
  see `src/thrash/detector.js`'s docblock) shows zero recorded failures.
- **`OBSERVED_FAILING`** — same provider check, but bookkeeping shows at
  least one recorded failure.
- **`LIVENESS_INDETERMINATE`** — the detection mechanism itself could
  not run confidently (e.g. a future `@opentelemetry/api` major version
  removes `ProxyTracerProvider` or changes its shape; or the equality
  check's own preconditions look violated in a way suggesting module
  duplication). This is the fallback default, not a rare edge case —
  given the mechanism's fragility, implementations should expect to hit
  it in real deployments and must not treat it as equivalent to either
  confident state.

**A `MeterProvider`-only absence is invisible to this contract entirely**,
by the findings above — there is no state that means "tracing is fine
but metrics has nothing registered." Naming that gap explicitly rather
than silently folding it into one of the four states above is part of
this ADR's honesty requirement.

### Where it lives: a top-level accessor, not a `ThrashSummary` field

`test/thrash/observation-liveness.test.js` speculatively put this on
`ThrashSummary` (`summary.observation`). That's wrong, and this ADR
corrects it:

**Argument for `ThrashSummary`:** it's already there; `getThrashSummary()`
callers get it without an additional call; matches the original
speculative test's naming, minimizing churn.

**Argument for a top-level accessor:** observation liveness is a
property of the *entire* instrumentation path — spans, metrics, cost
tracking, and fingerprinting all ride on the same `TracerProvider`/
`MeterProvider` registration `wrapToolCallHandler` reads from. It is not
specific to thrash detection, and treating it as a `ThrashSummary` field
produces at least one concrete wrong behavior: `getThrashSummary()`
already returns an all-zero summary when `thrashDetection.enabled` is
`false` (`src/thrash/detector.js`'s `zeroSummary()`) — a consumer who
disabled thrash detection but still wants to know "is my telemetry
pipeline alive" would get a meaningless answer, or none, entirely
because of an unrelated feature flag. A consumer who only uses
fingerprinting or cost tracking, and never calls `getThrashSummary()` at
all, has no reason to reach for a thrash-shaped return value to answer a
question that has nothing to do with thrash detection.

**Decision: a top-level accessor**, e.g. `getObservationLiveness()`,
attached to the object `instrumentMcpServer()` returns the same way
`shutdown()`/`getThrashSummary()` already are — unconditionally (not
gated behind `setupNodeSdk`, since the question "is a provider
registered" is meaningful whether or not opentel-mcp set one up itself),
but, like `getThrashSummary()`, never attached when `options.enabled` is
`false` (nothing is instrumented at all in that case, so the question
doesn't apply).

## Constraints accepted

- The only detection mechanism found depends on a class
  (`ProxyTracerProvider`) `@opentelemetry/api`'s own maintainers have
  announced for removal in the next major version. A future
  `@opentelemetry/api` major bump could silently remove the only lever
  this contract has — the mandatory `LIVENESS_INDETERMINATE` fallback
  exists specifically so that removal degrades to "we don't know," not
  to a wrong confident answer or a thrown error.
- The same mechanism is independently fragile under module duplication
  (dual-package hazard) — a scenario this project already takes
  seriously elsewhere (ADR 001) but cannot fully rule out here, since
  the fragile singleton comparison doesn't go through the
  `globalThis`-keyed registration that would otherwise survive it.
- `MeterProvider` absence is not detectable via any public mechanism
  found in this investigation. The contract is trace-only by necessity,
  not by choice, and must say so wherever it's documented (README,
  `.d.ts` doc comments), not just in this ADR.
- Modes (b) (exporter failing) and (c) (queue dropping) are not covered
  by this contract at all. The one real lead for (c) — SDK
  self-observability metrics via `selfObsMeterProvider` — only helps
  when opentel-mcp itself constructs the `SpanProcessor`
  (`setupNodeSdk: true`), is not wired up today even there, and remains
  out of reach entirely for the default `setupNodeSdk: false` path where
  the host owns the provider. A future ADR could scope a much narrower
  `setupNodeSdk: true`-only enhancement using it; this ADR does not
  attempt that.

## Alternatives rejected

- **Claiming `setGlobalErrorHandler()` or `diag.setLogger()` to observe
  export failures.** Rejected — both are single global slots; installing
  opentel-mcp's own handler risks silently replacing whatever the host
  application or another library already registered, violating this
  project's own "never override the host's OTel setup" principle (ADR
  001), for `setGlobalErrorHandler` with no warning of the override at
  all.
- **Deep-importing `NoopTracerProvider`/`NoopMeterProvider` from
  `@opentelemetry/api`'s internal build paths.** Rejected on its face —
  this is exactly the "coupling to unstable SDK internals" the
  investigating question asked to avoid, and both classes live at
  version-specific internal paths with no stability guarantee at all.
- **Folding the fourth state into `OBSERVATION_UNAVAILABLE`.** Rejected
  — collapses "confirmed absent" and "couldn't tell" into the same
  reported value, which is precisely the overclaiming this
  investigation was asked to avoid producing.
- **Putting this on `ThrashSummary`.** Rejected — see "Where it lives"
  above; couples a general instrumentation-health question to an
  unrelated feature's enabled/disabled state.

## Consequences

- If implemented, this ships a narrow, honestly-scoped capability:
  "can we tell if tracing has nothing registered," not "is telemetry
  healthy." Any README/`.d.ts` documentation must lead with that scope
  limit, not bury it — mirroring how ADR 007's `mcp.failure.channel`
  documentation leads with what it does and doesn't cover for `McpServer`
  users.
- `test/thrash/observation-liveness.test.js` needs a rewrite, not just an
  unskip, if this ADR is later implemented: its speculative
  `summary.observation` field and three-value set (`'healthy' |
  'unavailable' | 'unknown'`) are superseded by a top-level accessor
  and the four-state contract above.
- Given the compounding fragility documented here, an implementation
  should treat this feature as genuinely best-effort and expect
  `LIVENESS_INDETERMINATE` to appear in real deployments, not just in
  theory — it is not a rare defensive branch, it is an honest,
  frequently-reachable outcome of how fragile the only available
  detection mechanism is.
- This ADR does not decide whether the capability is worth shipping at
  all given how narrow it ends up being (trace-only, one failure mode,
  fragile detection). That call is left open for whoever picks up
  `docs/known-gaps.md`'s "Observation liveness contract" entry, now with
  this investigation's findings to decide from instead of an open
  question.
