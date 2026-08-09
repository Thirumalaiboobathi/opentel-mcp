import { useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: readonly T[];
  itemHeight: number;
  height: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  emptyState?: ReactNode;
}

/**
 * Fixed-row-height virtualization, hand-rolled rather than a dependency
 * (react-window et al.) -- this package's whole premise is a minimal
 * install, and a single windowing algorithm over a scroll position is a
 * small, well-understood amount of code, not worth a dependency for.
 * Renders only the rows in (and slightly around) the visible viewport,
 * regardless of how many `items` there are — this is what keeps the
 * silent-failure feed smooth at a full 1,000-span buffer.
 */
export function VirtualizedList<T>({ items, itemHeight, height, overscan = 6, renderItem, emptyState }: Props<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  if (items.length === 0 && emptyState) {
    return <div style={{ height }}>{emptyState}</div>;
  }

  const totalHeight = items.length * itemHeight;
  const visibleCount = Math.ceil(height / itemHeight);
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className="virtualized-list"
      style={{ height, overflowY: 'auto', position: 'relative' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visibleItems.map((item, i) => {
          const index = startIndex + i;
          return (
            <div key={index} style={{ position: 'absolute', top: index * itemHeight, left: 0, right: 0, height: itemHeight }}>
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
