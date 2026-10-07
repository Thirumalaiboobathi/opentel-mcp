import type { SerializedSpan } from '../../src/types.d.ts';

/**
 * Per-tool health grades, computed only from what the dashboard already
 * receives (SerializedSpan) -- no core attribute or metric of its own.
 * The formula and thresholds are documented in docs/health-grades.md;
 * keep the two in sync.
 *
 * Formula: each of four signals gets its own letter from the thresholds
 * below, and the tool's grade is the WORST of the four. The grade is
 * therefore always explainable as "this signal, at this value" -- the
 * tooltip names it.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type SignalKey = 'silentFailureRate' | 'errorRate' | 'thrashEpisodes' | 'p95LatencyMs';

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
};

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  silentFailureRate: 'silent failures',
  errorRate: 'errors',
  thrashEpisodes: 'thrash episodes',
  p95LatencyMs: 'p95 latency',
};

/** The span attribute opentel-mcp core sets on a call that completed a thrash loop. */
export const THRASH_ATTRIBUTE = 'mcp.tool.thrash_detected';

export interface SignalResult {
  value: number;
  grade: Grade;
}

export interface ToolHealth {
  toolName: string;
  calls: number;
  /** null = "Not enough data" (fewer than MIN_CALLS calls). */
  grade: Grade | null;
  signals: Record<SignalKey, SignalResult> | null;
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
  if (key === 'silentFailureRate' || key === 'errorRate') return `${Math.round(value * 100)}%`;
  if (key === 'p95LatencyMs') return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
  return String(value);
}

/** Grades one tool from its spans. Pure; never throws on odd input. */
export function gradeTool(toolName: string, spans: SerializedSpan[]): ToolHealth {
  const calls = spans.length;
  if (calls < MIN_CALLS) {
    return {
      toolName,
      calls,
      grade: null,
      signals: null,
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

  const values: Record<SignalKey, number> = {
    silentFailureRate: silent / calls,
    errorRate: errors / calls,
    thrashEpisodes: thrash,
    p95LatencyMs: percentile(durations, 0.95),
  };

  const signals = Object.fromEntries(
    (Object.keys(values) as SignalKey[]).map((key) => [key, { value: values[key], grade: letterFor(values[key], THRESHOLDS[key]) }]),
  ) as Record<SignalKey, SignalResult>;

  const grade = worst(Object.values(signals).map((s) => s.grade));
  const keys = Object.keys(signals) as SignalKey[];
  const drivers = grade === 'A' ? [] : keys.filter((key) => signals[key].grade === grade);
  const describe = (key: SignalKey) => `${SIGNAL_LABELS[key]} ${formatValue(key, signals[key].value)} (${signals[key].grade})`;

  const lead =
    drivers.length === 0
      ? `Grade A: every signal is within its A threshold.`
      : `Grade ${grade}, set by ${drivers.map(describe).join(' and ')}.`;
  const others = keys.filter((key) => !drivers.includes(key)).map(describe);
  const explanation = [
    lead,
    others.length > 0 && drivers.length > 0 ? `Other signals: ${others.join(', ')}.` : `Signals: ${others.join(', ')}.`,
    `Based on the last ${calls} calls in the buffer. The grade is the worst of the four signal grades (see docs/health-grades.md).`,
  ].join(' ');

  return { toolName, calls, grade, signals, drivers, explanation };
}

/** One-line reason for the table's "Why" column. */
export function shortReason(health: ToolHealth): string {
  if (health.grade === null || !health.signals) return `Needs ${MIN_CALLS}+ calls`;
  if (health.drivers.length === 0) return 'All signals healthy';
  return health.drivers.map((key) => `${SIGNAL_LABELS[key]} ${formatValue(key, health.signals![key].value)}`).join(', ');
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
