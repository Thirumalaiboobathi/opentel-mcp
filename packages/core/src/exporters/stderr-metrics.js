/**
 * @module exporters/stderr-metrics
 * A PushMetricExporter that prints metrics to stderr, in a compact,
 * one-line-per-instrument format — not @opentelemetry/sdk-metrics' own
 * ConsoleMetricExporter, which writes via console.dir (stdout) and dumps
 * each instrument's full internal {descriptor, dataPointType, dataPoints}
 * shape as unflattened JSON (ADR 023).
 *
 * Sibling to ./stderr.js (StderrSpanExporter, ADR 003) — same
 * stdio-transport-safety reasoning: stdout is reserved for a
 * StdioServerTransport server's JSON-RPC stream, so diagnostic output of
 * any OTel signal must go to stderr instead.
 *
 * Reads only the attributes the existing 12 instruments — mcp.tool.*
 * (src/metrics.js), mcp.tool.loop.* (src/thrash/emitter.js), and
 * mcp.tool.schema_drift.* (src/schema-drift/emitter.js) — already attach.
 * Adds no new attribute or metric-label surface of its own, so
 * METRIC_SAFE_ATTRIBUTES governance is unaffected.
 */

// DataPointType.HISTOGRAM === 0, .SUM === 3 (@opentelemetry/sdk-metrics) —
// inlined rather than importing the enum, same "avoid a dependency for a
// couple of integer constants" call stderr.js already makes for
// ExportResultCode (see that module's own comment).
const DATA_POINT_TYPE_HISTOGRAM = 0;

/**
 * Flattens an attribute bag into a stable, sorted-by-key `{k=v,k=v}`
 * suffix — deterministic across runs (never insertion-order-dependent),
 * so a human diffing two terminal sessions sees only real differences.
 *
 * @param {Record<string, unknown>} attributes
 * @returns {string}
 */
function formatAttributes(attributes) {
  const keys = Object.keys(attributes).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}=${attributes[key]}`).join(',')}}`;
}

/**
 * One entry per data point: a stable identity `key` (which time series
 * this is — the instrument name plus its exact attribute set) separate
 * from `line` (the human-readable text) and `signature` (just the
 * value-bearing part, cheap to compare across export intervals without
 * re-parsing `line`). Counters/gauges/up-down-counters print their
 * current value (`= <n>`); histograms print a count + average
 * (`count=<n> avg=<sum/count><unit>`) rather than a full bucket dump — a
 * terminal reader wants "how many, roughly how long," not a distribution.
 *
 * @param {import('@opentelemetry/sdk-metrics').MetricData} metric
 * @returns {Array<{ key: string, line: string, signature: string }>}
 */
function formatMetric(metric) {
  const { name, unit } = metric.descriptor;
  const entries = [];

  for (const dataPoint of metric.dataPoints) {
    const attrs = formatAttributes(dataPoint.attributes);
    const key = `${name}${attrs}`;

    if (metric.dataPointType === DATA_POINT_TYPE_HISTOGRAM) {
      const { count, sum } = dataPoint.value;
      const avg = count > 0 && typeof sum === 'number' ? (sum / count).toFixed(1) : '0';
      entries.push({
        key,
        line: `[opentel-mcp metrics] ${key} count=${count} avg=${avg}${unit}`,
        signature: `${count}:${sum}`,
      });
    } else {
      entries.push({
        key,
        line: `[opentel-mcp metrics] ${key} = ${dataPoint.value}`,
        signature: String(dataPoint.value),
      });
    }
  }

  return entries;
}

export class StderrMetricExporter {
  constructor() {
    // Every mcp.tool.* instrument uses CUMULATIVE aggregation temporality
    // (the SDK's own default — never overridden here): once a tool is
    // called even once, that (instrument, attribute-set) pair gets a
    // permanent data point that every FUTURE export() call re-receives,
    // unchanged, for the rest of the process's life, regardless of
    // whether any new activity happened in the interval between. Without
    // this map, a single call early in a long dev session reprints two
    // identical lines every 5 seconds forever — confirmed empirically,
    // not assumed. Keyed by formatMetric()'s own `key` (instrument name +
    // exact attribute set); values are the last-printed `signature`, so a
    // repeat export() with no real change is detected and skipped without
    // re-deriving or re-parsing the full line.
    this._lastSignatures = new Map();
  }

  /**
   * @param {import('@opentelemetry/sdk-metrics').ResourceMetrics} metrics
   * @param {(result: { code: number }) => void} resultCallback
   */
  export(metrics, resultCallback) {
    try {
      for (const scopeMetrics of metrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          // Never emit a line for a metric with zero data points yet (no
          // calls recorded ever) — a dev terminal showing twelve "= 0"
          // lines every 5 seconds before any tool has even been called
          // is noise, not signal. formatMetric() already produces zero
          // entries for such a metric, so this loop is naturally a no-op
          // for it without any extra check here.
          for (const { key, line, signature } of formatMetric(metric)) {
            if (this._lastSignatures.get(key) === signature) continue;
            console.error(line);
            // Set only after a successful print, not before — if
            // console.error somehow throws, this export() call fails
            // (caught below, reported via resultCallback({ code: 1 })),
            // and an SDK-level retry should see this as still unprinted
            // rather than silently marked done.
            this._lastSignatures.set(key, signature);
          }
        }
      }
      // 0 === ExportResultCode.SUCCESS (@opentelemetry/core) — see
      // stderr.js's identical comment for why this is inlined.
      resultCallback({ code: 0 });
    } catch {
      // Never-throw: a malformed metric data point must degrade to a
      // failed export, never crash the host process the metric came from.
      resultCallback({ code: 1 });
    }
  }

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return Promise.resolve();
  }
}
