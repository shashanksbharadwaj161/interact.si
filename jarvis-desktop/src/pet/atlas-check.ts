/**
 * In-app load check for a decoded pet atlas (PET-RENDERER-PLAN.md section 3). One pass over the RGBA pixels checks
 * only what the app needs before it will draw a pack: exact v2 dimensions, enough visible pixels in each of the 73
 * required cells, fully transparent unused cells and poses that touch a cell edge. It also returns per-frame alpha
 * bounds and a coarse hit mask for click-through.
 *
 * This is not the create-pet skill's validation. Its validate_atlas.py / validate_pet_quality.py gates and the
 * direction QA run in the art pipeline and are recorded under `qa` in the manifest; this check never reports as theirs.
 */
import { HIT_MASK, PET_ATLAS, ROW_FRAME_COUNTS, cellKey } from './contract';

export const ATLAS_LOAD_CHECK = Object.freeze({
  scope: 'in-app-load-check' as const,
  label: 'In-app load check (structure only; not the create-pet atlas validation)',
  /** A required cell needs at least this many pixels with alpha >= visibleAlpha. */
  minVisiblePixels: 200,
  visibleAlpha: 16,
});

export type AtlasCheckError = Readonly<{ row?: number; col?: number; issue: string }>;
export type AtlasCheckWarning = Readonly<{ row: number; col: number; issue: string }>;
/** Tight box around pixels with alpha > 0, in cell-local pixels. */
export type FrameBounds = Readonly<{ x: number; y: number; w: number; h: number }>;
export type FrameCheck = Readonly<{
  row: number;
  col: number;
  bounds: FrameBounds | null;
  visiblePixels: number;
  /** HIT_MASK.columns x HIT_MASK.rows bytes, row-major; 1 where a block has a pixel with alpha >= HIT_MASK.alpha. */
  mask: Uint8Array;
}>;
export type AtlasLoadCheck = Readonly<{
  scope: typeof ATLAS_LOAD_CHECK.scope;
  ok: boolean;
  errors: readonly AtlasCheckError[];
  warnings: readonly AtlasCheckWarning[];
  /** Required frames keyed by cellKey(row, col). Empty when the dimensions are wrong. */
  frames: ReadonlyMap<string, FrameCheck>;
}>;

const fail = (errors: AtlasCheckError[]): AtlasLoadCheck =>
  Object.freeze({ scope: ATLAS_LOAD_CHECK.scope, ok: false, errors: Object.freeze(errors), warnings: Object.freeze([]), frames: new Map() });

export function checkAtlasPixels(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): AtlasLoadCheck {
  const { width: W, height: H, columns: COLS, rows: ROWS, cellWidth: CW, cellHeight: CH } = PET_ATLAS;
  if (width !== W || height !== H) return fail([{ issue: `The atlas is ${width}x${height}; the v2 contract needs exactly ${W}x${H}.` }]);
  if (rgba.length !== W * H * 4) return fail([{ issue: `The pixel buffer holds ${rgba.length} bytes; ${W}x${H} RGBA needs ${W * H * 4}.` }]);

  const cellCount = COLS * ROWS;
  const visible = new Uint32Array(cellCount);
  const nonZero = new Uint32Array(cellCount);
  const minX = new Int32Array(cellCount).fill(CW);
  const minY = new Int32Array(cellCount).fill(CH);
  const maxX = new Int32Array(cellCount).fill(-1);
  const maxY = new Int32Array(cellCount).fill(-1);
  const maskSize = HIT_MASK.columns * HIT_MASK.rows;
  const masks = new Uint8Array(cellCount * maskSize);
  const { visibleAlpha } = ATLAS_LOAD_CHECK;
  const maskAlpha = HIT_MASK.alpha;
  const block = HIT_MASK.block;

  for (let y = 0; y < H; y++) {
    const row = (y / CH) | 0;
    const ly = y - row * CH;
    const maskRowBase = ((ly / block) | 0) * HIT_MASK.columns;
    let p = y * W * 4 + 3;
    for (let col = 0; col < COLS; col++) {
      const cell = row * COLS + col;
      for (let lx = 0; lx < CW; lx++, p += 4) {
        const a = rgba[p];
        if (a === 0) continue;
        nonZero[cell]++;
        if (lx < minX[cell]) minX[cell] = lx;
        if (lx > maxX[cell]) maxX[cell] = lx;
        if (ly < minY[cell]) minY[cell] = ly;
        if (ly > maxY[cell]) maxY[cell] = ly;
        if (a >= visibleAlpha) visible[cell]++;
        if (a >= maskAlpha) masks[cell * maskSize + maskRowBase + ((lx / block) | 0)] = 1;
      }
    }
  }

  const errors: AtlasCheckError[] = [];
  const warnings: AtlasCheckWarning[] = [];
  const frames = new Map<string, FrameCheck>();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cell = row * COLS + col;
      if (col >= ROW_FRAME_COUNTS[row]) {
        if (nonZero[cell] > 0) errors.push(Object.freeze({ row, col, issue: `Unused cell is not fully transparent: ${nonZero[cell]} pixels have alpha above 0.` }));
        continue;
      }
      if (visible[cell] < ATLAS_LOAD_CHECK.minVisiblePixels) {
        errors.push(Object.freeze({ row, col, issue: `Required frame is empty or too faint: ${visible[cell]} pixels with alpha >= ${visibleAlpha}, needs ${ATLAS_LOAD_CHECK.minVisiblePixels}.` }));
      }
      const bounds = maxX[cell] < 0 ? null : Object.freeze({ x: minX[cell], y: minY[cell], w: maxX[cell] - minX[cell] + 1, h: maxY[cell] - minY[cell] + 1 });
      if (bounds) {
        const edges = [bounds.x === 0 && 'left', bounds.y === 0 && 'top', maxX[cell] === CW - 1 && 'right', maxY[cell] === CH - 1 && 'bottom'].filter(Boolean);
        if (edges.length) warnings.push(Object.freeze({ row, col, issue: `Pose touches the ${edges.join(', ')} cell edge (possible clipping or bleed).` }));
      }
      frames.set(cellKey(row, col), Object.freeze({ row, col, bounds, visiblePixels: visible[cell], mask: masks.slice(cell * maskSize, (cell + 1) * maskSize) }));
    }
  }

  return Object.freeze({ scope: ATLAS_LOAD_CHECK.scope, ok: errors.length === 0, errors: Object.freeze(errors), warnings: Object.freeze(warnings), frames });
}

/** True when cell-local point (x, y) falls on a set block of a frame's hit mask. */
export function maskHit(mask: Uint8Array, x: number, y: number): boolean {
  if (!(x >= 0 && y >= 0 && x < PET_ATLAS.cellWidth && y < PET_ATLAS.cellHeight)) return false;
  return mask[((y / HIT_MASK.block) | 0) * HIT_MASK.columns + ((x / HIT_MASK.block) | 0)] === 1;
}
