import { useState } from 'react';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { EmptyState } from './components/EmptyState';
import { ConnectScreen } from './components/ConnectScreen';
import { ObservationMatrix } from './components/ObservationMatrix';
import { SilentFailureFeed } from './components/SilentFailureFeed';
import { DetectorBanner } from './components/DetectorBanner';
import { HeroStat } from './components/HeroStat';
import { ToolHealth } from './components/ToolHealth';
import { Operations } from './components/Operations';
import { useDashboardData } from './data/useDashboardData';
import { matrixCountsFromSummary, type MatrixCell } from './data/classify';
import { isToolCallSpan } from './data/method';

export function App() {
  const { spans, summary, meta } = useDashboardData();
  const [selectedCell, setSelectedCell] = useState<MatrixCell | null>(null);

  // Any span at all means a server is connected (leave the connect
  // screen); only tools/call spans feed the tool views below.
  const hasSpans = spans.length > 0;
  const toolSpans = spans.filter(isToolCallSpan);
  const counts = matrixCountsFromSummary(summary);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {hasSpans ? (
          <>
            <HeroStat counts={counts} />
            <DetectorBanner meta={meta} />
            <ObservationMatrix counts={counts} meta={meta} selectedCell={selectedCell} onSelectCell={setSelectedCell} />
            <ToolHealth spans={toolSpans} />
            <Operations spans={spans} />
            <SilentFailureFeed spans={toolSpans} selectedCell={selectedCell} />
          </>
        ) : meta && !meta.demo ? (
          // Live (non-demo) instance, nothing received yet. Switches to the
          // dashboard above on the first SSE span -- no reload.
          <ConnectScreen origin={window.location.origin} />
        ) : (
          // /api/meta not loaded yet (or a demo with an empty fixture).
          <EmptyState />
        )}
      </main>
    </div>
  );
}
