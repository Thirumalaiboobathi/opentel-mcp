import './App.css';
import { Sidebar } from './components/Sidebar';
import { EmptyState } from './components/EmptyState';

/**
 * Step 4 scope: shell only. Fixed left sidebar, main content area, no
 * top bar. Step 5 replaces <EmptyState /> with the observation matrix,
 * silent-failure feed, and detector status banner once spans exist.
 */
export function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <EmptyState />
      </main>
    </div>
  );
}
