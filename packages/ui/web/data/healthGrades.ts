import type { SerializedSpan } from '../../src/types.d.ts';
import { getFreshness } from './freshness';

/**
 * Per-tool health grades, computed only from what the dashboard already
 * receives (SerializedSpan) -- no core attribute or metric of its own.
 * The formula and thresholds are documented in docs/health-grades.md;
 * keep the two in sync.
 *
 * Formula: each signal gets its own letter from the thresholds below, and
 * the tool's grade is the WORST of them. The grade is therefore always
 * explainable as "this signal, at this value" -- the tooltip names it.
 *
 * The fifth signal, stale-data rate (core 0.17.0+, ADR 027), only applies
 * to tools that report freshness: it's n/a (null) for a tool with fewer
 * than MIN_CALLS responses carrying a fresh/stale verdict, and that tool is
 * graded on the other four.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type SignalKey = 'silentFailureRate' | 'errorRate' | 'thrashEpisodes' | 'p95LatencyMs' | 'staleRate';

/** Below this many calls in the buffer, no grade -- "Not enough data". */
export const MIN_CALLS = 10;

const GRADE_ORDER: Grade[] = ['A', 'B', 'C', 'D', 'F'];

/**
 * Exclusive upper bounds for A, B, C, D, in that order: a value below the
 * first bound is an A, below the second a B, and so on; at or above the
 * last bound is an F. An `Infinity` bound means that letter (and every
 * worse one) is unreachable for the signal.
 */
export const THRESHOLDS: Record<SignalKey, [number, number, number, number]> = {
  // isError: true results -- the failure the agent sees but OTel doesn't.
  silentFailureRate: [0.02, 0.05, 0.15, 0.3],
  // Thrown / protocol-level failures.
  errorRate: [0.02, 0.05, 0.15, 0.3],
  // Calls opentel-mcp flagged as part of a thrash loop. 0 = A, 1 = C,
  // 2-3 = D, 4+ = F (no B: any thrash is worth more than a nudge).
  thrashEpisodes: [1, 1, 2, 4],
  // 95th-percentile call duration, nearest-rank. Capped at C: no D or F
  // bound, so a slow-but-working tool never reads as broken. Latency can
  // pull an otherwise-A tool down to C, never further.
  p95LatencyMs: [1000, 2500, Infinity, Infinity],
  // Successful responses whose data was older than the tool's own
  // freshness limit, among responses with a fresh/stale verdict. Same
  // bounds as the failure rates: the agent acted on wrong data either way.
  staleRate: [0.02, 0.05, 0.15, 0.3],
};

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  silentFailureRate: 'silent failures',
  errorRate: 'errors',
  thrashEpisodes: 'thrash episodes',
  p95LatencyMs: 'p95 latency',
  staleRate: 'stale data',
};

/** The span attribute opentel-mcp core sets on a call that completed a thrash loop. */
export const THRASH_ATTRIBUTE = 'mcp.tool.thrash_detected';

export interface SignalResult {
  value: number;
  grade: Grade;
}

/** Every signal always applies, except staleRate: null = n/a for this tool. */
export type Signals = { [K in Exclude<SignalKey, 'staleRate'>]: SignalResult } & { staleRate: SignalResult | null };

export interface ToolHealth {
  toolName: string;
  calls: number;
  /** null = "Not enough data" (fewer than MIN_CALLS calls). */
  grade: Grade | null;
  signals: Signals | null;
  /** Responses carrying a fresh or stale verdict (ADR 027). 0 for tools that don't report freshness. */
  freshnessVerdicts: number;
  /** Responses whose verdict was stale. */
  staleResponses: number;
  /** The signal(s) whose letter equals the final grade. Empty when ungraded. */
  drivers: SignalKey[];
  /** Plain-language tooltip text. */
  explanation: string;
}

export function letterFor(value: number, bounds: readonly number[]): Grade {
  for (let i = 0; i < bounds.length; i++) {
    if (value < bounds[i]!) return GRADE_ORDER[i]!;
  }
  return 'F';
}

function worst(grades: Grade[]): Grade {
  return grades.reduce((a, b) => (GRADE_ORDER.indexOf(b) > GRADE_ORDER.indexOf(a) ? b : a), 'A');
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

function formatValue(key: SignalKey, value: number): string {
  if (key === 'silentFailureRate' || key === 'errorRate' || key === 'staleRate') return `${Math.round(value * 100)}%`;
  if (key === 'p95LatencyMs') return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
  return String(value);
}

/** Grades one tool from its spans. Pure; never throws on odd input. */
export function gradeTool(toolName: string, spans: SerializedSpan[]): ToolHealth {
  const calls = spans.length;
  let freshnessVerdicts = 0;
  let staleResponses = 0;
  let reportsFreshness = false;
  for (const span of spans) {
    const verdict = getFreshness(span)?.verdict;
    if (verdict) reportsFreshness = true;
    if (verdict === 'fresh' || verdict === 'stale') freshnessVerdicts++;
    if (verdict === 'stale') staleResponses++;
  }

  if (calls < MIN_CALLS) {
    return {
      toolName,
      calls,
      grade: null,
      signals: null,
      freshnessVerdicts,
      staleResponses,
      drivers: [],
      explanation: `Not enough data: ${calls} call${calls === 1 ? '' : 's'} in the current buffer; a grade needs at least ${MIN_CALLS}.`,
    };
  }

  let silent = 0;
  let errors = 0;
  let thrash = 0;
  const durations: number[] = [];
  for (const span of spans) {
    if (span.errorType === 'tool_error') silent++;
    else if (span.status === 'ERROR') errors++;
    if (span.attributes?.[THRASH_ATTRIBUTE] === true) thrash++;
    if (Number.isFinite(span.durationMs)) durations.push(span.durationMs);
  }

  const values: Record<SignalKey, number | null> = {
    silentFailureRate: silent / calls,
    errorRate: errors / calls,
    thrashEpisodes: thrash,
    p95LatencyMs: percentile(durations, 0.95),
    // Same minimum-sample rule as the grade itself, applied to verdicts.
    staleRate: freshnessVerdicts >= MIN_CALLS ? staleResponses / freshnessVerdicts : null,
  };

  const signals = Object.fromEntries(
    (Object.keys(values) as SignalKey[]).map((key) => {
      const value = values[key];
      return [key, value === null ? null : { value, grade: letterFor(value, THRESHOLDS[key]) }];
    }),
  ) as Signals;

  const keys = (Object.keys(signals) as SignalKey[]).filter((key) => signals[key] !== null);
  const result = (key: SignalKey) => signals[key] as SignalResult;
  const grade = worst(keys.map((key) => result(key).grade));
  const drivers = grade === 'A' ? [] : keys.filter((key) => result(key).grade === grade);
  const describe = (key: SignalKey) => `${SIGNAL_LABELS[key]} ${formatValue(key, result(key).value)} (${result(key).grade})`;

  const lead =
    drivers.length === 0
      ? `Grade A: every signal is within its A threshold.`
      : `Grade ${grade}, set by ${drivers.map(describe).join(' and ')}.`;
  const others = keys.filter((key) => !drivers.includes(key)).map(describe);
  // Mention the n/a staleness signal only for a tool that reports
  // freshness at all; for every other tool it's noise.
  const staleNa =
    signals.staleRate === null && reportsFreshness
      ? `Stale data: n/a, only ${freshnessVerdicts} response${freshnessVerdicts === 1 ? '' : 's'} with a freshness verdict (needs ${MIN_CALLS}).`
      : null;
  const explanation = [
    lead,
    others.length > 0 && drivers.length > 0 ? `Other signals: ${others.join(', ')}.` : `Signals: ${others.join(', ')}.`,
    staleNa,
    `Based on the last ${calls} calls in the buffer. The grade is the worst of the ${keys.length} signal grades (see docs/health-grades.md).`,
  ]
    .filter(Boolean)
    .join(' ');

  return { toolName, calls, grade, signals, freshnessVerdicts, staleResponses, drivers, explanation };
}

/** One-line reason for the table's "Why" column. */
export function shortReason(health: ToolHealth): string {
  if (health.grade === null || !health.signals) return `Needs ${MIN_CALLS}+ calls`;
  if (health.drivers.length === 0) return 'All signals healthy';
  return health.drivers.map((key) => `${SIGNAL_LABELS[key]} ${formatValue(key, health.signals![key]!.value)}`).join(', ');
}

/**
 * Grades every tool seen in `spans` (spans without a tool name are
 * ignored). Worst grade first; ungraded tools last; ties by name.
 */
export function computeToolHealth(spans: SerializedSpan[]): ToolHealth[] {
  const byTool = new Map<string, SerializedSpan[]>();
  for (const span of spans) {
    if (!span.toolName) continue;
    const list = byTool.get(span.toolName);
    if (list) list.push(span);
    else byTool.set(span.toolName, [span]);
  }

  const rank = (h: ToolHealth) => (h.grade === null ? -1 : GRADE_ORDER.indexOf(h.grade));
  return [...byTool.entries()]
    .map(([toolName, toolSpans]) => gradeTool(toolName, toolSpans))
    .sort((a, b) => rank(b) - rank(a) || a.toolName.localeCompare(b.toolName));
}
