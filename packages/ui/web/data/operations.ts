import type { SerializedSpan } from '../../src/types.d.ts';
import { spanMethod } from './method';

/** The resource/prompt methods opentel-mcp core can trace (opt-in `coverage`, core 0.16.0+). */
export const OPERATION_METHODS = [
  'resources/read',
  'resources/list',
  'resources/templates/list',
  'prompts/get',
  'prompts/list',
] as const;

export interface OperationRow {
  method: string;
  /** The prompt name for prompts/get; undefined otherwise (URIs are never captured). */
  target?: string;
  calls: number;
  failures: number;
  /** error.type values seen on failures, most frequent first. */
  errorTypes: string[];
}

/**
 * Groups resources/* and prompts/* spans by method (and prompt name for
 * prompts/get). Tool calls and anything else are ignored. Sorted by
 * failures, then calls, descending.
 */
export function summarizeOperations(spans: SerializedSpan[]): OperationRow[] {
  const rows = new Map<string, OperationRow & { errorCounts: Map<string, number> }>();
  for (const span of spans) {
    const method = spanMethod(span);
    if (!method || !(OPERATION_METHODS as readonly string[]).includes(method)) continue;
    const promptName = span.attributes?.['gen_ai.prompt.name'];
    const target = method === 'prompts/get' && typeof promptName === 'string' ? promptName : undefined;
    const key = `${method}\u0000${target ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      row = { method, target, calls: 0, failures: 0, errorTypes: [], errorCounts: new Map() };
      rows.set(key, row);
    }
    row.calls++;
    if (span.status === 'ERROR') {
      row.failures++;
      const type = span.errorType ?? 'error';
      row.errorCounts.set(type, (row.errorCounts.get(type) ?? 0) + 1);
    }
  }
  return [...rows.values()]
    .map(({ errorCounts, ...row }) => ({
      ...row,
      errorTypes: [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type),
    }))
    .sort((a, b) => b.failures - a.failures || b.calls - a.calls || a.method.localeCompare(b.method));
}
