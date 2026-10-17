import { useEffect, useRef, type CSSProperties, type MutableRefObject } from 'react';
import type { PetView } from './adapter';
import { maskHit } from './atlas-check';
import { Animator, idleWithRests, sharedFrameScheduler, type FrameSource, type FrameSubscription } from './clock';
import { PET_ATLAS, PET_ROWS, cellKey, cellRect, lookCell } from './contract';
import type { ReadyPet } from './loader';

/**
 * Draws one approved (or, on the review board, explicitly labelled) pet atlas. One canvas, redrawn only when the frame
 * changes, on the page-wide scheduler; paused while off screen or while the page is hidden. Frame choice comes only from
 * the PetView the state adapter produced; this component never decides what the pet is doing. Times are
 * performance.now() milliseconds, the same clock the adapter is fed.
 *
 * The feet (the manifest anchor) are drawn on the bottom centre of the box, which is the pet's ground point on screen.
 */

export type PetHitTest = (x: number, y: number) => boolean;

/** Box width for a pet `size` CSS px tall: the cell's aspect ratio. */
export const petBoxWidth = (size: number) => Math.round((size * PET_ATLAS.cellWidth) / PET_ATLAS.cellHeight);

type Cell = { row: number; col: number };

/** Views are new objects on every render; the animation restarts only when what they mean changes. */
export const viewKey = (v: PetView): string =>
  v.kind === 'look' ? `look:${v.index}` : `${v.state}:${v.since}:${v.loop ? 1 : 0}:${v.still ? 1 : 0}:${v.frame ?? '-'}:${v.plays}:${v.holdLast ? 1 : 0}`;

function sourceFor(view: PetView): { cellAt: (now: number) => Cell; src: FrameSource | null } {
  if (view.kind === 'look') {
    const c = lookCell(view.index);
    return { cellAt: () => c, src: null };
  }
  const row = PET_ROWS[view.state].row;
  if (view.still || view.frame !== null) {
    const col = view.frame ?? 0;
    return { cellAt: () => ({ row, col }), src: null };
  }
  // A view that ends by itself (one-shots, review) holds its last frame until the caller swaps in the next view,
  // instead of flashing the row's first frame if that swap is late.
  const src: FrameSource =
    view.state === 'idle' && view.loop
      ? idleWithRests(Math.random, { startAt: view.since })
      : new Animator().play(PET_ROWS[view.state], { loop: view.loop, holdLast: view.holdLast || view.until !== null, startAt: view.since, repeat: view.plays || 1 });
  return { cellAt: (now) => ({ row, col: src.frameAt(now) }), src };
}

export function PetSprite({ pet, view, size, hitRef, className, style }: { pet: ReadyPet; view: PetView; size: number; hitRef?: MutableRefObject<PetHitTest | null>; className?: string; style?: CSSProperties }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = petBoxWidth(size);
  const shown = useRef<Cell | null>(null);
  const latest = useRef(view);
  latest.current = view;
  const key = viewKey(view);
  const { anchor, rendering } = pet.manifest;
  // Offsets that put the anchor (feet) on the bottom centre of the box, in CSS px.
  const scale = size / PET_ATLAS.cellHeight;
  const dx = Math.round((PET_ATLAS.cellWidth / 2 - anchor.x) * scale);
  const dy = Math.round((PET_ATLAS.cellHeight - 1 - anchor.y) * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    // The backing store follows the display's scale (capped at 2), including when the window moves to another monitor.
    const fit = (): boolean => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(width * dpr);
      const h = Math.round(size * dpr);
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      return true;
    };
    fit();
    shown.current = null;
    const { cellAt, src } = sourceFor(latest.current);
    let broken = false;
    const draw = (now: number) => {
      if (broken) return;
      const c = cellAt(now);
      const resized = fit();
      if (!resized && shown.current && shown.current.row === c.row && shown.current.col === c.col) return;
      shown.current = c;
      const r = cellRect(c.row, c.col);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = rendering === 'smooth';
      ctx.imageSmoothingQuality = 'high';
      try {
        ctx.drawImage(pet.bitmap, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
        canvas.dataset.petFrame = `${c.row}:${c.col}`;
      } catch {
        // The bitmap was released (the pack is being swapped): stop drawing rather than throw every frame.
        broken = true;
      }
    };
    const sub: FrameSubscription = { nextChangeAt: (now) => (src && !broken ? src.nextChangeAt(now) : null), draw };
    const scheduler = sharedFrameScheduler();
    let off: (() => void) | null = scheduler.subscribe(sub);
    const dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    const onDpr = () => {
      if (off) off = scheduler.subscribe(sub);
    };
    dprQuery?.addEventListener('change', onDpr);
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && !off) off = scheduler.subscribe(sub);
        if (!visible && off) {
          off();
          off = null;
        }
      });
      io.observe(canvas);
    }
    if (hitRef) {
      hitRef.current = (x, y) => {
        const c = shown.current;
        if (!c) return false;
        const f = pet.frames.get(cellKey(c.row, c.col));
        if (!f) return false;
        // Box px -> cell px, undoing the anchor offset.
        return maskHit(f.mask, (x - dx) / scale, (y - dy) / scale);
      };
    }
    return () => {
      off?.();
      io?.disconnect();
      dprQuery?.removeEventListener('change', onDpr);
      if (hitRef) hitRef.current = null;
    };
  }, [pet, key, size, width, rendering, dx, dy, scale, hitRef]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden
      style={{ display: 'block', width, height: size, transform: dx || dy ? `translate(${dx}px, ${dy}px)` : undefined, ...style }}
    />
  );
}
