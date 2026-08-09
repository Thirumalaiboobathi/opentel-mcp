import { useState } from 'react';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { EmptyState } from './components/EmptyState';
import { ObservationMatrix } from './components/ObservationMatrix';
import { SilentFailureFeed } from './components/SilentFailureFeed';
import { DetectorBanner } from './components/DetectorBanner';
import { useDashboardData } from './data/useDashboardData';
import { matrixCountsFromSummary, type MatrixCell } from './data/classify';

export function App() {
  const { spans, summary, meta } = useDashboardData();
  const [selectedCell, setSelectedCell] = useState<MatrixCell | null>(null);

  const hasSpans = spans.length > 0;
  const counts = matrixCountsFromSummary(summary);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {hasSpans ? (
          <>
            <DetectorBanner meta={meta} />
            <ObservationMatrix counts={counts} meta={meta} selectedCell={selectedCell} onSelectCell={setSelectedCell} />
            <SilentFailureFeed spans={spans} selectedCell={selectedCell} />
          </>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}
