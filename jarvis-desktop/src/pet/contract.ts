/**
 * The v2 pet atlas contract (planning/ui-revamp/pet-skill-reference/animation-rows.md): geometry, the nine
 * animation rows with their frame durations, the sixteen look directions and the still key frames used under
 * reduced motion. Every other pet module reads geometry from here; nothing else hard-codes it.
 */

export const PET_ATLAS = Object.freeze({
  spriteVersion: 2,
  width: 1536,
  height: 2288,
  columns: 8,
  rows: 11,
  cellWidth: 192,
  cellHeight: 208,
});

/** Coarse hit mask per frame: one byte per 8x8 block, set when any pixel in the block has alpha >= 64. */
export const HIT_MASK = Object.freeze({
  block: 8,
  columns: PET_ATLAS.cellWidth / 8,
  rows: PET_ATLAS.cellHeight / 8,
  alpha: 64,
});

export type PetState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review';

export type PetRow = Readonly<{ row: number; durations: readonly number[] }>;
export type CellRef = Readonly<{ row: number; col: number }>;
export type CellRect = Readonly<{ x: number; y: number; w: number; h: number }>;

const repeat = (ms: number, times: number, last: number): readonly number[] => Object.freeze([...Array<number>(times).fill(ms), last]);

export const PET_ROWS: Readonly<Record<PetState, PetRow>> = Object.freeze({
  idle: Object.freeze({ row: 0, durations: Object.freeze([280, 110, 110, 140, 140, 320]) }),
  'running-right': Object.freeze({ row: 1, durations: repeat(120, 7, 220) }),
  'running-left': Object.freeze({ row: 2, durations: repeat(120, 7, 220) }),
  waving: Object.freeze({ row: 3, durations: repeat(140, 3, 280) }),
  jumping: Object.freeze({ row: 4, durations: repeat(140, 4, 280) }),
  failed: Object.freeze({ row: 5, durations: repeat(140, 7, 240) }),
  waiting: Object.freeze({ row: 6, durations: repeat(150, 5, 260) }),
  running: Object.freeze({ row: 7, durations: repeat(120, 5, 220) }),
  review: Object.freeze({ row: 8, durations: repeat(150, 5, 280) }),
});

export const PET_STATES: readonly PetState[] = Object.freeze(Object.keys(PET_ROWS) as PetState[]);

/** Rows 9-10 hold sixteen look poses, clockwise from up (0 deg) in 22.5 deg steps. */
export const LOOK = Object.freeze({
  firstRow: 9,
  directions: 16,
  perRow: 8,
  stepDegrees: 22.5,
});

/** Still frame per state under reduced motion (PET-RENDERER-PLAN.md section 5). Jumping shows its rest pose. */
export const REDUCED_MOTION_KEY_FRAME: Readonly<Record<PetState, number>> = Object.freeze({
  idle: 0,
  'running-right': 0,
  'running-left': 0,
  waving: 2,
  jumping: 0,
  failed: 7,
  waiting: 2,
  running: 2,
  review: 2,
});

/** Total play time of one pass through a state's row. */
export const rowDurationMs = (state: PetState): number => PET_ROWS[state].durations.reduce((a, b) => a + b, 0);

/** Frames used in each atlas row, from the left; index is the row number. */
export const ROW_FRAME_COUNTS: readonly number[] = Object.freeze(
  Array.from({ length: PET_ATLAS.rows }, (_, row) => {
    if (row >= LOOK.firstRow) return LOOK.perRow;
    const state = PET_STATES.find((s) => PET_ROWS[s].row === row);
    return state ? PET_ROWS[state].durations.length : 0;
  }),
);

const cells = (used: boolean): readonly CellRef[] => {
  const out: CellRef[] = [];
  for (let row = 0; row < PET_ATLAS.rows; row++) {
    for (let col = 0; col < PET_ATLAS.columns; col++) {
      if (col < ROW_FRAME_COUNTS[row] === used) out.push(Object.freeze({ row, col }));
    }
  }
  return Object.freeze(out);
};

/** The 73 cells that must hold a frame. */
export const REQUIRED_CELLS: readonly CellRef[] = cells(true);
/** The 15 cells after each standard row's last frame; they must be fully transparent. */
export const UNUSED_CELLS: readonly CellRef[] = cells(false);

export const cellKey = (row: number, col: number): string => `${row}:${col}`;

const isIndex = (v: number, size: number): boolean => Number.isInteger(v) && v >= 0 && v < size;

export const isRequiredCell = (row: number, col: number): boolean =>
  isIndex(row, PET_ATLAS.rows) && isIndex(col, PET_ATLAS.columns) && col < ROW_FRAME_COUNTS[row];

/** Pixel rectangle of a cell in the atlas. */
export function cellRect(row: number, col: number): CellRect {
  if (!isIndex(row, PET_ATLAS.rows) || !isIndex(col, PET_ATLAS.columns)) throw new RangeError(`No atlas cell at row ${row}, column ${col}.`);
  return Object.freeze({ x: col * PET_ATLAS.cellWidth, y: row * PET_ATLAS.cellHeight, w: PET_ATLAS.cellWidth, h: PET_ATLAS.cellHeight });
}

/** Atlas cell of look index 0-15: row 9 + floor(i / 8), column i % 8. */
export function lookCell(index: number): CellRef {
  if (!isIndex(index, LOOK.directions)) throw new RangeError(`Look index must be an integer 0-${LOOK.directions - 1}, got ${index}.`);
  return Object.freeze({ row: LOOK.firstRow + Math.floor(index / LOOK.perRow), col: index % LOOK.perRow });
}

/** Nearest look index for an angle in degrees clockwise from up: round(deg / 22.5) mod 16. */
export function angleToLookIndex(deg: number): number {
  if (!Number.isFinite(deg)) throw new RangeError(`Look angle must be a finite number, got ${deg}.`);
  const i = Math.round(deg / LOOK.stepDegrees) % LOOK.directions;
  return i < 0 ? i + LOOK.directions : i + 0;
}
