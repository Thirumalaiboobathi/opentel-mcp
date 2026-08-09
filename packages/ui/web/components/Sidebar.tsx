import { useTheme } from '../theme/ThemeProvider';

/**
 * Fixed left sidebar, no top bar (per the design brief). Step 4 scope is
 * shell-only -- no panel navigation exists yet (Step 5 adds the matrix/
 * feed), so this only carries branding and the theme toggle. Collapses
 * to icon-only-width at the tablet breakpoint (see App.css).
 */
export function Sidebar() {
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true">
          ●
        </span>
        <span className="sidebar-wordmark">opentel-mcp</span>
      </div>

      <div className="sidebar-spacer" />

      <button
        type="button"
        className="theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '☾ Dark' : '☀ Light'}
      </button>
    </aside>
  );
}
