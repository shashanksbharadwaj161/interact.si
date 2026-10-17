/**
 * Island motion: one set of timing, easing and geometry rules for every surface of the companion (the desktop island,
 * the board and the review journey use the same module). Durations are milliseconds; the same values exist as CSS
 * custom properties in src/styles/companion-bubble.css (`--isl-*`), and a test keeps the two in step.
 *
 * No spring overshoot: text inside the island must never wobble. The shell (a text-free skin) changes shape; the content
 * is laid out at its final size and only fades and settles, so letters are never stretched.
 */

export const MOTION = {
  /** Button press feedback. */
  press: 100,
  /** Control hover and focus light. */
  hover: 160,
  /** Content crossfade between island states. */
  fade: 150,
  /** Island expansion from the character to its content size. */
  expand: 380,
  /** Island collapse back to the character. */
  collapse: 240,
  /** Size change between two open states (command -> answer). */
  morph: 300,
} as const;

/** CSS cubic-bezier control points. `out` decelerates without overshoot; `inOut` is for morphs; `in` for collapse. */
export const EASE = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
  in: [0.5, 0, 0.75, 0],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export const easeCss = (e: readonly [number, number, number, number]) => `cubic-bezier(${e.join(', ')})`;

/** A CSS cubic-bezier timing function as a JS function of progress 0..1 (Newton steps with a bisection fallback). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : sy(solve(p)));
}

export type Rect = { x: number; y: number; width: number; height: number };

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t) });
export const sameRect = (a: Rect, b: Rect, eps = 0.5) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.width - b.width) < eps && Math.abs(a.height - b.height) < eps;
export const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

export type Side = 'left' | 'right' | 'above' | 'below' | 'none';

/** Diameter of the closed island: the small capsule the shell grows out of and returns to, beside the character. */
export const SEED = 36;

/**
 * Where the island starts and ends: a small capsule on the edge of the bubble box that faces the character, aligned with
 * the bubble's tail. Using the bubble box (not the pet box) keeps the start point inside the window the main process
 * sized for the bubble, so the opening never begins clipped.
 */
export function seedRect(box: Rect, side: Side): Rect {
  const s = SEED;
  switch (side) {
    case 'left': return { x: box.x + box.width - s, y: box.y + box.height - s - 14, width: s, height: s };
    case 'right': return { x: box.x, y: box.y + box.height - s - 14, width: s, height: s };
    case 'above': return { x: box.x + (box.width - s) / 2, y: box.y + box.height - s, width: s, height: s };
    case 'below': return { x: box.x + (box.width - s) / 2, y: box.y, width: s, height: s };
    default: return { x: box.x + (box.width - s) / 2, y: box.y + (box.height - s) / 2, width: s, height: s };
  }
}

/**
 * Size of the box to place for a content size: the bubble keeps the content's width and grows only downward from the
 * edge nearest the character, so the caret and title do not jump while the content below them changes.
 */
export const boxFor = (content: { width: number; height: number }): { width: number; height: number } => ({ width: Math.ceil(content.width), height: Math.ceil(content.height) });

export type Clock = {
  now: () => number;
  raf: (cb: (t: number) => void) => number;
  cancel: (id: number) => void;
  /** Timers for the stall watchdog. */
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** True while the document is hidden: moves finish at once instead of waiting for frames nobody sees. */
  hidden: () => boolean;
};
export const browserClock = (): Clock => ({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (id) => window.clearTimeout(id),
  hidden: () => typeof document !== 'undefined' && document.hidden,
});

/**
 * If no animation frame has arrived for this long while something moves, a timer draws the next step instead. In the
 * transparent, non-activating companion window on Windows, requestAnimationFrame has been seen to stop after one
 * callback while timers keep running and document.hidden stays false.
 */
export const STALL_MS = 48;

/** `via: 'timer'` marks a step drawn by the stall watchdog instead of an animation frame. */
export type FrameSample = { at: number; dt: number; via: 'raf' | 'timer' };

/**
 * Animates one rectangle. `to()` always starts from the rectangle as it is drawn right now, so a reversal mid-way (open,
 * then close before the opening finished) continues from the current shape instead of jumping. `apply` writes the
 * shape (a clip-path on a text-free skin). Frames are requested only while something moves; requestAnimationFrame
 * pauses on its own while the window is hidden.
 */
export function createRectAnimator(o: { initial: Rect; apply: (r: Rect, progress: number) => void; clock?: Clock; onFrame?: (s: FrameSample) => void }) {
  const clock = o.clock ?? browserClock();
  let current = o.initial;
  let from = o.initial;
  let target = o.initial;
  let start = 0;
  let duration = 0;
  let ease: (t: number) => number = (t) => t;
  let frame = 0;
  let watchdog = 0;
  let moving = false;
  let lastAt = 0;
  let lastStep = 0;
  let done: (() => void) | null = null;
  const clear = () => {
    if (frame) clock.cancel(frame);
    if (watchdog) clock.clearTimer(watchdog);
    frame = 0;
    watchdog = 0;
  };
  /** Exactly once per move: whichever of frame, watchdog, jump or stop gets there first. */
  const finish = () => {
    clear();
    moving = false;
    lastAt = 0;
    const d = done;
    done = null;
    d?.();
  };
  const step = (via: 'raf' | 'timer') => {
    if (!moving) return;
    const at = clock.now();
    lastStep = at;
    const t = duration <= 0 || clock.hidden() ? 1 : Math.min(1, (at - start) / duration);
    current = t >= 1 ? target : lerpRect(from, target, ease(t));
    o.apply(current, t);
    if (lastAt) o.onFrame?.({ at, dt: at - lastAt, via });
    lastAt = at;
    if (t >= 1) return finish();
    if (via === 'raf') frame = clock.raf(() => { frame = 0; step('raf'); });
  };
  const arm = () => {
    watchdog = clock.setTimer(function guard() {
      watchdog = 0;
      if (!moving) return;
      if (clock.now() - lastStep >= STALL_MS) {
        // Frames stopped arriving: draw from the timer, and ask for a frame again in case they resume.
        step('timer');
        if (moving && !frame) frame = clock.raf(() => { frame = 0; step('raf'); });
      }
      if (moving) watchdog = clock.setTimer(guard, STALL_MS / 2);
    }, STALL_MS);
  };
  return {
    get rect() { return current; },
    get moving() { return moving; },
    /** Moves to `next` over `ms` with `curve`; resolves when it arrives (or when a later call replaces it). */
    to(next: Rect, ms: number, curve: readonly [number, number, number, number]): Promise<void> {
      // A new move replaces the old one; the old one's promise resolves now (once), and the new one starts from here.
      finish();
      from = current;
      target = next;
      start = clock.now();
      duration = ms;
      ease = cubicBezier(...curve);
      return new Promise<void>((resolve) => {
        done = resolve;
        if (ms <= 0 || sameRect(from, next) || clock.hidden()) {
          current = next;
          o.apply(current, 1);
          finish();
          return;
        }
        moving = true;
        lastStep = start;
        frame = clock.raf(() => { frame = 0; step('raf'); });
        arm();
      });
    },
    /** Puts the shape somewhere without animating (first layout, reduced motion). */
    jump(next: Rect) {
      current = from = target = next;
      o.apply(current, 1);
      finish();
    },
    /** Stops where it is (unmount). */
    stop() {
      finish();
    },
  };
}

/** CSS clip-path for a rectangle inside a container of `size`, with rounded corners that stay round while it moves. */
export function insetClip(container: { width: number; height: number }, r: Rect, radius: number): string {
  const top = Math.max(0, r.y), left = Math.max(0, r.x);
  const right = Math.max(0, container.width - (r.x + r.width));
  const bottom = Math.max(0, container.height - (r.y + r.height));
  const rad = Math.min(radius, r.width / 2, r.height / 2);
  return `inset(${top.toFixed(2)}px ${right.toFixed(2)}px ${bottom.toFixed(2)}px ${left.toFixed(2)}px round ${rad.toFixed(2)}px)`;
}
