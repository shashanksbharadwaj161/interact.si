import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BubbleEdge } from '../surfaces';
import { EASE, MOTION, createRectAnimator, seedRect, type Clock, type FrameSample, type Rect, type Side } from './motion';

/*
 * The production island shell: the smoked-glass shape the companion's surfaces live in. Used by the desktop island
 * (CompanionApp), the direction board and the island review journey, so all three show the same component.
 *
 * - The glass (`.isl-skin`) carries no text. It grows out of a small capsule beside the character, changes shape
 *   between states, and returns there on close. Its size is set directly (no scale), so its corners stay round.
 * - Content is laid out at its final size, revealed through a clip that follows the glass, and crossfaded between
 *   states. Letters are never stretched.
 * - Every move starts from the shape as it is drawn now, so opening and then closing before the opening finished (or
 *   any rapid change of state) continues smoothly instead of jumping.
 * - The shell stays mounted until its close animation ends, then calls onClosed: only then should the page ask the
 *   main process to shrink the window (api.layout({bubble: null})), so the exit is never clipped.
 * - While it changes size between two open states it reports the larger of the two sizes, so the window holds the whole
 *   morph; once settled it reports the exact size.
 * - The perimeter light (`edge`) comes from the caller's real state. Decorative layers never take pointer events.
 *
 * Coordinates are window-local px, the same space as the main process's placement push (placement.bubble). The main
 * process may round the window by a few px at fractional DPI; the shell follows whatever box it is given and never
 * assumes the requested size was granted exactly.
 * Styles: src/styles/companion-bubble.css (`.cd.isl`).
 */

export type IslandShellProps = {
  open: boolean;
  /** Which content is shown. A new key crossfades to the new content and morphs the glass to its size. */
  view: string;
  /** Where the bubble may draw, in window-local px (placement.bubble). Null until the main process has placed it. */
  box: Rect | null;
  side: Side;
  edge: BubbleEdge;
  /** Restarts the one-shot "done" trace (for example the id of the verified change). */
  edgeKey?: string | number;
  label: string;
  reducedMotion?: boolean;
  /** Natural size of the content (during a morph, the larger of old and new). The page passes it to api.layout. */
  onContentSize?: (size: { width: number; height: number }) => void;
  /** The close animation finished (or was skipped): shrink the native window and release focus now. */
  onClosed?: () => void;
  /** Where the content is (window-local px) while open, for the page's hit test; null once closed. */
  onRect?: (r: Rect | null) => void;
  /** Frame timing while the glass moves, for the review journey's frame report. */
  onFrame?: (s: FrameSample & { phase: 'open' | 'morph' | 'close' }) => void;
  clock?: Clock;
  children: ReactNode;
};

type Layer = { view: string; node: ReactNode };
type Size = { width: number; height: number };
const RADIUS = 22;

/** The content's rectangle inside the box: pinned to the corner nearest the character, at most the box's size. */
export function contentRect(box: Rect, size: Size | null, side: Side): Rect {
  const width = Math.min(size?.width ?? box.width, box.width);
  const height = Math.min(size?.height ?? box.height, box.height);
  const right = box.x + box.width - width;
  const bottom = box.y + box.height - height;
  const centre = box.x + (box.width - width) / 2;
  switch (side) {
    case 'left': return { x: right, y: bottom, width, height };
    case 'right': return { x: box.x, y: bottom, width, height };
    case 'above': return { x: centre, y: bottom, width, height };
    case 'below': return { x: centre, y: box.y, width, height };
    default: return { x: centre, y: box.y, width, height };
  }
}

export function IslandShell(p: IslandShellProps) {
  const skin = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(p.open);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  shownRef.current = shown;
  const [size, setSize] = useState<Size | null>(null);
  const [tailOn, setTailOn] = useState(false);
  const [, setFaded] = useState(0);
  const props = useRef(p);
  props.current = p;
  const sizeRef = useRef<Size | null>(null);
  const phase = useRef<'open' | 'morph' | 'close'>('open');
  const contentAt = useRef<Rect | null>(null);
  /** Each move's completion acts only if no later move replaced it (a replaced move resolves at once). */
  const moveSeq = useRef(0);

  // The previous state's content stays visible (inert) while the new one fades in. `live` is the last committed layer.
  const live = useRef<Layer>({ view: p.view, node: p.children });
  const out = useRef<Layer | null>(null);
  if (live.current.view !== p.view && out.current?.view !== live.current.view) out.current = live.current;
  useLayoutEffect(() => {
    live.current = { view: p.view, node: p.children };
  });

  const animator = useRef<ReturnType<typeof createRectAnimator> | null>(null);
  if (!animator.current) {
    animator.current = createRectAnimator({
      initial: { x: 0, y: 0, width: 0, height: 0 },
      clock: p.clock,
      apply: (r) => {
        const s = skin.current;
        if (s) {
          s.style.transform = `translate(${r.x}px, ${r.y}px)`;
          s.style.width = `${Math.max(0, r.width)}px`;
          s.style.height = `${Math.max(0, r.height)}px`;
        }
        // The content is only translated and clipped, never scaled. Its top edge rides the glass's top edge while the
        // glass is shorter than the content (growing upward from the character), so the title and the controls stay
        // where they were drawn and what is visible is exactly what can be clicked.
        const st = stage.current;
        const c = contentAt.current;
        if (st && c) {
          const y = c.y + Math.max(0, r.y - c.y);
          st.style.transform = `translate(${c.x}px, ${y}px)`;
          const top = r.y - y, left = r.x - c.x;
          const right = c.x + c.width - (r.x + r.width), bottom = y + c.height - (r.y + r.height);
          st.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(0, right)}px ${Math.max(0, bottom)}px ${Math.max(0, left)}px round ${RADIUS}px)`;
        }
      },
      onFrame: (s) => props.current.onFrame?.({ ...s, phase: phase.current }),
    });
  }
  const anim = animator.current;

  useEffect(() => {
    if (p.open) setMounted(true);
  }, [p.open]);

  // Report the content's natural size; while the glass is moving between two sizes, report the larger.
  useLayoutEffect(() => {
    const st = stage.current;
    if (!mounted || !st) return undefined;
    const body = () => st.querySelector<HTMLElement>('[data-isl-layer="in"]');
    const report = () => {
      const el = body();
      if (!el) return;
      const next = { width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight) };
      const prev = sizeRef.current;
      if (prev && prev.width === next.width && prev.height === next.height) return;
      sizeRef.current = next;
      setSize(next);
      // Already open and placed: the glass will morph from the old size, so keep room for both until it settles.
      const reserve = prev && shownRef.current ? { width: Math.max(prev.width, next.width), height: Math.max(prev.height, next.height) } : next;
      props.current.onContentSize?.(reserve);
    };
    report();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(report);
    const el = body();
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [mounted, p.view, anim]);

  // Shape: open from the capsule beside the character, morph between states, close back to the capsule.
  useEffect(() => {
    if (!mounted) return;
    const box = p.box;
    const reduced = p.reducedMotion === true;
    if (p.open && box) {
      const fromClosed = !shown;
      const target = contentRect(box, size, p.side);
      contentAt.current = target;
      if (fromClosed && !anim.moving) anim.jump(seedRect(box, p.side));
      if (fromClosed) setShown(true);
      const cur = anim.rect;
      // The window moved under an unchanged shape (the main process rebased local coordinates): follow without animating.
      if (!fromClosed && !anim.moving && Math.abs(cur.width - target.width) < 1 && Math.abs(cur.height - target.height) < 1) {
        ++moveSeq.current;
        anim.jump(target);
        setTailOn(true);
        return;
      }
      phase.current = fromClosed ? 'open' : 'morph';
      setTailOn(false);
      const seq = ++moveSeq.current;
      void anim.to(target, reduced ? 0 : fromClosed ? MOTION.expand : MOTION.morph, fromClosed ? EASE.out : EASE.inOut).then(() => {
        if (seq !== moveSeq.current || !props.current.open) return;
        setTailOn(true);
        // Settled: report the exact size so the window can shrink to it.
        const m = sizeRef.current;
        if (m) props.current.onContentSize?.(m);
      });
      return;
    }
    if (!p.open) {
      setTailOn(false);
      if (!shown) {
        setMounted(false);
        props.current.onClosed?.();
        return;
      }
      // Already closing toward the same capsule: let that move finish rather than restarting it.
      if (phase.current === 'close' && anim.moving) return;
      phase.current = 'close';
      const end = seedRect(box ?? anim.rect, p.side);
      const seq = ++moveSeq.current;
      void anim.to(end, reduced ? 0 : MOTION.collapse, EASE.in).then(() => {
        if (seq !== moveSeq.current || props.current.open) return;
        setShown(false);
        setMounted(false);
        sizeRef.current = null;
        setSize(null);
        out.current = null;
        props.current.onClosed?.();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, p.open, p.box?.x, p.box?.y, p.box?.width, p.box?.height, p.side, size?.width, size?.height, p.reducedMotion]);

  // The outgoing layer leaves after one crossfade.
  useEffect(() => {
    if (!out.current) return undefined;
    const t = window.setTimeout(() => {
      out.current = null;
      setFaded((n) => n + 1);
    }, p.reducedMotion ? 0 : MOTION.fade);
    return () => window.clearTimeout(t);
  }, [p.view, p.reducedMotion]);

  useEffect(() => () => anim.stop(), [anim]);

  const boxNow = p.box;
  const atNow = boxNow ? contentRect(boxNow, size, p.side) : null;
  useEffect(() => {
    props.current.onRect?.(mounted && shown && atNow ? atNow : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, shown, atNow?.x, atNow?.y, atNow?.width, atNow?.height]);

  if (!mounted) return null;
  const box = p.box;
  const at = box ? contentRect(box, size, p.side) : null;
  const outgoing = out.current && out.current.view !== p.view ? out.current : null;
  return (
    <section className="isl cd" data-open={p.open ? 'true' : 'false'} data-edge={p.edge} data-side={p.side} data-placed={box && shown ? 'true' : 'false'} aria-label={p.label}>
      <div ref={skin} className="isl-skin" aria-hidden>
        <span className="cd-edge" key={p.edge === 'done' ? `done-${p.edgeKey ?? ''}` : p.edge} />
      </div>
      {at && <span className="isl-tail" data-visible={tailOn && p.open ? 'true' : 'false'} aria-hidden style={tailStyle(at, p.side)} />}
      <div ref={stage} className="isl-stage" data-measuring={at ? undefined : 'true'}>
        {outgoing && (
          <div className="isl-layer" data-isl-layer="out" inert aria-hidden key={`out-${outgoing.view}`}>
            {outgoing.node}
          </div>
        )}
        <div className="isl-layer" data-isl-layer="in" data-isl-view={p.view} data-open={p.open ? 'true' : 'false'} key={`in-${p.view}`}>
          {p.children}
        </div>
      </div>
    </section>
  );
}

/** The tail sits on the edge facing the character, near the capsule the island grows from. */
function tailStyle(r: Rect, side: Side): CSSProperties {
  switch (side) {
    case 'left': return { transform: `translate(${r.x + r.width - 9}px, ${r.y + r.height - 40}px) rotate(135deg)` };
    case 'right': return { transform: `translate(${r.x - 7}px, ${r.y + r.height - 40}px) rotate(-45deg)` };
    case 'above': return { transform: `translate(${r.x + r.width / 2 - 8}px, ${r.y + r.height - 9}px) rotate(-135deg)` };
    case 'below': return { transform: `translate(${r.x + r.width / 2 - 8}px, ${r.y - 7}px) rotate(45deg)` };
    default: return { display: 'none' };
  }
}
