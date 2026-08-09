// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VirtualizedList } from './VirtualizedList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/**
 * ACCEPTANCE: "List stays smooth with a full 1,000-span buffer." Not
 * measurable as a frame-rate number in this environment (no browser),
 * but the mechanism that WOULD make it smooth is directly verifiable:
 * regardless of item count, only a small, bounded number of rows are
 * ever actually in the DOM at once. If virtualization broke and this
 * rendered all 1,000 rows, this test would fail.
 */
describe('VirtualizedList', () => {
  it('renders only a small window of DOM nodes for 1,000 items, not all of them', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <VirtualizedList
          items={items}
          itemHeight={96}
          height={480}
          renderItem={(item) => <div className="row">{item}</div>}
        />,
      );
    });

    const renderedRows = container.querySelectorAll('.row').length;
    // height 480 / itemHeight 96 = 5 visible rows, plus overscan on both
    // sides -- generously bounded well below 1000 either way.
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(50);
  });

  it('the scrollable container height is fixed regardless of item count (the viewport, not the content, is what "480" means)', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(<VirtualizedList items={items} itemHeight={96} height={480} renderItem={(item) => <div>{item}</div>} />);
    });

    const list = container.querySelector('.virtualized-list') as HTMLElement;
    expect(list.style.height).toBe('480px');
  });

  it('renders the empty state when there are no items', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <VirtualizedList items={[]} itemHeight={96} height={480} renderItem={(item) => <div>{String(item)}</div>} emptyState={<p>nothing here</p>} />,
      );
    });

    expect(container.textContent).toContain('nothing here');
  });
});
