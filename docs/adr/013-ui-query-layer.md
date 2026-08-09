# ADR 013: opentel-mcp-ui as a query layer over an existing OTel backend

**Status:** Investigated, not recommended as scoped. Design only — no
implementation. See "Recommendation" at the end.

## Context

`opentel-mcp-ui` (`packages/ui`) currently works by holding its own
bounded in-process ring buffer of spans, fed either by a best-effort
`SpanProcessor` attach or by a real `POST /v1/traces` OTLP/HTTP JSON
receiver (see RUNLOG.md's Step 3 entry for why the latter, not the
former, is the reliable path — `@opentelemetry/sdk-trace` 2.x has no
public API to attach a processor after a `TracerProvider` is
constructed). This makes the dashboard genuinely zero-infrastructure —
one command, no separate database, no config file — but also means it
only ever shows what fits in its own buffer, in its own process, for as
long as that process runs. It cannot be pointed at a fleet of MCP
servers, cannot show history older than the buffer's capacity, and
disappears when the process restarts.

This ADR investigates the alternative: instead of storing spans itself,
the UI queries a backend that already holds them (SigNoz, Grafana Tempo,
or Jaeger), and renders the MCP-specific panels — the observation matrix,
the silent-failure feed, thrash episodes, and schema drift — as views
over that backend's data. Investigated with each backend's real,
current documentation and (where documentation was silent) its
IDL/proto source, not assumed. Full findings, with citations, precede
this document in the conversation this ADR was written from; this
document summarizes and decides, it does not re-derive.

### What the panels actually need, checked against this library's own emission

The decisive fact this investigation turned on: within one MCP tool-call
span, opentel-mcp's own signals split across three different places, not
two.

| Signal | Panel | Where it lives (verified against source) |
|---|---|---|
| `error.type`, span `status` | Observation matrix, silent-failure feed | span attribute + core span field (`instrument.js`) |
| `mcp.failure.category`, `mcp.failure.channel`, `gen_ai.tool.name` | Silent-failure feed | span attribute (`instrument.js`, `fingerprint/attributes.js`) |
| `mcp.tool.thrash_detected: true` | Thrash episodes (existence) | span attribute (`thrash/attributes.js`) — added specifically per ADR 011 as a fallback in case event data isn't externally matchable |
| loop length, wasted tokens/cost, session id, fingerprint | Thrash episodes (detail) | span **event** (`mcp.loop.detected`) only — no attribute (`thrash/emitter.js`) |
| drift kind, hashes, added/removed/changed fields | Schema drift panel | span **event** (`mcp.tool.schema_drift.detected`) only — **no parallel attribute exists at all** (`schema-drift/emitter.js`, `schema-drift/attributes.js`) |
| Transport shape, tracker live/unavailable/unknown, `ObservationIntegrity` | Detector status banner, matrix completeness line | **not telemetry** — read by inspecting the live `instrumentedServer` object in-process (`packages/ui/src/meta.js`, core's `observation/integrity.js`) |

ADR 011 already anticipated exactly this risk for thrash — it added
`mcp.tool.thrash_detected` as a boolean attribute specifically because
the one high-cardinality detail lived only on a span event, and an
external tail-sampling policy might not be able to match event data.
Schema drift (ADR 010, shipped after ADR 011) did not receive the same
treatment: it has no attribute fallback at all. This ADR's investigation
is, among other things, evidence that ADR 011's worry was well-founded
and should probably have been applied uniformly — noted as a candidate
follow-up, not decided here.

## Investigation findings

### SigNoz

Query API: `POST /api/v5/query_range`. Arbitrary span/resource attribute
filtering is real and documented (`fieldContext: attribute|resource|span`).
**Span events are not a queryable field context at all** — absent from
the v5 payload-model documentation, and the only place SigNoz exposes
event data is its ClickHouse `signoz_traces` table's
`events Array(String)` column, stored as **stringified JSON blobs**,
reachable only via raw ClickHouse SQL in Dashboards (docs: "ClickHouse
queries are only supported in Dashboards") — not the ad-hoc query API a
UI would call on demand. A live, open feature request
([SigNoz/signoz#6015](https://github.com/SigNoz/signoz/issues/6015))
confirms event-based filtering from the trace explorer doesn't exist
today. Auth is a static, admin-scoped `SIGNOZ-API-KEY` header issued
under Service Accounts — not a credential safe to embed in a browser
bundle regardless of CORS. CORS: found a documented CORS option for the
OTLP **ingestion** receiver (a different component); found no documented
CORS option for the **query** API, and a real user-reported cross-origin
failure against it ([SigNoz/signoz#1644](https://github.com/SigNoz/signoz/issues/1644)).

### Grafana Tempo (TraceQL)

Query language: TraceQL, with first-class attribute *scopes* —
`span.foo`, `resource.foo`, and **`event.foo`** — plus `event:name = "..."`
to match by event name, confirmed directly against the docs:

```
{ event:name = "exception" }
{ event.exception.message =~ ".*went wrong.*" }
{ span.http.method = "DELETE" && status != ok } && { event.exception.message = nil }
```

[grafana/tempo#2313](https://github.com/grafana/tempo/issues/2313)
("Allow searching by event attribute in TraceQL") is closed —
implemented, not aspirational. This is the only one of the three
backends where span-event data is a first-class, currently-shipping
query target. Auth: bearer token, OAuth-forward, basic auth, or no auth
(`X-Scope-OrgID` header for multi-tenancy) — no-auth deployments exist
and are realistic inside a trusted internal network. No documented CORS
configuration found for the query-frontend.

### Jaeger

Jaeger's own docs state the JSON API Jaeger UI itself uses is
**"intentionally undocumented and subject to change."** The documented,
recommended API is `jaeger.api_v3.QueryService`, which (checked directly
against the proto in `jaeger-idl`) does expose an HTTP/JSON gateway
(`GET/POST /api/v3/traces`) — not gRPC-only. `FindTraces` filters on
`service_name`, `operation_name`, `attributes` (span/resource key-value),
and duration/time range. **There is no parameter for filtering by
log/event content anywhere in the proto.** Once a trace ID is already
known, fetching it in full does return its spans' embedded logs/events,
so a "find by attribute, then fetch-and-inspect" two-step is possible
where an attribute proxy exists (thrash) but not where none exists
(schema drift, at any real production call volume). CORS is a
long-open, unresolved issue the Jaeger maintainers have not shipped a
fix for ([jaegertracing/jaeger#2039](https://github.com/jaegertracing/jaeger/issues/2039),
[#703](https://github.com/jaegertracing/jaeger/issues/703)).

### Panel-by-panel result

| Panel | SigNoz | Tempo | Jaeger |
|---|---|---|---|
| Observation matrix | ✅ one query | ✅ one query | ✅ one query (unpacks whole traces) |
| Silent-failure feed | ✅ one query | ✅ one query | ✅ one query, same caveat |
| Thrash episodes — existence | ✅ attribute query | ✅ attribute query | ✅ attribute query |
| Thrash episodes — detail | ❌ event data unreachable via the query API | ✅ one query | ⚠️ find-by-attribute → fetch-full-trace → parse client-side (N+1, not a query) |
| Schema drift | ❌ not expressible | ✅ one query | ❌ no attribute proxy exists; would mean fetching every `tools/list` trace to inspect client-side — doesn't scale |
| Detector status banner / completeness line | ❌ | ❌ | ❌ — not a capability gap; the signal has never been emitted as telemetry by any deployment shape |

### Auth and CORS, synthesized

None of the three ship a documented, CORS-open, browser-credential-safe
query API by default. The one narrow exception is Tempo configured with
no auth inside a trusted internal network — workable for an
internal-only dashboard, not for anything crossing a real trust or
network boundary. In every other case — which is most real deployments,
including anything meant to be reachable outside one private network —
**a thin server-side proxy holding the real credential is required**,
with the browser talking only to that proxy. This is a deployed server
component, full stop. **The "lightweight, zero-infrastructure" framing
that has been this project's differentiator since Step 3 does not
survive this transition intact for any backend that requires auth or
crosses an origin boundary.** Not softened here on purpose, per the
brief this investigation was scoped against.

## Decision

### Which backend to target first, if this is built at all

**Grafana Tempo**, argued from what was actually found, not popularity:
it is the only one of the three backends where `event.*` is a
first-class, currently-shipping TraceQL query target. That single fact
is the difference between "all four MCP-specific panels are expressible
as one query each" (Tempo) and "two of four panels are structurally
blocked by the backend's own documented API, not by anything this
project could implement around" (SigNoz, Jaeger). SigNoz and Jaeger are
not close seconds on capability; they are blocked on the exact data this
library's most distinctive signals (thrash detail, schema drift) live
on.

### Which panels survive, which need reworking, which cannot be expressed at all

- **Survive intact:** observation matrix, silent-failure feed. Both
  depend only on span attributes and the span's own status field, which
  every backend investigated supports as a first-class filter. On Jaeger
  specifically, "intact" requires an extra client-side step to unpack
  traces into spans, since its API returns traces, not bare spans.
- **Survives on Tempo only, need reworking or don't survive elsewhere:**
  thrash-episode detail (Tempo: intact; SigNoz: cannot be built at all
  against the documented API; Jaeger: rebuildable as an N+1
  fetch-and-parse pattern, which is a real rework, not a query).
- **Cannot be expressed as a backend query at all, on any of the three
  backends investigated:** the detector status banner and the matrix's
  completeness line (`ObservationIntegrity`, per-tracker live/unavailable/
  unknown). This is not a per-backend gap to work around — the signal
  itself has no representation in the OTel data model today. Making this
  panel survive a query-layer transition, on ANY backend, requires a NEW
  opentel-mcp core emission (e.g. a periodic self-report span, log, or
  metric carrying `getObservationState()`'s result) that does not exist
  yet and is out of this ADR's scope to design. Named explicitly, per
  the brief: this is the finding, not a failure to find a workaround.
- **Cannot be expressed as a backend query at all, on SigNoz or Jaeger
  specifically, survives on Tempo:** the schema drift panel, for the
  reason above — no attribute fallback exists for it the way
  `mcp.tool.thrash_detected` exists for thrash, so there is nothing for
  SigNoz's or Jaeger's attribute-only filtering to find it by.

### In-process buffer mode: kept alongside, or replaced?

**Argument for keeping both:** the in-process/OTLP-receiver mode is the
zero-infrastructure local demo — `npx opentel-mcp-ui --demo`, no backend
to stand up, works on a laptop with no network. That is currently this
project's single strongest, most differentiated property (see
HANDOFF.md — it is the thing a query-layer mode cannot be, by
definition, since a query layer's entire premise is "a backend already
holds the spans"). Losing it to gain production capability would trade
the UI's best on-ramp for a capability that, per this investigation,
doesn't even fully deliver what it promises (the banner panel, the
"lightweight" framing).

**Argument for replacing it:** two data paths through the same UI code
is two sets of bugs, two things to keep in sync as panels evolve, and
two mental models for a contributor to hold at once — SerializedSpan's
own docblock already exists specifically to keep the UI decoupled from
`ReadableSpan`; a query-layer mode would need its own translation from
whatever shape Tempo/TraceQL returns into that same `SerializedSpan`,
which is a second, independently-maintained mapping that can drift from
the first the exact way ADR 008/opentel-mcp-contract's whole extraction
exists to prevent for the emitter/UI relationship. If the two modes ever
disagree on what a given span means, that is a categorically worse bug
than either mode being incomplete on its own.

Weighing both: keeping the in-process mode is the stronger argument here
specifically because the query-layer mode, per this investigation, is
not a strict superset of what exists today — it is production-capable
for two panels, degraded for one (thrash), and structurally missing one
(the banner) on the strongest available backend. Replacing a complete,
working, zero-infrastructure mode with an incomplete one is not a
straightforward trade.

## Recommendation

**Do not build this now, as scoped.** Two independent reasons, either of
which is sufficient on its own:

1. The "lightweight, browser-only" goal — the thing distinguishing this
   project from standing up Grafana/SigNoz/Jaeger yourself, per the
   original Step 3 brief — is not achievable against any of the three
   backends investigated, for any deployment that requires auth or
   crosses an origin boundary. That is most real deployments. A thin
   proxy is a deployed server component; calling the result "lightweight"
   would be the "MCP-specific panels on top" version of the exact
   category confusion this whole library exists to correct elsewhere.
2. The detector status banner — the panel this project's own README
   frames as a credibility feature, not a nice-to-have — cannot be
   reconstructed from backend-queried trace data on any backend
   investigated. It would need a new core emission designed and shipped
   first. Shipping a "production query layer" that silently drops the
   panel most responsible for this library's honesty framing is worse
   than not shipping it.

If a future decision revisits this: the one path with any signal of
being sound is (a) design and ship the missing core emission for
`ObservationIntegrity`/tracker status first, as its own ADR, independent
of any UI work, and (b) target Tempo specifically for a query-layer mode
*alongside*, not instead of, the existing in-process mode — accepting
plainly, in whatever ships, that it requires a proxy and is a genuinely
different deployment shape from `npx opentel-mcp-ui`, not a drop-in
upgrade to it.

## Alternatives rejected

- **Building this against SigNoz or Jaeger as the primary backend.**
  Rejected — both are structurally blocked on schema drift by their own
  documented APIs (no event-query capability, and for Jaeger, no
  attribute proxy to even narrow the search), not by anything
  implementable around the gap.
- **Replacing the in-process buffer mode entirely.** Rejected — see
  "In-process buffer mode" above; the query-layer mode is not currently
  a superset of what it would replace.
- **Building storage into opentel-mcp-ui itself** (a real database
  instead of the current ring buffer). Out of scope by the brief this
  investigation was run against — not evaluated here.

## Consequences

- No code changes result from this ADR. `packages/ui`'s in-process
  buffer + OTLP-receiver design (RUNLOG.md, Step 3) is unchanged and
  remains the only supported integration mode.
- If `ObservationIntegrity`/tracker-status telemetry emission is ever
  designed, this ADR is the reason it would need to exist independent of
  any query-layer work, not a nice-to-have alongside it.
- This ADR should be revisited if either Tempo ships a lower-friction,
  no-proxy-required auth story for browser-origin callers, or if
  opentel-mcp core ships a self-report emission for observation
  integrity — either would remove one of the two independent blockers
  above, though not both.
