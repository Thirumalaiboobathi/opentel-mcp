import type { SerializedSpan } from '../../src/types.d.ts';
import { isToolCallSpan } from './method';

/**
 * Derives the Security panel (ADR 033) from spans the dashboard already holds. Reads only the opentel-mcp core
 * 0.18.0 security attributes and whitelisted events; older cores set none of them, and then {@link
 * deriveSecurity} reports nothing and the panel is not rendered. Everything returned is plain data: the panel
 * renders it as text only.
 */

export const ATTR_SECRET_LEAK_DETECTED = 'mcp.tool.secret_leak.detected';
export const ATTR_SECRET_LEAK_TYPES = 'mcp.tool.secret_leak.types';
export const ATTR_CLOCK_SKEW_MS = 'mcp.tool.freshness.clock_skew_ms';
export const ATTR_SENSITIVE = 'mcp.tool.sensitive';
const EVENT_AUDIT = 'mcp.audit.sensitive_call';
const TOOL = 'gen_ai.tool.name';

/** At least this many auth failures for one tool within {@link BURST_WINDOW_MS} is a burst. Not configurable. */
export const BURST_THRESHOLD = 5;
export const BURST_WINDOW_MS = 60_000;

export type IntegrityKind = 'changed' | 'pin_mismatch' | 'added' | 'removed';

export interface IntegrityFinding {
  kind: IntegrityKind;
  tool: string;
  /** Old hash (changed/removed) or expected hash (pin_mismatch). */
  before?: string;
  /** New hash (changed/added) or actual hash (pin_mismatch). */
  after?: string;
  atMs: number;
}
export interface LeakRow {
  tool: string;
  calls: number;
  types: string[];
}
export interface AuthRow {
  tool: string;
  failures: number;
  burst: boolean;
}
export interface SensitiveRow {
  tool: string;
  success: number;
  silentFailure: number;
  error: number;
}
export interface SkewRow {
  tool: string;
  calls: number;
  maxMs: number;
}
export interface SecurityData {
  integrity: IntegrityFinding[];
  leaks: LeakRow[];
  auth: AuthRow[];
  sensitive: SensitiveRow[];
  skew: SkewRow[];
  /** False when no span carries any security signal (then the panel renders nothing). */
  any: boolean;
}

const MAX_TOOL_LENGTH = 128;
const SECRET_TYPE = /^[a-z_]{1,32}$/;
const INTEGRITY_KINDS: Record<string, IntegrityKind> = {
  'mcp.tool.integrity.changed': 'changed',
  'mcp.tool.integrity.pin_mismatch': 'pin_mismatch',
  'mcp.tool.integrity.added': 'added',
  'mcp.tool.integrity.removed': 'removed',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const toolOf = (span: SerializedSpan): string => (span.toolName ?? 'unknown').slice(0, MAX_TOOL_LENGTH);

/** First 12 characters of the hash after its `sha256:` prefix. The full hash is never shown. */
export function hashPrefix(hash: string | undefined): string {
  if (!hash) return '—';
  const body = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return body.slice(0, 12);
}

/** True when `times` (sorted ascending) has {@link BURST_THRESHOLD} entries inside one {@link BURST_WINDOW_MS} window. */
export function hasBurst(times: number[]): boolean {
  for (let i = 0; i + BURST_THRESHOLD - 1 < times.length; i++) {
    if ((times[i + BURST_THRESHOLD - 1] ?? Infinity) - (times[i] ?? 0) <= BURST_WINDOW_MS) return true;
  }
  return false;
}

export function deriveSecurity(spans: SerializedSpan[]): SecurityData {
  const integrity: IntegrityFinding[] = [];
  const leaks = new Map<string, { calls: number; types: Set<string> }>();
  const authTimes = new Map<string, number[]>();
  const sensitive = new Map<string, SensitiveRow>();
  const skew = new Map<string, SkewRow>();

  for (const span of spans) {
    const attrs = span.attributes ?? {};
    for (const event of span.events ?? []) {
      const a = event.attributes ?? {};
      const kind = INTEGRITY_KINDS[event.name];
      if (kind) {
        const before = kind === 'pin_mismatch' ? str(a['mcp.tool.integrity.expected_hash']) : str(a['mcp.tool.integrity.old_hash']);
        const after = kind === 'pin_mismatch' ? str(a['mcp.tool.integrity.actual_hash']) : str(a['mcp.tool.integrity.new_hash']);
        integrity.push({ kind, tool: (str(a[TOOL]) ?? 'unknown').slice(0, MAX_TOOL_LENGTH), before, after, atMs: num(event.timeMs) ?? span.startTimeMs });
      } else if (event.name === EVENT_AUDIT) {
        const tool = (str(a[TOOL]) ?? toolOf(span)).slice(0, MAX_TOOL_LENGTH);
        const row = sensitive.get(tool) ?? { tool, success: 0, silentFailure: 0, error: 0 };
        const outcome = str(a['mcp.tool.outcome']);
        if (outcome === 'success') row.success++;
        else if (outcome === 'silent_failure') row.silentFailure++;
        else if (outcome === 'error') row.error++;
        else continue;
        sensitive.set(tool, row);
      }
    }

    if (!isToolCallSpan(span)) continue;
    const tool = toolOf(span);

    if (attrs[ATTR_SECRET_LEAK_DETECTED] === true) {
      const row = leaks.get(tool) ?? { calls: 0, types: new Set<string>() };
      row.calls++;
      const types = attrs[ATTR_SECRET_LEAK_TYPES];
      for (const t of Array.isArray(types) ? types : []) {
        if (typeof t === 'string') row.types.add(SECRET_TYPE.test(t) ? t : 'other');
      }
      leaks.set(tool, row);
    }

    if (span.failureCategory === 'auth' && span.status === 'ERROR') {
      const list = authTimes.get(tool) ?? [];
      list.push(span.startTimeMs);
      authTimes.set(tool, list);
    }

    const skewMs = num(attrs[ATTR_CLOCK_SKEW_MS]);
    if (skewMs !== undefined && skewMs > 0) {
      const row = skew.get(tool) ?? { tool, calls: 0, maxMs: 0 };
      row.calls++;
      row.maxMs = Math.max(row.maxMs, skewMs);
      skew.set(tool, row);
    }
  }

  integrity.sort((a, b) => b.atMs - a.atMs);
  const auth: AuthRow[] = [...authTimes.entries()]
    .map(([tool, times]) => ({ tool, failures: times.length, burst: hasBurst([...times].sort((a, b) => a - b)) }))
    .sort((a, b) => Number(b.burst) - Number(a.burst) || b.failures - a.failures || a.tool.localeCompare(b.tool));
  const leakRows: LeakRow[] = [...leaks.entries()]
    .map(([tool, v]) => ({ tool, calls: v.calls, types: [...v.types].sort() }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const sensitiveRows = [...sensitive.values()].sort(
    (a, b) => b.success + b.silentFailure + b.error - (a.success + a.silentFailure + a.error) || a.tool.localeCompare(b.tool),
  );
  const skewRows = [...skew.values()].sort((a, b) => b.maxMs - a.maxMs || a.tool.localeCompare(b.tool));

  return {
    integrity,
    leaks: leakRows,
    auth,
    sensitive: sensitiveRows,
    skew: skewRows,
    any: integrity.length + leakRows.length + auth.length + sensitiveRows.length + skewRows.length > 0,
  };
}
