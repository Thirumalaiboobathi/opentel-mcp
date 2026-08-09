# opentel-mcp Grafana dashboard

`grafana-mcp-health.json` is a Grafana dashboard for the metrics opentel-mcp
emits — specifically the failure/cost signal standard OTel tracing misses:
silent tool failures, agent thrash loops, tool schema drift, and LLM cost
attribution.

This directory is **not** part of the published `opentel-mcp` npm package
(see "npm packaging" below) — it's a repo-only artifact for anyone running
opentel-mcp to import into their own Grafana.

## Requirements

- A **Prometheus** datasource in Grafana. The dashboard has no OTLP/trace
  panels — everything here is a `mcp.tool.*` / `mcp.tool.loop.*` /
  `mcp.tool.schema_drift.*` metric, scraped by Prometheus from whatever
  exports opentel-mcp's meter (`opentel-mcp` calls `metrics.getMeter()` —
  see src/metrics.js — but never registers a `MeterProvider` itself; your
  host application must register one with a Prometheus-compatible reader,
  same as any other OTel Metrics SDK consumer).
- Metric points must carry a `service_name` label for the dashboard's
  `service.name` template variable to filter on. The OTel Prometheus
  exporter does **not** add resource attributes to every series by
  default — only to a separate `target_info` series. Configure it with
  `withResourceConstantLabels: /^service\.name$/` (see
  `dev/metrics-demo-server.js` for a working example) so `service.name`
  gets flattened onto every point instead.

## Importing

1. In Grafana: **Dashboards → New → Import**.
2. Upload `grafana-mcp-health.json` (or paste its contents).
3. Pick your Prometheus datasource when prompted (the `datasource`
   template variable at the top of the dashboard).
4. The `service.name` variable populates from
   `label_values(mcp_tool_calls_total, service_name)` — select one or more
   services, or leave on "All".

## Panels

| Panel | Metric(s) | What it answers |
|---|---|---|
| Silent failure rate | `mcp_tool_silent_failures_total` / `mcp_tool_calls_total` | What fraction of tool calls returned `isError: true` inside an otherwise-successful response — the failure class standard OTel renders as a clean green span, because nothing threw and no `error.type` was set. This is the headline panel. |
| Silent failures by tool | `mcp_tool_silent_failures_total` by `gen_ai_tool_name` | Which specific tool is broken, not just "something is failing." |
| Failure category breakdown | `mcp_tool_errors_total` + `mcp_tool_silent_failures_total` by `mcp_failure_category` | Is this auth, timeout, network, a bad dependency, or something internal? One of 8 closed-enum categories from opentel-mcp's fingerprint classifier — the only fingerprint-derived attribute low-cardinality enough to be metric-safe (see `METRIC_SAFE_ATTRIBUTES`, `src/fingerprint/attributes.js`). |
| Thrash episodes and wasted cost | `mcp_tool_loop_detected_total`, `mcp_tool_loop_wasted_cost_usd_sum` | How often the same tool is failing on the same fingerprint repeatedly (an agent stuck in a retry loop, default threshold 3), and how much that's costing in real USD. |
| Schema drift events by tool | `mcp_tool_schema_drift_detected_total` by `gen_ai_tool_name` | Which tool's `inputSchema` changed between two `tools/list` calls — a contract change that silently breaks any caller holding the old schema. No standard-OTel equivalent exists for this at all. |
| Cost by tool | `mcp_tool_cost_total` by `gen_ai_tool_name` | Estimated USD spend per tool. Only populated for calls whose result carries a recognizable token-usage shape (Anthropic/OpenAI/Bedrock conventions) — see "Known gaps" below. |

## Known gaps (why there's no "budget breach" panel)

`mcp.tool.cost.budget_exceeded` and `mcp.tool.cost.budget_scope` (see
`src/cost/budget.js`, `src/attributes.js`) are **span attributes only** —
set on the tool-call span when cumulative cost crosses a configured
per-session or per-tool limit. There is no counter or histogram for budget
breaches anywhere in the library. A Prometheus dashboard has no way to
query that signal; it would need a trace backend (Tempo, Jaeger, etc.)
instead. Rather than ship a panel against a metric that doesn't exist, this
dashboard omits it. If you need this signal, either query your trace
backend directly for spans with `mcp.tool.cost.budget_exceeded = true`, or
add a real counter in `src/cost/budget.js`/`src/metrics.js` upstream.

Other attributes that exist but deliberately **never** appear on any panel
here, because they're span-only by design (unbounded/high-cardinality —
see `src/fingerprint/attributes.js`'s `METRIC_SAFE_ATTRIBUTES` docblock):
`mcp.failure.fingerprint`, `mcp.failure.signature`,
`mcp.failure.error_class`, `mcp.failure.validation_paths`,
`mcp.loop.session_id`. These are visible on span events
(`mcp.loop.detected`, `mcp.tool.schema_drift.*`) in your trace backend, not
in Prometheus.

## Generating sample data / verifying locally

`dev/` holds a self-contained (non-workspace, unpublished) harness that
drives real MCP traffic through `instrumentMcpServer()` with a Prometheus
metrics exporter attached, plus a docker-compose stack for Prometheus +
Grafana:

```bash
# 1. Start Prometheus + Grafana (Prometheus scrapes the host's :9464)
cd dashboards/dev
docker compose up -d

# 2. In a second terminal: install and run the metrics-emitting demo server
cd dashboards/dev
npm install
npm start
# -> Prometheus scrape endpoint on http://localhost:9464/metrics
#    Drives one traffic cycle immediately, then repeats every 15s so
#    rate()/increase() panels have more than one data point.

# 3. Open Grafana at http://localhost:3000 (anonymous admin access,
#    dev-only — see docker-compose.yml). The dashboard is auto-provisioned
#    under Dashboards -> opentel-mcp: MCP Server Health.
```

`dev/metrics-demo-server.js` mirrors `packages/ui/demo/populate.js`'s
traffic mix (successes, silent failures across several tools/categories, a
thrash loop, thrown/protocol errors, schema drift), but additionally:

- registers a real `MeterProvider` + `PrometheusExporter` before calling
  `instrumentMcpServer()` — `populate.js` only wires traces, since that's
  all the UI dashboard needs;
- attaches recognizable token-usage data (`usage: { input_tokens,
  output_tokens }`, `model`) to a couple of tool results, since
  `mcp.tool.tokens.total`/`mcp.tool.cost.total` only get samples when a
  result carries a shape `src/cost/extractor.js` recognizes — plain-text
  tool results never trigger cost tracking, which is expected;
- loops the whole traffic cycle every 15s indefinitely, so Prometheus's
  `rate()`/`increase()` windows have real, moving data instead of one
  static burst.

Every panel above was verified against this exact setup — through
Grafana's own `/api/ds/query` (not just raw PromQL against Prometheus) —
before being shipped: each returned `status: 200` with non-empty series.

## npm packaging

`dashboards/` (including this file, the dashboard JSON, and `dev/`) is
**repo-only** — it is not in `packages/core/package.json`'s `files` array
(`["src", "README.md", "CHANGELOG.md", "LICENSE"]`) or
`packages/ui/package.json`'s, and it lives outside both package
directories at the monorepo root, so `npm pack`/`npm publish` from either
package never includes it regardless. No `files`-array change was needed
or made.
