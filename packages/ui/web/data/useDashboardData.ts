import { useEffect, useRef, useState } from 'react';
import type { SerializedSpan } from 'opentel-mcp-contract';
import type { MetaResponse, SummaryResponse } from './types';

export interface DashboardData {
  spans: SerializedSpan[];
  summary: SummaryResponse | null;
  meta: MetaResponse | null;
  connected: boolean;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Owns all data this dashboard renders: the live span feed (initial
 * history + SSE), and /api/summary + /api/meta. Refetches /api/summary
 * whenever a new span arrives (rather than recomputing bucket counts
 * client-side) so the matrix always reflects the backend's own
 * authoritative buffer state -- see classify.ts's docblock for why. Uses
 * the browser's native EventSource, which already sends `Last-Event-ID`
 * on reconnect -- server.js's SSE route (Step 3) already replays from
 * the buffer for that header, so reconnection needs no extra client code.
 */
export function useDashboardData(): DashboardData {
  const [spans, setSpans] = useState<SerializedSpan[]>([]);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const capacityRef = useRef(1000);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      const [history, initialSummary, initialMeta] = await Promise.all([
        fetchJson<{ spans: SerializedSpan[]; capacity: number; size: number }>('/api/spans/history'),
        fetchJson<SummaryResponse>('/api/summary'),
        fetchJson<MetaResponse>('/api/meta'),
      ]);
      if (cancelled) return;
      capacityRef.current = history.capacity;
      setSpans(history.spans);
      setSummary(initialSummary);
      setMeta(initialMeta);
    }

    loadInitial().catch((err) => console.error('opentel-mcp-ui: failed to load initial dashboard data', err));

    const source = new EventSource('/api/spans');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const span = JSON.parse(event.data) as SerializedSpan;
      setSpans((prev) => {
        const next = [...prev, span];
        return next.length > capacityRef.current ? next.slice(next.length - capacityRef.current) : next;
      });
      fetchJson<SummaryResponse>('/api/summary')
        .then((s) => {
          if (!cancelled) setSummary(s);
        })
        .catch((err) => console.error('opentel-mcp-ui: failed to refresh /api/summary', err));
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return { spans, summary, meta, connected };
}
