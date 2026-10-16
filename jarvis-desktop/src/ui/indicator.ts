import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A sliding selection indicator (rail and tabs). Measures the active element inside a container and returns its offset
 * and size, so CSS can move one indicator element with a transform and a spring easing. Measuring happens on change and
 * on resize only, never per frame. With nothing active the indicator is hidden. Server rendering returns null.
 */
export type IndicatorBox = { x: number; y: number; w: number; h: number } | null;

export function useIndicator<T extends HTMLElement>(selector: string, key: unknown): [RefObject<T | null>, IndicatorBox] {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState<IndicatorBox>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return undefined;
    const measure = () => {
      const el = host.querySelector<HTMLElement>(selector);
      if (!el) return setBox(null);
      const hr = host.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const next = { x: er.left - hr.left + host.scrollLeft, y: er.top - hr.top + host.scrollTop, w: er.width, h: er.height };
      setBox((prev) => (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [selector, key]);
  return [ref, box];
}
