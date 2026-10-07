import {useCallback, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent} from 'react';
import {motion, useInView} from 'motion/react';

/*
 * ReactBits AnimatedList, adapted for Tally: items are any React node
 * (renderItem), the edge fades use the light surface, and arrow keys work only
 * while the list itself has focus, so Tab keeps moving through the page.
 */

function AnimatedItem({children, delay = 0, index, onMouseEnter, onClick}: {
  children: ReactNode; delay?: number; index: number; onMouseEnter?: () => void; onClick?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, {amount: 0.4, once: true});
  return (
    <motion.div
      ref={ref}
      data-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      initial={{scale: 0.96, opacity: 0}}
      animate={inView ? {scale: 1, opacity: 1} : {scale: 0.96, opacity: 0}}
      transition={{duration: 0.22, delay}}
      className={onClick ? 'cursor-pointer' : undefined}
    >
      {children}
    </motion.div>
  );
}

export default function AnimatedList<T>({items, renderItem, onItemSelect, className = '', maxHeight = 420, showGradients = true, label}: {
  items: T[];
  renderItem: (item: T, index: number, selected: boolean) => ReactNode;
  onItemSelect?: (item: T, index: number) => void;
  className?: string;
  maxHeight?: number;
  showGradients?: boolean;
  label?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(-1);
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(1);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const {scrollTop, scrollHeight, clientHeight} = e.currentTarget;
    setTop(Math.min(scrollTop / 50, 1));
    const rest = scrollHeight - (scrollTop + clientHeight);
    setBottom(scrollHeight <= clientHeight ? 0 : Math.min(rest / 50, 1));
  };

  const reveal = useCallback((index: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(selected + 1, items.length - 1) : Math.max(selected - 1, 0);
      setSelected(next);
      reveal(next);
    } else if (e.key === 'Enter' && selected >= 0 && onItemSelect) {
      e.preventDefault();
      onItemSelect(items[selected], selected);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <div
        ref={listRef}
        role="list"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        className="overflow-y-auto outline-none [scrollbar-width:thin]"
        style={{maxHeight}}
      >
        {items.map((item, index) => (
          <AnimatedItem
            key={index}
            index={index}
            delay={Math.min(index, 8) * 0.03}
            onMouseEnter={() => setSelected(index)}
            onClick={onItemSelect ? () => { setSelected(index); onItemSelect(item, index); } : undefined}
          >
            <div role="listitem">{renderItem(item, index, selected === index)}</div>
          </AnimatedItem>
        ))}
      </div>
      {showGradients && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white to-transparent transition-opacity" style={{opacity: top}} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white to-transparent transition-opacity" style={{opacity: bottom}} />
        </>
      )}
    </div>
  );
}
