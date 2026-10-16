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
  'companionOpenHub',
  'companionSetMaterial',
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
export const COMPANION_ARG_SPECS: Record<CompanionMethod, readonly ArgSpec[]> = {
  companionState: [],
  companionAsk: [{kind: 'string', min: 1, max: 2000}, {...TOKEN, optional: true}],
  companionCancel: [],
  companionUndo: [{kind: 'string', min: 1, max: 64}],
  companionLayout: [{kind: 'object'}],
  companionOpenHub: [{kind: 'enum', values: ['home', 'assistant', 'notes', 'tasks', 'capsules', 'search', 'companion', 'settings']}, {kind: 'string', min: 1, max: 64, optional: true}],
  companionSetMaterial: [{kind: 'enum', values: ['none', 'acrylic']}],
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

/* ---------- Layout ---------- */

export type Anchor = 'corner' | 'top' | 'right';
export type Rect = {x: number; y: number; width: number; height: number};
export type Layout = {width: number; height: number; anchor: Anchor};

/** The island's window may be this small or large (CSS px). Larger requests are clamped, never trusted as given. */
export const LAYOUT_LIMITS = {minW: 120, maxW: 820, minH: 44, maxH: 680} as const;
/** Room for the island's shadow and edge light around its body, so they are not clipped by the window. */
export const LAYOUT_MARGIN = 18;

export function parseLayout(v: unknown): Layout | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['width', 'height', 'anchor', 'release'].includes(k))) return null;
  if (o.release !== undefined && typeof o.release !== 'boolean') return null;
  if (typeof o.width !== 'number' || typeof o.height !== 'number' || !Number.isFinite(o.width) || !Number.isFinite(o.height)) return null;
  if (o.anchor !== 'corner' && o.anchor !== 'top' && o.anchor !== 'right') return null;
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, n)));
  return {width: clamp(o.width, LAYOUT_LIMITS.minW, LAYOUT_LIMITS.maxW), height: clamp(o.height, LAYOUT_LIMITS.minH, LAYOUT_LIMITS.maxH), anchor: o.anchor};
}

/**
 * Window bounds for an island of the given size docked on the work area (DIP, the display's usable area without the
 * taskbar). The island keeps its docked edge as it grows: bottom-right grows up and left, top grows down from the centre,
 * right grows left from the vertical centre. Bounds always fit inside the work area.
 */
export function placeIsland(work: Rect, layout: Layout, inset = 12): Rect {
  const w = Math.min(layout.width + LAYOUT_MARGIN * 2, work.width);
  const h = Math.min(layout.height + LAYOUT_MARGIN * 2, work.height);
  let x: number;
  let y: number;
  if (layout.anchor === 'top') {
    x = work.x + Math.round((work.width - w) / 2);
    y = work.y + inset - LAYOUT_MARGIN;
  } else if (layout.anchor === 'right') {
    x = work.x + work.width - w - inset + LAYOUT_MARGIN;
    y = work.y + Math.round((work.height - h) / 2);
  } else {
    x = work.x + work.width - w - inset + LAYOUT_MARGIN;
    y = work.y + work.height - h - inset + LAYOUT_MARGIN;
  }
  x = Math.min(Math.max(x, work.x), work.x + work.width - w);
  y = Math.min(Math.max(y, work.y), work.y + work.height - h);
  return {x, y, width: w, height: h};
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
