// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';

/**
 * A real, rendered-DOM smoke test for the acceptance criteria this
 * environment has no browser to check visually: "Dev server runs, theme
 * toggle works, empty state renders." This can't substitute for actually
 * looking at it (see RUNLOG/HANDOFF for that caveat, stated plainly, not
 * glossed over), but it's a stronger signal than "the build succeeded" --
 * it renders the real component tree into jsdom and asserts on the
 * resulting DOM and the real click handler's effect.
 */

// React 19 requires this flag set explicitly outside of a framework (like
// React Testing Library) that sets it for you -- otherwise act() warns
// even though it's being used correctly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

function renderApp() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
  });
  return container;
}

describe('App shell', () => {
  it('renders the empty state (no panels exist yet -- Step 4 scope)', () => {
    const el = renderApp();
    expect(el.textContent).toContain('Waiting for spans');
  });

  it('renders a fixed sidebar with branding and a theme toggle', () => {
    const el = renderApp();
    expect(el.querySelector('.sidebar')).not.toBeNull();
    expect(el.textContent).toContain('opentel-mcp');
    expect(el.querySelector('.theme-toggle')).not.toBeNull();
  });

  it('DARK-FIRST: defaults to dark theme with no saved preference', () => {
    renderApp();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('theme toggle actually flips data-theme and persists it', () => {
    const el = renderApp();
    const toggle = el.querySelector<HTMLButtonElement>('.theme-toggle')!;

    act(() => toggle.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('opentel-mcp-ui:theme')).toBe('light');

    act(() => toggle.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('respects a previously-saved theme preference on next load', () => {
    window.localStorage.setItem('opentel-mcp-ui:theme', 'light');
    renderApp();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
