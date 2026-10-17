// Pure policy for the desktop companion window (no Electron import, unit tested): its own small IPC surface, sender
// trust, argument shapes, placement on a display and screen-region geometry.
//
// The companion is a second, always-on-top window. It never gets the hub's method table: it loads companion.html, has
// its own preload (window.companion) and may call only the methods below. The hub's router keeps trusting only
// index.html, so a companion page cannot reach the hub's IPC and the hub page cannot reach these.
import type {ArgSpec} from './ipcCore';

export const COMPANION_CHANNEL_PREFIX = 'companion:';
export const COMPANION_EVENT_CHANNEL = 'companion:event';

/** Every method the companion page may call. Region methods are accepted only from the selection overlay. */
export const COMPANION_METHODS = [
  'companionState',
  'companionAsk',
  'companionCancel',
  'companionUndo',
  'companionLayout',
  'companionDrag',
  'companionHit',
  'companionResize',
  'companionDock',
  'companionGaze',
  'companionSetAppearance',
  'companionClearTarget',
  'companionOpenHub',
  'companionSetMaterial',
  // Voice, island only: the same local Windows speech as the hub (backend CompanionVoice), stopped on bubble close.
  'companionVoiceStatus',
  'companionTranscribe',
  'companionTranscribeCancel',
  'companionSpeak',
  'companionSpeechStop',
  'regionBegin',
  'regionDiscard',
  'overlayImage',
  'overlaySubmit',
  'overlayCancel',
] as const;
export type CompanionMethod = (typeof COMPANION_METHODS)[number];
export const OVERLAY_METHODS: readonly CompanionMethod[] = ['overlayImage', 'overlaySubmit', 'overlayCancel'];

export const companionChannel = (m: CompanionMethod) => `${COMPANION_CHANNEL_PREFIX}${m}`;

const TOKEN: ArgSpec = {kind: 'string', min: 16, max: 64};
/** The hub's transcribe/speak bounds (LIMITS in services/validation.ts), repeated so this file stays pure; a test keeps them equal. */
export const COMPANION_WAV_MAX = 44 + 480_000 * 2 + 1024;
export const COMPANION_SPEAK_MAX = 4000;
export const COMPANION_ARG_SPECS: Record<CompanionMethod, readonly ArgSpec[]> = {
  companionState: [],
  // text, region token, and whether the page showed the remembered app window and the person kept it attached.
  companionAsk: [{kind: 'string', min: 1, max: 2000}, {...TOKEN, optional: true}, {kind: 'boolean', optional: true}],
  companionCancel: [],
  companionUndo: [{kind: 'string', min: 1, max: 64}],
  companionLayout: [{kind: 'object'}],
  companionDrag: [{kind: 'enum', values: ['start', 'end']}],
  companionHit: [{kind: 'boolean'}],
  companionResize: [{kind: 'enum', values: ['S', 'M', 'L', 'grow', 'shrink']}],
  companionDock: [{kind: 'enum', values: ['bottom-left', 'bottom-right', 'left', 'right', 'top']}],
  companionGaze: [{kind: 'boolean'}],
  companionSetAppearance: [{kind: 'enum', values: ['pet', 'legacy-orb']}],
  companionClearTarget: [],
  companionOpenHub: [{kind: 'enum', values: ['home', 'assistant', 'notes', 'tasks', 'capsules', 'search', 'companion', 'settings']}, {kind: 'string', min: 1, max: 64, optional: true}],
  companionSetMaterial: [{kind: 'enum', values: ['none', 'acrylic']}],
  companionVoiceStatus: [],
  companionTranscribe: [{kind: 'numbers', max: COMPANION_WAV_MAX}],
  companionTranscribeCancel: [],
  companionSpeak: [{kind: 'string', min: 1, max: COMPANION_SPEAK_MAX}],
  companionSpeechStop: [],
  regionBegin: [],
  regionDiscard: [TOKEN],
  overlayImage: [],
  overlaySubmit: [{kind: 'object'}],
  overlayCancel: [],
};

/** True only for the exact packaged companion.html (empty file host) or, in development, that page on the dev origin. */
export function isTrustedCompanionUrl(url: string | undefined, companionFileUrl: string, devOrigin?: string): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') {
    let a: URL;
    try { a = new URL(companionFileUrl); } catch { return false; }
    if (a.protocol !== 'file:' || u.host !== '' || a.host !== '') return false;
    try { return decodeURIComponent(u.pathname).toLowerCase() === decodeURIComponent(a.pathname).toLowerCase(); } catch { return false; }
  }
  return !!devOrigin && u.protocol === 'http:' && u.origin === devOrigin && u.pathname === '/companion.html';
}

/* ---------- Pet placement ---------- */

export type Rect = {x: number; y: number; width: number; height: number};
export type Point = {x: number; y: number};
export type Dock = 'free' | 'bottom' | 'top' | 'left' | 'right';
export type DockTarget = 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top';
export type BubbleSide = 'left' | 'right' | 'above' | 'below';

/** One pet atlas cell (sprite contract v2). The pet is drawn at a height of `size` CSS px with this aspect. */
export const PET_CELL = {width: 192, height: 208} as const;
export const PET_SIZE = {min: 64, max: 128, step: 8, default: 96, presets: {S: 64, M: 96, L: 128}} as const;
/** The bubble the page may ask for (CSS px). Larger requests are clamped, never trusted as given. */
export const BUBBLE_LIMITS = {minW: 160, maxW: 520, minH: 44, maxH: 620} as const;
/** Room for shadow and edge light around the pet and bubble, so they are not clipped by the window. */
export const LAYOUT_MARGIN = 18;
/** A drag that ends with the pet this close to a work-area edge docks it there, this far in. */
export const DOCK_SNAP = 40;
export const DOCK_INSET = 12;
const BUBBLE_GAP = 8;

export const petWidth = (size: number) => Math.round((size * PET_CELL.width) / PET_CELL.height);
export const clampSize = (n: number) => Math.round(Math.min(PET_SIZE.max, Math.max(PET_SIZE.min, n)));

/** Integer split of the pet's width either side of its ground point (widths can be odd). */
const halves = (size: number) => { const w = petWidth(size); const left = Math.floor(w / 2); return {w, left, right: w - left}; };

/** The pet's box in global DIP: its feet (bottom centre) sit at `p`. */
export function petBox(p: Point, size: number): Rect {
  const {w, left} = halves(size);
  return {x: Math.round(p.x) - left, y: Math.round(p.y) - size, width: w, height: size};
}

/** Moves the ground point so the whole pet stays inside the work area. */
export function clampPetPoint(p: Point, size: number, work: Rect): Point {
  const {left, right} = halves(size);
  const x = Math.min(Math.max(Math.round(p.x), work.x + left), work.x + work.width - right);
  const y = Math.min(Math.max(Math.round(p.y), work.y + size), work.y + work.height);
  return {x, y};
}

export function dockPoint(target: DockTarget, size: number, work: Rect): {point: Point; dock: Dock} {
  const {left, right} = halves(size);
  const bottom = work.y + work.height - DOCK_INSET;
  const mid = work.y + Math.round((work.height + size) / 2);
  switch (target) {
    case 'bottom-left': return {point: clampPetPoint({x: work.x + DOCK_INSET + left, y: bottom}, size, work), dock: 'bottom'};
    case 'bottom-right': return {point: clampPetPoint({x: work.x + work.width - DOCK_INSET - right, y: bottom}, size, work), dock: 'bottom'};
    case 'left': return {point: clampPetPoint({x: work.x + DOCK_INSET + left, y: mid}, size, work), dock: 'left'};
    case 'right': return {point: clampPetPoint({x: work.x + work.width - DOCK_INSET - right, y: mid}, size, work), dock: 'right'};
    case 'top': return {point: clampPetPoint({x: work.x + Math.round(work.width / 2), y: work.y + DOCK_INSET + size}, size, work), dock: 'top'};
  }
}

/** Where a drag ends: snapped to the nearest edge when close to one (bottom wins ties: the pet stands on the taskbar). */
export function snapDock(p: Point, size: number, work: Rect): {point: Point; dock: Dock} {
  const c = clampPetPoint(p, size, work);
  const box = petBox(c, size);
  const d = {
    bottom: work.y + work.height - (box.y + box.height),
    top: box.y - work.y,
    left: box.x - work.x,
    right: work.x + work.width - (box.x + box.width),
  };
  const near = (Object.keys(d) as (keyof typeof d)[]).filter((k) => d[k] <= DOCK_SNAP).sort((a, b) => (a === 'bottom' ? -1 : b === 'bottom' ? 1 : d[a] - d[b]));
  if (!near.length) return {point: c, dock: 'free'};
  const edge = near[0];
  const {left, right} = halves(size);
  let {x, y} = c;
  if (edge === 'bottom') y = work.y + work.height - DOCK_INSET;
  if (edge === 'top') y = work.y + DOCK_INSET + size;
  if (edge === 'left') x = work.x + DOCK_INSET + left;
  if (edge === 'right') x = work.x + work.width - DOCK_INSET - right;
  return {point: clampPetPoint({x, y}, size, work), dock: edge};
}

export type PetPlacement = {
  /** Window bounds, global DIP. */
  window: Rect;
  /** Pet and bubble rectangles relative to the window. */
  pet: Rect;
  bubble: Rect | null;
  side: BubbleSide | null;
};

const clampInto = (r: Rect, work: Rect): Rect => ({
  ...r,
  x: Math.round(Math.min(Math.max(r.x, work.x), work.x + work.width - r.width)),
  y: Math.round(Math.min(Math.max(r.y, work.y), work.y + work.height - r.height)),
});

/**
 * Window and content geometry for the pet at ground point `p` with an optional bubble. The bubble sits beside the pet on
 * the side facing the middle of the work area, its bottom 30% of the pet's height above the feet; when neither side has
 * room it goes above the pet (below when the pet is docked at the top). The pet never moves to make room for the bubble.
 */
export function placePet(p: Point, size: number, bubble: {width: number; height: number} | null, work: Rect, margin = LAYOUT_MARGIN): PetPlacement {
  const pet = petBox(clampPetPoint(p, size, work), size);
  let b: Rect | null = null;
  let side: BubbleSide | null = null;
  if (bubble) {
    const bw = Math.min(bubble.width, work.width);
    const bh = Math.min(bubble.height, work.height);
    const by = pet.y + pet.height - Math.round(pet.height * 0.3) - bh;
    const left: Rect = {x: pet.x - BUBBLE_GAP - bw, y: by, width: bw, height: bh};
    const right: Rect = {x: pet.x + pet.width + BUBBLE_GAP, y: by, width: bw, height: bh};
    const preferLeft = pet.x + pet.width / 2 >= work.x + work.width / 2;
    const order: [BubbleSide, Rect][] = preferLeft ? [['left', left], ['right', right]] : [['right', right], ['left', left]];
    const horizontal = order.find(([, r]) => r.x >= work.x && r.x + r.width <= work.x + work.width);
    if (horizontal) {
      side = horizontal[0];
      b = clampInto(horizontal[1], work);
    } else {
      const cx = pet.x + Math.round(pet.width / 2 - bw / 2);
      const roomAbove = pet.y - BUBBLE_GAP - work.y;
      const roomBelow = work.y + work.height - (pet.y + pet.height + BUBBLE_GAP);
      if (roomAbove >= bh || (roomBelow < bh && roomAbove >= roomBelow)) {
        side = 'above';
        // Never pushed down over the pet: on a screen too small for both, the bubble is cut by the work area instead.
        const h = Math.min(bh, Math.max(BUBBLE_LIMITS.minH, roomAbove));
        b = clampInto({x: cx, y: pet.y - BUBBLE_GAP - h, width: bw, height: h}, work);
      } else {
        side = 'below';
        const h = Math.min(bh, Math.max(BUBBLE_LIMITS.minH, roomBelow));
        b = clampInto({x: cx, y: pet.y + pet.height + BUBBLE_GAP, width: bw, height: h}, work);
      }
    }
  }
  const rects = b ? [pet, b] : [pet];
  const x0 = Math.max(work.x, Math.min(...rects.map((r) => r.x)) - margin);
  const y0 = Math.max(work.y, Math.min(...rects.map((r) => r.y)) - margin);
  const x1 = Math.min(work.x + work.width, Math.max(...rects.map((r) => r.x + r.width)) + margin);
  const y1 = Math.min(work.y + work.height, Math.max(...rects.map((r) => r.y + r.height)) + margin);
  const win: Rect = {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
  const rel = (r: Rect): Rect => ({x: r.x - x0, y: r.y - y0, width: r.width, height: r.height});
  return {window: win, pet: rel(pet), bubble: b ? rel(b) : null, side};
}

/** The page may ask only for a bubble size (or none). No position, ever. */
export function parseBubbleLayout(v: unknown): {bubble: {width: number; height: number} | null} | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'bubble') || !('bubble' in o)) return null;
  if (o.bubble === null) return {bubble: null};
  const b = o.bubble as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'width' && k !== 'height')) return null;
  if (typeof b.width !== 'number' || typeof b.height !== 'number' || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, n)));
  return {bubble: {width: clamp(b.width, BUBBLE_LIMITS.minW, BUBBLE_LIMITS.maxW), height: clamp(b.height, BUBBLE_LIMITS.minH, BUBBLE_LIMITS.maxH)}};
}

export type ResizeOp = 'S' | 'M' | 'L' | 'grow' | 'shrink';
export function resizePet(size: number, op: ResizeOp): number {
  if (op === 'S' || op === 'M' || op === 'L') return PET_SIZE.presets[op];
  return clampSize(size + (op === 'grow' ? PET_SIZE.step : -PET_SIZE.step));
}

/**
 * Which of the 16 look directions (0 = up, clockwise, 22.5 degrees each) points from the pet's head towards the cursor.
 * Null inside the pet itself (the deadzone): the pet then plays its normal idle. Computed in the main process; the page
 * receives only this bucket, never a cursor position.
 */
export function gazeBucket(cursor: Point, pet: Rect): number | null {
  if (cursor.x >= pet.x && cursor.x <= pet.x + pet.width && cursor.y >= pet.y && cursor.y <= pet.y + pet.height) return null;
  const hx = pet.x + pet.width / 2;
  const hy = pet.y + pet.height * 0.35;
  const deg = (Math.atan2(cursor.x - hx, -(cursor.y - hy)) * 180) / Math.PI;
  return Math.round(((deg + 360) % 360) / 22.5) % 16;
}

/* ---------- Screen region ---------- */

/** Largest edge sent to the model; larger selections are scaled down (the provider downsizes very large images anyway). */
export const REGION_MAX_EDGE = 1568;
export const REGION_MIN_DIP = 12;

export function parseSelection(v: unknown, display: {width: number; height: number}): Rect | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const nums = ['x', 'y', 'width', 'height'].map((k) => o[k]);
  if (Object.keys(o).length !== 4 || nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  let [x, y, width, height] = nums as number[];
  // Clip to the display; the overlay covers exactly one display.
  x = Math.max(0, Math.min(x, display.width));
  y = Math.max(0, Math.min(y, display.height));
  width = Math.min(width, display.width - x);
  height = Math.min(height, display.height - y);
  if (width < REGION_MIN_DIP || height < REGION_MIN_DIP) return null;
  return {x, y, width, height};
}

/**
 * Maps a selection in display DIP to pixels of the captured display image. The image is captured at the display's
 * physical size, so the factor is the image width over the DIP width (the scale factor, e.g. 1.25, 1.5, 2), measured
 * from the image itself rather than assumed.
 */
export function cropForSelection(sel: Rect, displayDip: {width: number; height: number}, image: {width: number; height: number}): Rect {
  const sx = image.width / displayDip.width;
  const sy = image.height / displayDip.height;
  const x = Math.max(0, Math.floor(sel.x * sx));
  const y = Math.max(0, Math.floor(sel.y * sy));
  const width = Math.max(1, Math.min(image.width - x, Math.ceil(sel.width * sx)));
  const height = Math.max(1, Math.min(image.height - y, Math.ceil(sel.height * sy)));
  return {x, y, width, height};
}

/** Size to send: the crop itself, or scaled down so its longer edge is REGION_MAX_EDGE. */
export function sendSize(crop: {width: number; height: number}, maxEdge = REGION_MAX_EDGE): {width: number; height: number} {
  const long = Math.max(crop.width, crop.height);
  if (long <= maxEdge) return {width: crop.width, height: crop.height};
  const k = maxEdge / long;
  return {width: Math.max(1, Math.round(crop.width * k)), height: Math.max(1, Math.round(crop.height * k))};
}

/**
 * Whether a media permission request may be granted: microphone audio only (never camera or screen), and only for the
 * hub page or the companion island itself. The selection overlay and every other page are refused.
 */
export function mediaPermissionAllowed(o: {permission: string; mediaTypes?: readonly string[]; hubPage: boolean; islandPage: boolean}): boolean {
  const audioOnly = o.permission === 'media' && !!o.mediaTypes?.length && o.mediaTypes.every((t) => t === 'audio');
  return audioOnly && (o.hubPage || o.islandPage);
}
