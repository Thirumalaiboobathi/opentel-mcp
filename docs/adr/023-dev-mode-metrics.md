# ADR 023: Dev-mode metrics under `setupNodeSdk: true`

**Status:** Proposed — design only, no implementation.

**Amends:** ADR 005 (`docs/adr/005-metrics-api-only.md`), whose "Alternatives
rejected" section already anticipated this exact reconsideration: *"Bundle
a default `MeterProvider` + OTLP metric exporter, mirroring `setupNodeSdk:
true` for tracing... Revisit if there's demand for a metrics equivalent of
the dev-friendly `setupNodeSdk` mode."* That demand is this release's own
audit finding (v0.15.0, "Make it visible"): a user following the README's
"30-second quickstart" with `setupNodeSdk: true` gets stderr spans and
**zero** of the 12 `mcp.tool.*`/`mcp.tool.loop.*`/`mcp.tool.schema_drift.*`
metrics — the exact signals (silent-failure rate, thrash episodes, cost
totals) the README leads with. ADR 005's own reasoning for API-only stays
correct and unchanged for the *production* path (`setupNodeSdk: false`);
this ADR scopes a dev-mode-only exception, the same way ADR 003 scoped
`StderrSpanExporter` as a dev-mode-only exception to `ConsoleSpanExporter`.

## Context

### What `setupNodeSdk: true` does today

`setupTracer()` (`src/instrument.js`, called at line 393, **before**
`setupMeter()` at line 394):

1. Builds `spanProcessors`: always `SimpleSpanProcessor(new StderrSpanExporter())`
   (ADR 003); additionally `BatchSpanProcessor(new OTLPTraceExporter({ url:
   resolved.exporterUrl }))` when `exporterUrl` is set.
2. Constructs a `NodeTracerProvider` with those processors and a `Resource`
   built from `resourceFromAttributes({ 'service.name': resolved.serviceName, ...pricingResourceAttributes })`
   (the latter only when cost tracking is on and using `DEFAULT_PRICING` —
   ADR 016 point 3).
3. Calls `provider.register()` — sets the **global** `TracerProvider`.
4. Attaches `server.shutdown = () => provider.shutdown()`.
5. Unconditionally (regardless of `setupNodeSdk`) returns `trace.getTracer('opentel-mcp', PACKAGE_VERSION)`.

Metrics get none of this: `setupMeter()` (`src/metrics.js`) only ever calls
`metrics.getMeter()` against whatever is globally registered — nothing,
under the documented quickstart.

### The ordering already works in our favor

Tracing survives being set up before the host's own code runs because
`@opentelemetry/api`'s tracing API hands back a `ProxyTracer` that
delegates *lazily* — a tracer created before the real provider registers
still works once it does. Metrics has no such proxy (verified against the
installed `@opentelemetry/api`'s `.d.ts` and by direct test): `metrics.getMeter()`
resolves the current global **synchronously, at call time**; an instrument
bound to the no-op `Meter` stays bound to it forever. This is exactly why
ADR 005's own "Constraints accepted" flagged wrong call order as "a
sharper edge" for metrics than tracing.

This cuts the opposite way for *this* feature, though: because
`setupTracer()` already runs at line 393, strictly before `setupMeter()`
at line 394, a dev-mode `MeterProvider` registered inside (or immediately
alongside) `setupTracer()`'s existing work is **already registered by the
time `setupMeter()` calls `metrics.getMeter()`** in the same
`instrumentMcpServer()` call. No new ordering problem to solve — the
existing call order already does the right thing.

### What's already a dependency vs. a devDependency

- `@opentelemetry/sdk-metrics` is currently a **devDependency only**
  (ADR 005), used solely by `test/metrics.test.js`'s in-memory reader.
- `@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http`
  are already **real** dependencies — specifically *because* `setupNodeSdk:
  true`'s dev tracing path needs them. There is already precedent for this
  exact flag carrying real OTel SDK dependencies that the production
  (`setupNodeSdk: false`) path never touches.
- Promoting `@opentelemetry/sdk-metrics` to a real dependency costs **zero
  new transitive packages**: its own two dependencies,
  `@opentelemetry/core` and `@opentelemetry/resources`, are already in the
  tree — `resources` is already a direct dependency of this package, and
  `core` is already pulled in transitively by `sdk-trace-node`. Published
  size is ~1.8MB unpacked (`npm view @opentelemetry/sdk-metrics dist.unpackedSize`).
- Peer-range check: `@opentelemetry/sdk-metrics@2.11.0` peers
  `@opentelemetry/api` at `>=1.9.0 <1.10.0`. That exact `<1.10.0` ceiling
  **already exists today** on three packages already depended on for real
  (`sdk-trace-node`, `sdk-trace-base`, `resources`) — confirmed by reading
  each one's own `package.json`. Adding `sdk-metrics` introduces no new
  category of peer-range risk, only one more package sharing a constraint
  this library already ships with.

### Pre-existing global `MeterProvider`

Verified empirically (`metrics.setGlobalMeterProvider()` called twice in a
throwaway script): the **documented, public** return type is `boolean`
(confirmed in `@opentelemetry/api`'s own `.d.ts`, not an internal detail) —
`false` means a global was already registered, and the *original*
provider stays active; nothing is overridden, no exception is thrown. The
API's own internal `diag.error()` on that path is silent by default (no
diag logger is registered unless the host explicitly calls
`diag.setLogger()`), the same visibility rule every existing `diag.warn`/
`diag.debug` call in this codebase already relies on (`config.js`'s
`warnedServiceNameIgnored`, `warnedPricingStale`).

### The stdout constraint, and why `ConsoleMetricExporter` can't be reused

Read directly from the installed source
(`@opentelemetry/sdk-metrics/build/src/export/ConsoleMetricExporter.js`):
its `_sendMetrics()` calls `console.dir({ descriptor, dataPointType,
dataPoints }, { depth: null })` **per metric** — stdout, and a full,
unflattened JSON dump of the internal data-point shape. Both wrong here:
ADR 003's stdout constraint applies identically to metrics (a
`StdioServerTransport` server's JSON-RPC stream must stay clean regardless
of which OTel signal is leaking into it), and a JSON firehose is not what
"readable by a human in a terminal" means.

### No existing process-exit hooks

Grepped this codebase: no `SIGINT`/`SIGTERM`/`beforeExit` handler exists
anywhere. `shutdown()` (tracing's, today) is always something the *host*
calls explicitly, during its own shutdown sequence — the README already
documents this. Metrics should follow the identical convention, not
introduce process-level signal handling this library has never done.

## Decision

### Trigger: `setupNodeSdk: true` itself — no new option

Dev-mode metrics activate under the **existing** `setupNodeSdk: true` flag,
gated additionally by the **existing** `enableMetrics` option (default
`true`) — no new public option is introduced. Reasoning:

- The quickstart this release is fixing already uses `setupNodeSdk: true`
  as its one dev-mode switch. A second flag for the same quickstart would
  recreate exactly the "one more thing to configure" friction this phase
  exists to remove.
- `enableMetrics: false` already exists as the documented opt-out for
  metrics specifically (independent of tracing) — reusing it here means a
  host who's already decided "no metrics from this library" via that flag
  continues to get exactly that, with zero new interaction to reason
  about.
- Symmetric with tracing's own `setupNodeSdk: true` → "this package owns a
  provider" pattern, rather than inventing an asymmetric rule for the
  sibling signal.

### Where it's wired: alongside `setupTracer()`, before `setupMeter()`

A new function, `setupDevMeterProvider()` (or folded into `setupTracer()`
directly — implementation detail, not a design question this ADR needs to
pre-decide), runs at the same point `setupTracer()` already runs — before
`setupMeter()` is called — so the ordering problem described above never
materializes. It:

1. Only runs when `resolved.setupNodeSdk && resolved.enableMetrics`.
2. Builds a `MeterProvider` (from `@opentelemetry/sdk-metrics`) with a
   `PeriodicExportingMetricReader` wrapping a new `StderrMetricExporter`
   (see below), using the **same** `Resource` construction `setupTracer()`
   already builds (`resourceFromAttributes({ 'service.name': ..., ...pricingResourceAttributes })`)
   — one resource, shared between the dev tracer and dev meter, so
   `service.name` (and the pricing-staleness resource attribute) can never
   drift between the two signals in dev mode.
3. Attempts `metrics.setGlobalMeterProvider(provider)`. If it returns
   `false` (a global was already registered — the pre-existing-provider
   case from Context above): **do not use the provider just built, and
   shut it down immediately** (fire-and-forget — `.shutdown().catch(() =>
   {})`, never awaited and never allowed to throw past this setup path).
   Shutdown is not optional cleanup here: `MeterProvider`'s constructor
   already starts its `PeriodicExportingMetricReader`'s interval timer as
   soon as the provider is built (confirmed by reading
   `@opentelemetry/sdk-metrics`' source — the timer starts from
   `onInitialized()`, called by the constructor, independent of whether
   the provider is ever registered anywhere) — an un-shut-down loser
   would otherwise tick forever, exporting an empty `ResourceMetrics` to a
   `StderrMetricExporter` nobody reads. Also emit a single,
   once-per-process `diag.warn` naming the situation (same pattern as
   `warnedServiceNameIgnored`/`warnedPricingStale` in `config.js`). The
   already-registered provider — whoever's it is — keeps being what
   `setupMeter()`'s subsequent `metrics.getMeter()` call resolves to,
   completely unmodified. This satisfies "must not override it" by
   construction: the attempt either succeeds (nothing else was registered)
   or is a complete no-op (something already was).
4. On success, extends `server.shutdown` to also shut down the
   `MeterProvider` (see "Shutdown" below) — not a second, separate method.

### Exporter: a new `StderrMetricExporter`, compact format, 5-second default interval

A new module, `src/exporters/stderr-metrics.js`, mirroring
`src/exporters/stderr.js`'s existing shape (small, hand-written, writes via
`console.error`, never `console.dir`) rather than reusing or wrapping
`ConsoleMetricExporter`. Implements the `PushMetricExporter` interface
(`export(metrics, resultCallback)`, `forceFlush()`, `shutdown()`).

**Format** — one line per instrument × attribute-set combination, not a
nested JSON dump:

```
[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=echo,mcp.method.name=tools/call} = 3
[opentel-mcp metrics] mcp.tool.silent_failures{gen_ai.tool.name=echo} = 1
[opentel-mcp metrics] mcp.tool.duration{gen_ai.tool.name=echo,mcp.tool.outcome=silent_failure} count=1 avg=12.4ms
```

Counters print their cumulative sum (`= <n>`); histograms print
`count=<n> avg=<sum/count><unit>` — average, not a full bucket dump, since
a terminal reader wants "how many, roughly how long," not a distribution.
Attribute keys/values render as a flat `{k=v,k=v}` suffix, sorted by key
for stable, diffable output across runs. Zero new span-attribute or
metric-label surface is introduced by this formatting — it only reads
values the existing 12 instruments (`src/metrics.js`, `src/thrash/emitter.js`,
`src/schema-drift/emitter.js`) already attach; `METRIC_SAFE_ATTRIBUTES`
governance is unaffected, since this exporter doesn't add attributes, it
prints the ones already there.

**Export interval: 5000ms**, not the SDK's own 60000ms default — a dev
quickstart user making a few tool calls and watching their terminal should
see output within a few seconds, not up to a minute later. Not currently
exposed as a configurable option (no new public surface); the
`PeriodicExportingMetricReader`'s own `exportIntervalMillis` is an
internal implementation constant for this release, same as
`StderrSpanExporter` having no configurable knobs today. Revisit if this
turns out to need tuning once real usage exists.

### Dependency strategy: promote to a real dependency, not a dynamic import

`@opentelemetry/sdk-metrics` moves from `devDependencies` to
`dependencies`. **Rejected: optional peer + dynamic import with graceful
fallback.** That pattern exists elsewhere in this codebase for a genuinely
different situation — `@modelcontextprotocol/sdk`/`@modelcontextprotocol/server`
are optional because a given host only ever uses ONE of the two MCP SDKs,
so importing the other unconditionally would break every installation of
the one they don't use (ADR 015). There is no equivalent "only some hosts
want this" split here: every `setupNodeSdk: true` user already receives
`@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http`
as hard, always-installed dependencies for the identical flag, today, with
no fallback path for "what if sdk-trace-node is missing" — nobody asks
that question because it's a real dependency. Treating `sdk-metrics`
differently, for the same flag, would be a new, unjustified asymmetry
between the two OTel signals this one flag already controls, purchased
only to guard against a scenario (a consumer who deliberately strips a
production dependency from `node_modules`) this library has never
accommodated for its sibling signal.

### Behavior when a global `MeterProvider` already exists

Covered above (Decision point 3): detected via `setGlobalMeterProvider()`'s
own documented `boolean` return, not by inspecting internals or guessing
from a class name. No override, no throw, one `diag.warn` per process.

### Shutdown

`server.shutdown` (attached only when `setupNodeSdk: true`, unchanged)
becomes:

```js
server.shutdown = async () => {
  await provider.shutdown(); // tracing — unchanged
  if (meterProvider) await meterProvider.shutdown(); // new — only when our dev MeterProvider was actually registered
};
```

`MeterProvider.shutdown()` cascades to its `PeriodicExportingMetricReader`,
which performs a final collect-and-export before clearing its interval
timer — confirmed by reading `PeriodicExportingMetricReader`'s source
(`onShutdown()`), not assumed. No new process-level signal handling is
added (no `SIGINT`/`SIGTERM`/`beforeExit`) — consistent with this
library's existing position that `shutdown()` is always something the
host calls explicitly, never something this library intercepts the
process lifecycle to call on the host's behalf.

### `setupNodeSdk: false` is completely unchanged

Every piece of this ADR is reachable **only** through code paths already
gated on `resolved.setupNodeSdk === true`. When `setupNodeSdk` is `false`
(the default, and the documented production posture): `setupTracer()`'s
existing early return already skips every line this ADR adds to; no
`MeterProvider` is constructed, no `metrics.setGlobalMeterProvider()` call
is attempted, `@opentelemetry/sdk-metrics` is imported nowhere on that
path. `setupMeter()` runs exactly as it does today — `metrics.getMeter()`
against whatever the host registered, or the API's no-op `Meter` if
nothing has. This is the same guarantee ADR 003 already gives for
`StderrSpanExporter`, extended to the same boundary for metrics.

## Constraints accepted

- The 5-second dev export interval and the compact stderr format are both
  fixed, unconfigurable constants for this release — matching
  `StderrSpanExporter`'s own lack of configuration options, but a real
  limitation if a future user wants either tuned.
- `@opentelemetry/sdk-metrics` becoming a real dependency is a one-way
  door in the same sense ADR 005's own "Alternatives rejected" already
  named for this exact move — accepted now because the demand condition
  ADR 005 set ("if there's demand for a metrics equivalent of the
  dev-friendly `setupNodeSdk` mode") is this release's own audit finding,
  not a guess.
- A host that registers its own `MeterProvider` *after* calling
  `instrumentMcpServer(server, { setupNodeSdk: true })` will find their
  registration silently rejected by `@opentelemetry/api` itself (the same
  `boolean`-return mechanism, in the other direction) — identical to how
  tracing already behaves today for the equivalent case. Not a new edge
  case this ADR introduces, but worth stating: `setupNodeSdk: true`
  means "this library owns both providers," consistently, in both
  directions.

## Alternatives rejected

- **A new sibling option** (e.g. `setupMetricsSdk: true`), independent of
  `setupNodeSdk`. Rejected: recreates the exact "one more thing to opt
  into" friction this release exists to remove from the quickstart, for
  no offsetting benefit — nobody following the documented quickstart
  wants stderr spans without stderr metrics, or vice versa.
- **Reuse `ConsoleMetricExporter`** (built into `@opentelemetry/sdk-metrics`).
  Rejected per the Context section: stdout, and a raw JSON dump — fails
  both the ADR 003 constraint and the "readable by a human" requirement
  the audit asked for.
- **Optional peer + dynamic import with graceful fallback** for
  `@opentelemetry/sdk-metrics`. Rejected per the Decision section's
  dependency-strategy argument: no genuine "only some hosts want this"
  split exists for this flag, unlike the real optional-peer case
  (`@modelcontextprotocol/sdk` vs. `/server`) this codebase already has a
  considered design for.
- **A configurable export interval / output format**, now. Rejected on
  scope grounds for this pass — the fixed defaults above are judged
  sufficient for the dev-quickstart use case this ADR targets; revisit if
  real usage shows otherwise, the same "not addressed in this pass, a
  candidate for a follow-up" posture ADR 005 itself already took for its
  own open question.

## Consequences

- `package.json`: `@opentelemetry/sdk-metrics` moves from
  `devDependencies` to `dependencies`.
- A new `src/exporters/stderr-metrics.js`, sibling to the existing
  `src/exporters/stderr.js`.
- `setupTracer()` (or a new, adjacent function called at the same point)
  gains the `MeterProvider` construction/registration logic described
  above; `server.shutdown`'s body changes to also await the
  `MeterProvider`'s shutdown when one was registered.
- README's "30-second quickstart" gains a sample stderr metrics line so a
  reader knows what to expect, and the "Metrics" section's "nothing is
  recorded until a `MeterProvider` is registered" framing gains a
  dev-mode carve-out note pointing here.
- No change to any span, span attribute, metric name, or metric attribute
  this library already emits — this ADR is purely about whether a
  `MeterProvider` exists to receive them under `setupNodeSdk: true`, never
  about what gets sent to it.

## Update (post-implementation review): abandoned-provider leak and stderr noise, both fixed

Two gaps found reviewing the shipped v0.15.0 implementation, neither a
design change — both are this ADR's own stated intent, implemented
incompletely the first time.

**1. The abandoned candidate `MeterProvider` was never shut down.**
Decision point 3 above says a losing `setGlobalMeterProvider()` attempt
should leave the candidate "ungarbage-collected-but-unused" — true in
spirit, but `@opentelemetry/sdk-metrics`' `MeterProvider` constructor
already starts its `PeriodicExportingMetricReader`'s interval timer
immediately (via `onInitialized()`, called from the constructor itself —
confirmed by reading the source), independent of whether the provider is
ever registered anywhere. An unshut-down loser therefore ticked forever,
calling `export()` with an empty `ResourceMetrics` every
`DEV_METRICS_EXPORT_INTERVAL_MS`. Fixed: the losing branch now calls
`candidateMeterProvider.shutdown().catch(() => {})` immediately,
fire-and-forget (never awaited, never allowed to throw past setup).
Proven with a test that spies on `MeterProvider.prototype.shutdown` and
confirms the abandoned instance (not the pre-existing one) is shut down
synchronously within `instrumentMcpServer()`, plus fake-timer advancement
past several intervals showing zero `console.error` calls from it.

**2. `StderrMetricExporter` reprinted unchanged values forever.** Every
instrument in this library uses CUMULATIVE aggregation temporality (the
SDK default, never overridden). Confirmed empirically: a single tool call
early in a long-running dev session caused its two affected metrics to
reprint, byte-identical, on every subsequent 5-second export — for the
rest of the process's life, regardless of whether anything new happened.
Fixed, with no new configuration surface: `StderrMetricExporter` now
keeps a `Map` from each data point's identity (instrument name + its
exact attribute set) to the last-printed value signature, and skips
printing when an export's value for that identity is unchanged from the
last one actually printed. First appearance of any time series still
always prints. The compact line format itself is unchanged — this only
suppresses exact repeats of lines already shown.
