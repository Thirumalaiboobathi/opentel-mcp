import { describe, it, expect, vi, afterEach } from 'vitest';
import { StderrMetricExporter } from '../../src/exporters/stderr-metrics.js';

// DataPointType.SUM === 3, .HISTOGRAM === 0 (@opentelemetry/sdk-metrics) —
// matches the exporter's own inlined constants (see its module docblock
// for why these aren't imported).
const SUM = 3;
const HISTOGRAM = 0;

/** @param {{ name: string, unit?: string, dataPointType: number, dataPoints: Array<{ attributes?: object, value: unknown }> }} metric */
function resourceMetrics(metric) {
  return {
    scopeMetrics: [
      {
        metrics: [
          {
            descriptor: { name: metric.name, unit: metric.unit ?? '', description: '' },
            dataPointType: metric.dataPointType,
            dataPoints: metric.dataPoints.map((dp) => ({ attributes: {}, ...dp })),
          },
        ],
      },
    ],
  };
}

function exportAsync(exporter, metrics) {
  return new Promise((resolve) => exporter.export(metrics, resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StderrMetricExporter', () => {
  it('prints a counter as "name{attrs} = value" to stderr (console.error), never stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exporter = new StderrMetricExporter();
    await exportAsync(
      exporter,
      resourceMetrics({
        name: 'mcp.tool.calls',
        dataPointType: SUM,
        dataPoints: [{ attributes: { 'gen_ai.tool.name': 'echo' }, value: 3 }],
      }),
    );

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=echo} = 3');
  });

  it('prints a histogram as "name{attrs} count=<n> avg=<sum/count><unit>"', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = new StderrMetricExporter();

    await exportAsync(
      exporter,
      resourceMetrics({
        name: 'mcp.tool.duration',
        unit: 'ms',
        dataPointType: HISTOGRAM,
        dataPoints: [{ attributes: { 'mcp.tool.outcome': 'success' }, value: { count: 2, sum: 25 } }],
      }),
    );

    expect(errSpy).toHaveBeenCalledWith('[opentel-mcp metrics] mcp.tool.duration{mcp.tool.outcome=success} count=2 avg=12.5ms');
  });

  it('sorts attribute keys deterministically, regardless of insertion order', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = new StderrMetricExporter();

    await exportAsync(
      exporter,
      resourceMetrics({
        name: 'mcp.tool.errors',
        dataPointType: SUM,
        dataPoints: [{ attributes: { 'error.type': 'TypeError', 'gen_ai.tool.name': 'echo' }, value: 1 }],
      }),
    );

    expect(errSpy).toHaveBeenCalledWith('[opentel-mcp metrics] mcp.tool.errors{error.type=TypeError,gen_ai.tool.name=echo} = 1');
  });

  it('emits nothing for a metric with zero data points (never called yet)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exporter = new StderrMetricExporter();

    await exportAsync(exporter, resourceMetrics({ name: 'mcp.tool.calls', dataPointType: SUM, dataPoints: [] }));

    expect(errSpy).not.toHaveBeenCalled();
  });

  describe('change detection — the same (instrument, attribute-set) pair is CUMULATIVE and would otherwise reprint unchanged forever', () => {
    it('suppresses a repeat export whose value is identical to the last one printed', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exporter = new StderrMetricExporter();
      const metrics = resourceMetrics({
        name: 'mcp.tool.calls',
        dataPointType: SUM,
        dataPoints: [{ attributes: { 'gen_ai.tool.name': 'echo' }, value: 1 }],
      });

      await exportAsync(exporter, metrics);
      await exportAsync(exporter, metrics); // identical cumulative value, as a real unchanged interval would report
      await exportAsync(exporter, metrics);

      expect(errSpy).toHaveBeenCalledTimes(1);
    });

    it('prints again once the value actually changes, then suppresses the new unchanged value too', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exporter = new StderrMetricExporter();
      const makeMetrics = (value) =>
        resourceMetrics({
          name: 'mcp.tool.calls',
          dataPointType: SUM,
          dataPoints: [{ attributes: { 'gen_ai.tool.name': 'echo' }, value }],
        });

      await exportAsync(exporter, makeMetrics(1));
      await exportAsync(exporter, makeMetrics(1)); // unchanged, suppressed
      await exportAsync(exporter, makeMetrics(2)); // changed, printed
      await exportAsync(exporter, makeMetrics(2)); // unchanged again, suppressed

      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenNthCalledWith(1, '[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=echo} = 1');
      expect(errSpy).toHaveBeenNthCalledWith(2, '[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=echo} = 2');
    });

    it('tracks each distinct attribute-set as its own independent time series', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exporter = new StderrMetricExporter();

      await exportAsync(
        exporter,
        resourceMetrics({
          name: 'mcp.tool.calls',
          dataPointType: SUM,
          dataPoints: [
            { attributes: { 'gen_ai.tool.name': 'echo' }, value: 1 },
            { attributes: { 'gen_ai.tool.name': 'search' }, value: 1 },
          ],
        }),
      );
      // "echo" unchanged, "search" changed -- each must be judged independently.
      await exportAsync(
        exporter,
        resourceMetrics({
          name: 'mcp.tool.calls',
          dataPointType: SUM,
          dataPoints: [
            { attributes: { 'gen_ai.tool.name': 'echo' }, value: 1 },
            { attributes: { 'gen_ai.tool.name': 'search' }, value: 2 },
          ],
        }),
      );

      expect(errSpy).toHaveBeenCalledTimes(3);
      expect(errSpy).toHaveBeenNthCalledWith(3, '[opentel-mcp metrics] mcp.tool.calls{gen_ai.tool.name=search} = 2');
    });

    it('treats a histogram with the same count but a different sum as changed', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exporter = new StderrMetricExporter();
      const makeMetrics = (count, sum) =>
        resourceMetrics({
          name: 'mcp.tool.duration',
          unit: 'ms',
          dataPointType: HISTOGRAM,
          dataPoints: [{ attributes: {}, value: { count, sum } }],
        });

      await exportAsync(exporter, makeMetrics(1, 10));
      await exportAsync(exporter, makeMetrics(1, 10)); // identical, suppressed
      await exportAsync(exporter, makeMetrics(1, 20)); // same count, different sum -- still a real change

      expect(errSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('never throws on a malformed data point; reports a failed export instead', async () => {
    const exporter = new StderrMetricExporter();
    const malformed = {
      scopeMetrics: [{ metrics: [{ descriptor: { name: 'broken' }, dataPointType: SUM, dataPoints: null }] }],
    };

    const result = await exportAsync(exporter, malformed);
    expect(result.code).toBe(1);
  });
});
