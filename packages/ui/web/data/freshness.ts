import type { SerializedSpan } from '../../src/types.d.ts';

/**
 * opentel-mcp core's ADR 027 span attributes (core 0.17.0+). Set only on a
 * successful tools/call whose tool reported freshness in its result
 * `_meta`; older cores never set them, and then the UI shows no staleness
 * UI at all rather than a misleading "0 stale".
 */
export const ATTR_FRESHNESS_VERDICT = 'mcp.tool.freshness.verdict';
export const ATTR_FRESHNESS_DATA_AGE_MS = 'mcp.tool.freshness.data_age_ms';
export const ATTR_FRESHNESS_MAX_AGE_MS = 'mcp.tool.freshness.max_age_ms';

export type FreshnessVerdict = 'fresh' | 'stale' | 'unknown';

export interface Freshness {
  verdict: FreshnessVerdict;
  /** Absent when the tool's asOf couldn't be read. */
  dataAgeMs?: number;
  /** The effective window; absent when the verdict is unknown. */
  maxAgeMs?: number;
}

const VERDICTS: readonly string[] = ['fresh', 'stale', 'unknown'];

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The span's freshness, or null when it carries none (or an unrecognized value). */
export function getFreshness(span: SerializedSpan): Freshness | null {
  const verdict = span.attributes?.[ATTR_FRESHNESS_VERDICT];
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) return null;
  return {
    verdict: verdict as FreshnessVerdict,
    dataAgeMs: finite(span.attributes[ATTR_FRESHNESS_DATA_AGE_MS]),
    maxAgeMs: finite(span.attributes[ATTR_FRESHNESS_MAX_AGE_MS]),
  };
}

export function isStale(span: SerializedSpan): boolean {
  return getFreshness(span)?.verdict === 'stale';
}

/** Whether any span carries a freshness verdict at all (core 0.17.0+, and a tool that opted in). */
export function hasFreshnessSignal(spans: SerializedSpan[]): boolean {
  return spans.some((s) => getFreshness(s) !== null);
}

/**
 * Compact human duration: "850ms", "5s", "4m", "1h 20m", "3d". One or two
 * units, never more -- it sits inside a pill.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** "data 4m old · limit 5s" -- the detected side of a stale row. */
export function describeStaleness(f: Freshness): string {
  const age = f.dataAgeMs !== undefined ? `data ${formatAge(f.dataAgeMs)} old` : 'data age unknown';
  return f.maxAgeMs !== undefined ? `${age} · limit ${formatAge(f.maxAgeMs)}` : age;
}
