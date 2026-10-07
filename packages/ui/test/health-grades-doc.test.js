/**
 * Keeps docs/health-grades.md honest: the table there is regenerated here
 * from the constants in web/data/healthGrades.ts and must match row for
 * row. Change a threshold in one place without the other and this fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THRESHOLDS, MIN_CALLS } from '../web/data/healthGrades.ts';

const DOC = readFileSync(fileURLToPath(new URL('../../../docs/health-grades.md', import.meta.url)), 'utf8');

const ROW_LABELS = {
  silentFailureRate: 'Silent-failure rate',
  errorRate: 'Error rate',
  thrashEpisodes: 'Thrash episodes',
  p95LatencyMs: 'p95 latency',
};

const formatPercent = (v) => `${Math.round(v * 100)}%`;
const formatSeconds = (ms) => `${ms / 1000} s`;

/** Cells for a continuous signal: "< x" per letter, "≥ x" where the range ends, "—" when unreachable. */
function continuousCells(bounds, format) {
  const cells = bounds.map((bound, i) => {
    if (Number.isFinite(bound)) return `< ${format(bound)}`;
    const previous = bounds[i - 1];
    return i > 0 && Number.isFinite(previous) ? `≥ ${format(previous)}` : '—';
  });
  const last = bounds[bounds.length - 1];
  cells.push(Number.isFinite(last) ? `≥ ${format(last)}` : '—');
  return cells;
}

/** Cells for an integer count: each letter covers [previous bound, bound). */
function countCells(bounds) {
  const cells = bounds.map((hi, i) => {
    const lo = i === 0 ? 0 : bounds[i - 1];
    if (hi <= lo) return '—';
    return hi - lo === 1 ? String(lo) : `${lo}–${hi - 1}`;
  });
  cells.push(`≥ ${bounds[bounds.length - 1]}`);
  return cells;
}

function expectedCells(key) {
  if (key === 'thrashEpisodes') return countCells(THRESHOLDS[key]);
  if (key === 'p95LatencyMs') return continuousCells(THRESHOLDS[key], formatSeconds);
  return continuousCells(THRESHOLDS[key], formatPercent);
}

/** The documented A..F cells for a row, by its first-column label. */
function documentedCells(label) {
  const line = DOC.split('\n').find((l) => l.startsWith(`| ${label} |`));
  expect(line, `docs/health-grades.md has no table row for "${label}"`).toBeDefined();
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  // label, how it's computed, then A..F
  return cells.slice(2);
}

describe('docs/health-grades.md matches web/data/healthGrades.ts', () => {
  for (const key of Object.keys(THRESHOLDS)) {
    it(`${ROW_LABELS[key]} row matches THRESHOLDS.${key}`, () => {
      expect(documentedCells(ROW_LABELS[key])).toEqual(expectedCells(key));
    });
  }

  it('documents every signal the code grades, and no others', () => {
    expect(Object.keys(ROW_LABELS).sort()).toEqual(Object.keys(THRESHOLDS).sort());
  });

  it(`states the minimum sample (${MIN_CALLS} calls)`, () => {
    expect(DOC).toContain(`fewer than ${MIN_CALLS} calls`);
    expect(DOC).toContain(`needs at least ${MIN_CALLS}`);
  });
});
