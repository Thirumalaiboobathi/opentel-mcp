# ADR 008: Observation liveness

**Status:** Superseded by the "Update (2026-08-05)" section at the end of
this document — external review (Massimiliano Brighindi, who also raised
the original gap this ADR investigates) reframed the requirement from
"detect a broken observation pipeline" to "stop implying health by
omission," which splits the single four-state contract below into two
independent fields. The original investigation and its four-state
contract are kept below as the historical record the update builds on and
corrects — do not implement the four-state contract as originally
written; see the Update section for the current design. Implementation
is still deferred to a future release.

**Original status (superseded):** Accepted, implementation deferred to a future release. The
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

## Update (2026-08-05): The two-axis reframe

Third of three investigations scoped for v0.8.0. **This section
supersedes the four-state contract above.** Credit to Massimiliano
Brighindi, who raised the original gap this ADR investigates, for also
supplying the reframe: the requirement was never to *detect* a broken
observation pipeline (the four-state contract above, in trying to do
that, still ended up implying more confidence than the evidence
supports — see Finding 1 below) — it is to *stop implying health by
omission*. That reframe splits one combined enum into two independent
fields:

```
ToolOutcome:          SUCCESS | FAILURE | UNKNOWN
ObservationIntegrity: DEGRADED | UNKNOWN   (see Finding 1 — HEALTHY dropped)
```

Both default to `UNKNOWN`; either only moves off it on positive
evidence. Every mechanism below was re-verified against the currently
installed `@opentelemetry/api@1.9.1` / `@opentelemetry/sdk-trace@2.9.0`
(unchanged since the original investigation above), not assumed to still
hold.

### Finding 1 — HEALTHY can never be positively attested, in either provider configuration

The original investigation above found mode (a) (no provider at all)
partially detectable and modes (b)/(c) (exporter failing, queue
dropping) undetectable "without unsafe or internal means." Re-checked
directly against the installed SDK, the conclusion is sharper than that:
**there is no configuration in which this library's own code can
positively confirm telemetry is flowing.**

- **Host-owned provider (`setupNodeSdk: false`, the default):** unchanged
  from the original finding — `trace.getTracerProvider()`
  (`TraceAPI.getTracerProvider()`, `api/trace.js:51-53`) and
  `metrics.getMeterProvider()` (`MetricsAPI.getMeterProvider()`,
  `api/metrics.js:32-34`) give no access to exporter or queue health at
  all.
- **Self-owned provider (`setupNodeSdk: true`):** the one lead the
  original investigation found — SDK self-observability metrics
  (`otel.sdk.processor.span.processed`, `SpanProcessorMetrics.js:25`,
  tagged `error.type: queue_full` on drop at `SpanProcessorMetrics.js:44`)
  — is real, and still requires an explicit `selfObsMeterProvider` this
  library doesn't pass today (`instrument.js:274-277` constructs
  `NodeTracerProvider` with no such option). **But there is a harder
  blocker the original investigation didn't state as plainly: even if
  wired up, this metric could never be read back by the code that
  created it.** The OTel Metrics API's `Counter` interface has exactly
  one method — `add(value, attributes?, context?): void`
  (`@opentelemetry/api`'s `Metric.d.ts`, the complete interface, no
  `getValue()` or any synchronous read-back). A `Counter` can only be
  written to by instrumented code and read by a `MetricReader` on its own
  export schedule. This metric is real and useful to an **external**
  system (a Collector, a Prometheus scrape) consuming the exported
  stream — it can never become something `instrumentMcpServer()`'s own
  synchronous accessor reads and turns into a verdict, no matter how it's
  wired up.

**HEALTHY is not merely hard to reach today — it is structurally
unreachable in both configurations, by anything this library's own code
could ever do.** Applying this ADR's own "a three-value enum where one
value is unreachable should be a two-value enum" standard, `HEALTHY` is
dropped from `ObservationIntegrity` entirely. (Considered and rejected: a
host-supplied "I confirm telemetry is flowing" callback the library just
trusts. That's not attestation, independent verification, or detection —
it's a pass-through of the host's own claim, answering a different
question than the one this contract exists to answer.)

### Finding 2 — DEGRADED is reachable, but only in the configuration you'd expect it least

Re-checking the original `ProxyTracerProvider` reference-equality trick
(`ProxyTracerProvider.getDelegate()` returning `this._delegate ??
NOOP_TRACER_PROVIDER`, a module-scoped, unexported singleton —
`ProxyTracerProvider.js`) against the installed API: it still works,
with the same fragility already documented above (deprecated class,
dual-package-hazard-prone). Confirming "no delegate set" is genuine
positive evidence — of an absence, not a presence, but a confidently
confirmed fact either way, which is exactly what `DEGRADED` should mean.
**This makes `DEGRADED` reachable — not aspirational — but only for
`setupNodeSdk: false`.**

For `setupNodeSdk: true`, this same trigger can **never** fire:
`instrumentMcpServer()` calls `provider.register()` itself
(`instrument.js:278`) — it knows, with certainty, not by inference, that
a delegate is registered. There is nothing left to "detect." (Considered
and rejected as a substitute trigger for this path: "no `exporterUrl`
configured, so spans only reach stderr." That's `StderrSpanExporter`'s
own documented, intentional default behavior — ADR 003 — not evidence of
anything broken, and flagging it as `DEGRADED` would itself be a form of
overclaiming this update exists to avoid.)

So the two provider configurations are asymmetric in *opposite*
directions: `setupNodeSdk: true` can never show `DEGRADED` (a delegate is
always known-present) but also never shows `HEALTHY` (per Finding 1);
`setupNodeSdk: false` can show `DEGRADED` (fragile absence-detection) but
also never `HEALTHY`. Either way, `UNKNOWN` is what most deployments will
see most of the time — an honest disclaimer, not a signal, exactly as
this investigation was asked to confirm plainly rather than dress up as
detection. One additional correction this reframe surfaces: the original
contract's `OBSERVED_CLEAN` state (absence-check inconclusive + zero
bookkept failures) was itself already a mild instance of "implying
health" — "we didn't confirm it's broken" quietly stood in for "it's
fine," a double-negative, not positive evidence. The two-axis split
retires that framing along with the rest of the four-state contract.

### Finding 3 — `ToolOutcome` needs its own counter, decoupled from fingerprinting/thrash config

`ToolOutcome` answers a cumulative, since-instrumentation question — has
this server ever recorded a tool failure — analogous to the original
contract's `OBSERVED_CLEAN`/`OBSERVED_FAILING` split, now decoupled from
provider-liveness entirely. The obvious implementation — read it off
`ThrashDetector`'s existing bookkeeping (`getThrashSummary()`) — is
wrong: `applyThrashDetection()` only records anything when a fingerprint
was computed (`instrument.js:544`, guarded on `fingerprintingEnabled` at
`instrument.js:721`), so with `fingerprinting: false` — a fully
supported, documented configuration, not an edge case — `getThrashSummary()`
would report zero failures regardless of how many actually occurred.
That's the exact silent-success failure mode this whole feature exists
to close, just relocated into the fix. `ToolOutcome` needs a new, small,
always-on counter, independent of `fingerprinting`/`thrashDetection`
config, updated from the same unconditional `isToolResultError(result)` /
catch-block check `wrapToolCallHandler` already runs on every call
(`instrument.js:302-304,714,785`) regardless of any feature flag — not a
read of state any config option can turn off. `UNKNOWN` is reserved for
the (currently nonexistent, since this counter doesn't exist yet) case
where even that bookkeeping mechanism itself couldn't run.

### Finding 4 — still a top-level accessor, now for a stronger reason

The original "Where it lives" reasoning holds and is reinforced by
Finding 3: `ThrashSummary` already returns an all-zero summary when
`thrashDetection.enabled` is `false`, and Finding 3 shows a naive
`ToolOutcome` implementation would inherit that exact contamination from
an unrelated feature flag. A consumer using only cost tracking or only
fingerprinting, who never touches thrash detection, has no reason to
reach through a thrash-shaped return value for a question that has
nothing to do with thrash. **Decision unchanged: a top-level accessor**,
named `getObservationState()` (superseding the original's speculative
`getObservationLiveness()`, since the return shape changed from one
four-state field to two independent ones) returning `{ toolOutcome,
observationIntegrity }`, attached the same way `shutdown()` /
`getThrashSummary()` already are — unconditional, omitted only when
`options.enabled` is `false`. `observationIntegrity` is re-evaluated on
every call (the `ProxyTracerProvider` check is cheap — object
construction plus a reference comparison — and "is a provider registered"
can change over a long-lived process's life if the host registers one
asynchronously after `instrumentMcpServer()` already ran); `toolOutcome`
reads the new counter from Finding 3.

### Finding 5 — `ToolOutcome` deliberately duplicates span status; that's the point, not a flaw

`span.setStatus({code: SpanStatusCode.OK})` / `SpanStatusCode.ERROR`
(`instrument.js:716,777,787`) and the metric-only `mcp.tool.outcome`
attribute (`ATTR_MCP_TOOL_OUTCOME` — success/error/silent_failure, set
only on the `mcp.tool.duration` histogram, `metrics.js:119-125`, never as
a span attribute) already carry this exact information today.
`ToolOutcome`'s `SUCCESS`/`FAILURE` value space is not new semantic
content — it is a direct restatement of what the span and the metric
already express. What's actually new is the delivery path: span status
and the metric attribute are both OTel signals, which are exactly what
might not be trustworthy when `observationIntegrity` isn't `DEGRADED`-
confirmed-fine (which, per Finding 1, is never, since `DEGRADED` only
ever confirms absence, not presence). `ToolOutcome` has to duplicate the
span's information through an OTel-independent path — the same
"you can't ask a span whether spans are working" principle the original
investigation already established — precisely so it stays trustworthy in
the scenario the span-based signal might not be. If it didn't duplicate
the span, it would be useless for the one job it exists to do.

### Decision

- `ObservationIntegrity`: **`DEGRADED | UNKNOWN`** (two values — `HEALTHY`
  dropped per Finding 1).
- `ToolOutcome`: **`SUCCESS | FAILURE | UNKNOWN`**, backed by a new,
  always-on, config-independent counter (Finding 3) — not a read of
  `ThrashDetector` state.
- Lives on a new top-level accessor, `getObservationState()`, replacing
  the original's `getObservationLiveness()` (Finding 4).
- `ToolOutcome` intentionally duplicates span status / the
  `mcp.tool.outcome` metric attribute (Finding 5) — flagged explicitly in
  any implementation's documentation as deliberate redundancy, not an
  oversight or a third source of truth to reconcile.
- The original four-state contract (`OBSERVED_CLEAN` /
  `OBSERVED_FAILING` / `OBSERVATION_UNAVAILABLE` /
  `LIVENESS_INDETERMINATE`) is retired. `LIVENESS_INDETERMINATE`'s job —
  a safe fallback for "the detection mechanism itself didn't run
  confidently" — falls out for free as `UNKNOWN`'s default status in the
  two-axis design, rather than needing a dedicated fourth value; this is
  a genuine simplification the split produces, not just a rename.
- `test/thrash/observation-liveness.test.js` (the original speculative
  test, `summary.observation` / `'healthy' | 'unavailable' | 'unknown'`)
  is now doubly superseded — first by the original ADR's top-level-
  accessor decision, now again by this two-axis split — and is left
  as-is (still `describe.skip`, still documenting its own provisional
  status) rather than rewritten, since nothing here changes its function
  as a historical record of the first framing. A new test,
  `test/thrash/observation-integrity.test.js`, specs the two-axis
  contract's more realistic failure mode — a provider genuinely
  registered, but its export path deliberately broken — under the same
  `describe.skip` discipline.
- This section does not decide whether to implement any of this now —
  same as the original ADR, that call is left to whoever picks up
  `docs/known-gaps.md`'s entry, now with a corrected, honestly-scoped
  contract to implement against instead of the original four-state one.
