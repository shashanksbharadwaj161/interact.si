// Pet core (src/pet): v2 atlas geometry, strict pack manifest, the in-app atlas load check on synthetic RGBA buffers,
// the shared frame scheduler and animators on fake time, and the state adapter's priority list. No DOM, no art.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'pet-core-entry.ts',
    loader: 'ts',
    contents: `
      export * from './src/pet/contract.ts';
      export * from './src/pet/manifest.ts';
      export * from './src/pet/atlas-check.ts';
      export * from './src/pet/clock.ts';
      export * from './src/pet/adapter.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

/* ---------------------------------------------------------------- geometry */

test('the v2 atlas has 73 required and 15 unused cells in an 8 x 11 grid of 192 x 208', () => {
  assert.equal(m.PET_ATLAS.width, 8 * 192);
  assert.equal(m.PET_ATLAS.height, 11 * 208);
  assert.equal(m.REQUIRED_CELLS.length, 73);
  assert.equal(m.UNUSED_CELLS.length, 15);
  const keys = new Set([...m.REQUIRED_CELLS, ...m.UNUSED_CELLS].map((c) => m.cellKey(c.row, c.col)));
  assert.equal(keys.size, 88);
  assert.deepEqual(m.ROW_FRAME_COUNTS, [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]);
  assert.ok(m.REQUIRED_CELLS.every((c) => m.isRequiredCell(c.row, c.col)));
  assert.ok(m.UNUSED_CELLS.every((c) => !m.isRequiredCell(c.row, c.col)));
  assert.deepEqual(m.UNUSED_CELLS.filter((c) => c.row === 3).map((c) => c.col), [4, 5, 6, 7]);
  assert.deepEqual(m.cellRect(10, 7), { x: 7 * 192, y: 10 * 208, w: 192, h: 208 });
  assert.throws(() => m.cellRect(11, 0), RangeError);
  assert.throws(() => m.cellRect(0, 8), RangeError);
});

test('rows carry the contract durations and reduced-motion key frames', () => {
  assert.deepEqual(m.PET_ROWS.idle, { row: 0, durations: [280, 110, 110, 140, 140, 320] });
  assert.deepEqual(m.PET_ROWS['running-right'].durations, [120, 120, 120, 120, 120, 120, 120, 220]);
  assert.deepEqual(m.PET_ROWS.waving.durations, [140, 140, 140, 280]);
  assert.deepEqual(m.PET_ROWS.jumping.durations, [140, 140, 140, 140, 280]);
  assert.deepEqual(m.PET_ROWS.failed.durations, [140, 140, 140, 140, 140, 140, 140, 240]);
  assert.deepEqual(m.PET_ROWS.waiting.durations, [150, 150, 150, 150, 150, 260]);
  assert.deepEqual(m.PET_ROWS.running.durations, [120, 120, 120, 120, 120, 220]);
  assert.deepEqual(m.PET_ROWS.review.durations, [150, 150, 150, 150, 150, 280]);
  assert.deepEqual(m.PET_STATES.map((s) => m.PET_ROWS[s].row), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const s of m.PET_STATES) {
    assert.ok(m.PET_ROWS[s].durations.every((d) => d >= 100), `${s}: at most 10 changes a second`);
    assert.ok(m.REDUCED_MOTION_KEY_FRAME[s] < m.PET_ROWS[s].durations.length, `${s} key frame exists`);
  }
  assert.deepEqual({ ...m.REDUCED_MOTION_KEY_FRAME }, { idle: 0, 'running-right': 0, 'running-left': 0, waving: 2, jumping: 0, failed: 7, waiting: 2, running: 2, review: 2 });
  assert.equal(m.rowDurationMs('waving'), 700);
  assert.equal(m.rowDurationMs('review'), 1030);
});

test('look indices map to rows 9-10 and angles round to the nearest 22.5 degree pose', () => {
  assert.deepEqual(m.lookCell(0), { row: 9, col: 0 });
  assert.deepEqual(m.lookCell(m.angleToLookIndex(157.5)), { row: 9, col: 7 });
  assert.deepEqual(m.lookCell(m.angleToLookIndex(180)), { row: 10, col: 0 });
  assert.deepEqual(m.lookCell(15), { row: 10, col: 7 });
  assert.equal(m.angleToLookIndex(350), 0);
  assert.equal(m.angleToLookIndex(11.24), 0);
  assert.equal(m.angleToLookIndex(11.26), 1);
  assert.equal(m.angleToLookIndex(90), 4);
  assert.equal(m.angleToLookIndex(337.5), 15);
  assert.equal(m.angleToLookIndex(360), 0);
  assert.equal(m.angleToLookIndex(-22.5), 15);
  assert.ok(Object.is(m.angleToLookIndex(-5), 0), 'never -0');
  assert.throws(() => m.angleToLookIndex(Number.NaN), RangeError);
  assert.throws(() => m.lookCell(16), RangeError);
  assert.throws(() => m.lookCell(1.5), RangeError);
});

/* ---------------------------------------------------------------- manifest */

const SHA = 'a'.repeat(64);
const manifest = (over = {}) => ({
  format: 'desktop-companion/pet-pack@1',
  id: 'direction-a',
  name: 'Working name',
  description: 'One sentence.',
  spriteVersion: 2,
  atlas: 'spritesheet.webp',
  atlasSha256: SHA,
  rendering: 'smooth',
  anchor: { x: 96, y: 196 },
  review: { status: 'concept', notes: '' },
  qa: { tool: 'create-pet bundled scripts (1.0)', atlasValidation: 'qa/validation-extended.json', petQuality: 'qa/pet-quality.json' },
  source: 'Generated from brief planning/ui-revamp/PET-CONCEPTS.md Direction A',
  license: 'Original artwork owned by the project',
  ...over,
});
const approved = { status: 'approved', approvedBy: 'owner', approvedOn: '2026-10-20' };
const rejects = (input, pattern) => {
  const r = m.parsePetManifest(input);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(input).slice(0, 120)}`);
  assert.ok(r.errors.some((e) => pattern.test(e)), `errors ${JSON.stringify(r.errors)} should match ${pattern}`);
};

test('a well-formed manifest parses into a fresh frozen copy; only recorded approval counts', () => {
  const input = manifest();
  const r = m.parsePetManifest(input);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.notEqual(r.manifest, input);
  assert.ok(Object.isFrozen(r.manifest) && Object.isFrozen(r.manifest.anchor) && Object.isFrozen(r.manifest.review));
  assert.equal(m.isApprovedForProduct(r.manifest), false, 'a concept is never product art');

  const inReview = m.parsePetManifest(manifest({ review: { status: 'in-review' }, qa: undefined }));
  assert.equal(inReview.ok, true, 'qa is optional before approval');
  assert.equal(m.isApprovedForProduct(inReview.manifest), false);

  const ok = m.parsePetManifest(manifest({ review: approved, rendering: 'pixelated', atlas: 'sheet-v2.png' }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(m.isApprovedForProduct(ok.manifest), true);
  assert.equal(m.isApprovedForProduct(null), false);
});

test('unknown keys are rejected at every level, including __proto__', () => {
  rejects(manifest({ extra: 1 }), /^extra is not a known field/);
  rejects(manifest({ anchor: { x: 1, y: 2, z: 3 } }), /^anchor\.z is not a known field/);
  rejects(manifest({ review: { status: 'concept', approver: 'x' } }), /^review\.approver is not a known field/);
  rejects(manifest({ qa: { tool: 't', atlasValidation: 'a.json', petQuality: 'b.json', ran: true } }), /^qa\.ran is not a known field/);
  rejects(JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(manifest()).slice(1)}`), /__proto__ is not a known field/);
});

test('required fields, types and shapes are enforced', () => {
  for (const input of [null, [], 'pet', 42, new Map()]) rejects(input, /must be a JSON object/);
  const missing = manifest();
  delete missing.license;
  rejects(missing, /^license is required/);
  rejects(manifest({ format: 'desktop-companion/pet-pack@2' }), /^format must be/);
  rejects(manifest({ spriteVersion: 1 }), /^spriteVersion must be 2/);
  rejects(manifest({ rendering: 'crisp' }), /^rendering must be/);
  rejects(manifest({ name: '' }), /^name must be 1-40/);
  rejects(manifest({ name: 'x'.repeat(41) }), /^name must be 1-40/);
  rejects(manifest({ description: 'x'.repeat(201) }), /^description must be at most 200/);
  rejects(manifest({ review: 'approved' }), /^review must be an object/);
  rejects(manifest({ review: { status: 'shipped' } }), /^review\.status must be/);
  rejects(manifest({ anchor: { x: 192, y: 10 } }), /^anchor\.x must lie inside/);
  rejects(manifest({ anchor: { x: 10, y: -1 } }), /^anchor\.y must lie inside/);
  rejects(manifest({ anchor: { x: '96', y: 196 } }), /^anchor\.x must be a number/);
  rejects(manifest({ qa: { tool: 't', atlasValidation: '../outside.json', petQuality: 'b.json' } }), /^qa\.atlasValidation must be a relative path/);
});

test('ids, atlas file names and hashes follow the strict rules', () => {
  for (const id of ['Direction-A', 'direction_a', '', 'a'.repeat(41), 'dir a', 'dir/a']) rejects(manifest({ id }), /^id must be/);
  for (const atlas of ['../spritesheet.webp', 'sub/spritesheet.webp', 'sub\\spritesheet.png', '/abs/sheet.png', 'C:\\sheet.png']) {
    rejects(manifest({ atlas }), /^atlas must be a plain file name in the pack folder, without path separators/);
  }
  for (const atlas of ['sheet.gif', 'sheet.webp.exe', 'sheet', 'sheet.PNG']) rejects(manifest({ atlas }), /^atlas must be a \.webp or \.png/);
  for (const atlas of ['.sheet.png', '..png', 'a..b.png', 'sheet name.png', 'C:sheet.png']) rejects(manifest({ atlas }), /^atlas must be a plain file name/);
  for (const sha of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42]) rejects(manifest({ atlasSha256: sha }), /^atlasSha256 must be/);
});

test('approval needs approvedBy, a real approvedOn date and the qa record', () => {
  rejects(manifest({ review: { status: 'approved', approvedOn: '2026-10-20' } }), /^review\.approvedBy is required when/);
  rejects(manifest({ review: { status: 'approved', approvedBy: 'owner' } }), /^review\.approvedOn is required when/);
  rejects(manifest({ review: { status: 'approved', approvedBy: '', approvedOn: '2026-10-20' } }), /^review\.approvedBy must be 1-80/);
  rejects(manifest({ review: { ...approved, approvedOn: '2026-02-30' } }), /^review\.approvedOn must be a calendar date/);
  rejects(manifest({ review: { ...approved, approvedOn: '20-10-2026' } }), /^review\.approvedOn must be a calendar date/);
  rejects(manifest({ review: approved, qa: undefined }), /^qa is required when review\.status is "approved"/);
  const hand = { ...manifest({ review: approved }).review };
  assert.equal(m.isApprovedForProduct({ review: { ...hand, approvedOn: 'soon' } }), false, 'a hand-built object is checked too');
});

/* ---------------------------------------------------------------- atlas load check */

const { width: W, height: H, cellWidth: CW, cellHeight: CH } = m.PET_ATLAS;
const blankAtlas = () => new Uint8ClampedArray(W * H * 4);
const fillRect = (px, row, col, x, y, w, h, alpha = 255) => {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = ((row * CH + yy) * W + col * CW + xx) * 4;
      px[i] = 200; px[i + 1] = 120; px[i + 2] = 40; px[i + 3] = alpha;
    }
  }
};
/** Opaque 40 x 48 test rectangle per required cell, away from every edge. Layout fixture only, not art. */
const validAtlas = () => {
  const px = blankAtlas();
  for (const c of m.REQUIRED_CELLS) fillRect(px, c.row, c.col, 76, 100, 40, 48);
  return px;
};

test('a synthetic layout with test rectangles in all 73 cells passes the in-app load check', () => {
  const t0 = performance.now();
  const r = m.checkAtlasPixels(validAtlas(), W, H);
  const ms = performance.now() - t0;
  assert.equal(r.scope, 'in-app-load-check');
  assert.match(m.ATLAS_LOAD_CHECK.label, /not the create-pet/);
  assert.equal(r.ok, true, JSON.stringify(r.errors.slice(0, 3)));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.frames.size, 73);
  const f = r.frames.get('4:2');
  assert.deepEqual(f.bounds, { x: 76, y: 100, w: 40, h: 48 });
  assert.equal(f.visiblePixels, 40 * 48);
  assert.equal(r.frames.has('3:4'), false, 'unused cells have no frame');
  assert.ok(ms < 3000, `single pass took ${ms.toFixed(0)} ms`);
});

test('wrong dimensions or buffer size fail before any cell is read', () => {
  const r = m.checkAtlasPixels(new Uint8Array(1536 * 1872 * 4), 1536, 1872);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].issue, /1536x1872.*1536x2288/);
  assert.equal(r.frames.size, 0);
  assert.equal(m.checkAtlasPixels(new Uint8Array(10), W, H).ok, false);
});

test('an empty or too faint required cell fails with its row and column', () => {
  const px = validAtlas();
  fillRect(px, 7, 3, 0, 0, CW, CH, 0);
  fillRect(px, 9, 5, 0, 0, CW, CH, 0);
  fillRect(px, 9, 5, 80, 80, 10, 10);
  fillRect(px, 6, 0, 0, 0, CW, CH, 0);
  fillRect(px, 6, 0, 50, 50, 30, 30, 15);
  const r = m.checkAtlasPixels(px, W, H);
  assert.equal(r.ok, false);
  const failed = r.errors.map((e) => `${e.row}:${e.col}`).sort();
  assert.deepEqual(failed, ['6:0', '7:3', '9:5']);
  assert.match(r.errors.find((e) => e.row === 7).issue, /0 pixels with alpha >= 16, needs 200/);
  assert.equal(r.frames.get('7:3').bounds, null);
  assert.deepEqual(r.frames.get('6:0').bounds, { x: 50, y: 50, w: 30, h: 30 }, 'faint pixels still have bounds');
});

test('one stray pixel in an unused cell fails', () => {
  const px = validAtlas();
  px[((0 * CH + 200) * W + 6 * CW + 3) * 4 + 3] = 1;
  const r = m.checkAtlasPixels(px, W, H);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(({ row, col }) => ({ row, col })), [{ row: 0, col: 6 }]);
  assert.match(r.errors[0].issue, /Unused cell is not fully transparent: 1 pixels/);
});

test('a pose touching its cell edge warns but does not fail', () => {
  const px = validAtlas();
  fillRect(px, 2, 4, 0, 60, 30, 30);
  fillRect(px, 8, 1, 100, 180, 20, CH - 180);
  const r = m.checkAtlasPixels(px, W, H);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map(({ row, col }) => `${row}:${col}`), ['2:4', '8:1']);
  assert.match(r.warnings[0].issue, /left cell edge/);
  assert.match(r.warnings[1].issue, /bottom cell edge/);
});

test('the coarse hit mask sets 8 x 8 blocks where pixels with alpha >= 64 exist', () => {
  const px = blankAtlas();
  for (const c of m.REQUIRED_CELLS) fillRect(px, c.row, c.col, 76, 100, 40, 48);
  fillRect(px, 0, 0, 0, 0, CW, CH, 0);
  fillRect(px, 0, 0, 16, 24, 16, 16);
  fillRect(px, 0, 0, 100, 100, 1, 1);
  fillRect(px, 0, 0, 120, 160, 30, 20, 40);
  const f = m.checkAtlasPixels(px, W, H).frames.get('0:0');
  assert.equal(f.mask.length, m.HIT_MASK.columns * m.HIT_MASK.rows);
  assert.equal(f.mask.length, 24 * 26);
  const set = [...f.mask].flatMap((v, i) => (v ? [`${i % 24},${Math.floor(i / 24)}`] : []));
  assert.deepEqual(set, ['2,3', '3,3', '2,4', '3,4', '12,12']);
  assert.equal(m.maskHit(f.mask, 20, 30), true);
  assert.equal(m.maskHit(f.mask, 100, 100), true);
  assert.equal(m.maskHit(f.mask, 130, 165), false, 'alpha 40 is not hit-testable');
  assert.equal(m.maskHit(f.mask, 5, 5), false);
  assert.equal(m.maskHit(f.mask, -1, 30), false);
  assert.equal(m.maskHit(f.mask, CW, 30), false);
});

/* ---------------------------------------------------------------- scheduler */

function fakeEnv() {
  const env = {
    t: 0,
    hidden: false,
    timers: new Map(),
    nextId: 1,
    frames: [],
    setCalls: [],
    visibility: null,
  };
  env.api = {
    now: () => env.t,
    setTimer: (fn, ms) => {
      const id = env.nextId++;
      env.timers.set(id, { fn, at: env.t + ms });
      env.setCalls.push(ms);
      return id;
    },
    clearTimer: (id) => env.timers.delete(id),
    requestFrame: (fn) => env.frames.push(fn),
    isHidden: () => env.hidden,
    onVisibilityChange: (fn) => {
      env.visibility = fn;
      return () => { env.visibility = null; };
    },
  };
  env.flushFrames = () => {
    const fs = env.frames.splice(0);
    for (const f of fs) f();
    return fs.length;
  };
  /** Moves time forward, firing due timers (and the frames they request) in order. */
  env.advance = (to) => {
    for (;;) {
      env.flushFrames();
      const due = [...env.timers.entries()].filter(([, v]) => v.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      env.t = due[1].at;
      env.timers.delete(due[0]);
      due[1].fn();
    }
    env.t = to;
    env.flushFrames();
  };
  return env;
}

/** A subscription whose frame changes at fixed times. */
const stepper = (name, changes, log) => ({
  nextChangeAt: (now) => changes.find((c) => c > now) ?? null,
  draw: (now) => log.push(`${name}@${now}`),
});

test('the scheduler keeps one timer for the earliest change and draws due sprites in one frame', () => {
  const env = fakeEnv();
  const s = m.createFrameScheduler(env.api);
  const log = [];
  s.subscribe(stepper('a', [100, 200, 300], log));
  s.subscribe(stepper('b', [250], log));
  assert.equal(env.timers.size, 0, 'first draw needs no timer');
  assert.equal(env.frames.length, 1, 'one frame for both new sprites');
  env.flushFrames();
  assert.deepEqual(log, ['a@0', 'b@0']);
  assert.equal(env.timers.size, 1);
  assert.deepEqual(env.setCalls, [100]);

  env.advance(99);
  assert.deepEqual(log, ['a@0', 'b@0'], 'nothing draws between changes');
  env.advance(100);
  assert.deepEqual(log.slice(2), ['a@100']);
  assert.equal(env.timers.size, 1);
  env.advance(260);
  assert.deepEqual(log.slice(3), ['a@200', 'b@250']);
  env.advance(1000);
  assert.deepEqual(log.slice(5), ['a@300']);
  assert.equal(env.timers.size, 0, 'no timer once nothing will change');
  assert.equal(env.frames.length, 0);
  assert.deepEqual(env.setCalls, [100, 100, 50, 50]);
});

test('two sprites changing at the same time share one frame', () => {
  const env = fakeEnv();
  const s = m.createFrameScheduler(env.api);
  const log = [];
  s.subscribe(stepper('a', [120], log));
  s.subscribe(stepper('b', [120], log));
  env.flushFrames();
  let frames = 0;
  const origRequest = env.api.requestFrame;
  env.api.requestFrame = (fn) => { frames++; origRequest(fn); };
  const s2 = m.createFrameScheduler(env.api);
  s2.subscribe(stepper('c', [120], log));
  s2.subscribe(stepper('d', [120], log));
  frames = 0;
  env.advance(120);
  assert.deepEqual(log.filter((l) => l.endsWith('@120')).sort(), ['a@120', 'b@120', 'c@120', 'd@120']);
  assert.equal(frames, 1, 'c and d drew in a single frame');
});

test('hidden pages pause drawing and resume with a redraw of every sprite', () => {
  const env = fakeEnv();
  const s = m.createFrameScheduler(env.api);
  const log = [];
  s.subscribe(stepper('a', [100, 200, 300, 400], log));
  env.flushFrames();
  env.hidden = true;
  env.visibility();
  assert.equal(env.timers.size, 0, 'timer cleared while hidden');
  env.advance(350);
  assert.deepEqual(log, ['a@0']);
  s.subscribe(stepper('b', [500], log));
  assert.equal(env.frames.length, 0, 'no frames while hidden');
  env.hidden = false;
  env.visibility();
  env.flushFrames();
  assert.deepEqual(log.slice(1), ['a@350', 'b@350']);
  env.advance(400);
  assert.deepEqual(log.slice(3), ['a@400']);
});

test('unsubscribe and resubscribe are safe during a draw', () => {
  const env = fakeEnv();
  const s = m.createFrameScheduler(env.api);
  const log = [];
  let unsubB = () => {};
  let resubscribedOnce = false;
  const c = stepper('c', [], log);
  const a = {
    nextChangeAt: (now) => (now < 100 ? 100 : null),
    draw: (now) => {
      log.push(`a@${now}`);
      if (now === 100) {
        unsubB();
        s.subscribe(c);
        if (!resubscribedOnce) { resubscribedOnce = true; s.subscribe(a); }
      }
    },
  };
  s.subscribe(a);
  unsubB = s.subscribe(stepper('b', [100], log));
  env.flushFrames();
  env.t = 100;
  for (const [id, timer] of [...env.timers]) if (timer.at <= 100) { env.timers.delete(id); timer.fn(); }
  env.flushFrames();
  assert.deepEqual(log, ['a@0', 'b@0', 'a@100'], 'b is skipped once removed during the frame');
  assert.equal(env.frames.length, 1, 'c and the resubscribed a wait for the next frame');
  env.flushFrames();
  assert.deepEqual(log.slice(3), ['a@100', 'c@100']);
  assert.equal(s.size(), 2);
  unsubB();
  assert.equal(s.size(), 2, 'a stale unsubscribe is a no-op');
  s.dispose();
  assert.equal(s.size(), 0);
  assert.equal(env.visibility, null, 'visibility listener removed');
});

test('a draw that throws does not stop other sprites', () => {
  const env = fakeEnv();
  const s = m.createFrameScheduler(env.api);
  const log = [];
  s.subscribe({ nextChangeAt: () => 50, draw: () => { throw new Error('boom'); } });
  s.subscribe(stepper('ok', [100], log));
  assert.throws(() => env.flushFrames(), /boom/);
  assert.deepEqual(log, ['ok@0']);
  env.advance(100);
  assert.deepEqual(log, ['ok@0', 'ok@100']);
});

/* ---------------------------------------------------------------- animators */

const seq = { durations: [100, 50, 200] };

test('Animator computes frames from elapsed time, looping without drift', () => {
  const a = new m.Animator().play(seq, { loop: true, startAt: 1000 });
  const at = (t) => a.frameAt(t);
  assert.deepEqual([999, 1000, 1099, 1100, 1149, 1150, 1349, 1350, 1450].map(at), [0, 0, 0, 1, 1, 2, 2, 0, 1]);
  assert.equal(at(1000 + 350 * 1000 + 120), 1, 'a thousand loops later lands on the same frame');
  assert.equal(a.nextChangeAt(1000), 1100);
  assert.equal(a.nextChangeAt(1100), 1150);
  assert.equal(a.nextChangeAt(1200), 1350, 'last frame changes back to frame 0');
  assert.equal(a.nextChangeAt(500), 1100);
  assert.equal(a.done(1e9), false);
});

test('Animator plays once and either holds the last frame or returns to frame 0', () => {
  const hold = new m.Animator().play(seq, { holdLast: true, startAt: 0 });
  assert.deepEqual([0, 120, 300, 349, 350, 5000].map((t) => hold.frameAt(t)), [0, 1, 2, 2, 2, 2]);
  assert.equal(hold.done(349), false);
  assert.equal(hold.done(350), true);
  assert.equal(hold.nextChangeAt(200), 350, 'the end is reported so the sprite can react');
  assert.equal(hold.nextChangeAt(350), null);

  const back = new m.Animator().play(seq, { startAt: 0 });
  assert.equal(back.frameAt(349), 2);
  assert.equal(back.frameAt(350), 0);
  assert.equal(back.nextChangeAt(350), null);

  const twice = new m.Animator().play(seq, { repeat: 2, startAt: 0 });
  assert.equal(twice.frameAt(360), 0);
  assert.equal(twice.frameAt(460), 1);
  assert.equal(twice.done(699), false);
  assert.equal(twice.done(700), true);
  assert.equal(twice.nextChangeAt(600), 700);

  const single = new m.Animator().play({ durations: [300] }, { loop: true });
  assert.equal(single.nextChangeAt(10), null, 'a one-frame loop never needs a redraw');
  assert.throws(() => new m.Animator().play({ durations: [] }), RangeError);
  assert.throws(() => new m.Animator().play({ durations: [100, 0] }), RangeError);
  const unplayed = new m.Animator();
  assert.equal(unplayed.frameAt(5), 0);
  assert.equal(unplayed.nextChangeAt(5), null);
});

test('calm idle rests 2-5 s on frame 0 between full loops, from an injected random source', () => {
  const draws = [0, 1, 0.5];
  let calls = 0;
  const random = () => draws[calls++ % draws.length];
  const idle = m.idleWithRests(random, { startAt: 0 });
  const total = m.rowDurationMs('idle');
  assert.equal(total, 1100);
  // pass 1: 0-1100, rest 2000; pass 2: 3100-4200, rest 5000; pass 3: 9200-10300, rest 3500
  assert.deepEqual([0, 280, 390, 500, 640, 780, 1099].map((t) => idle.frameAt(t)), [0, 1, 2, 3, 4, 5, 5]);
  assert.equal(idle.frameAt(1100), 0);
  assert.equal(idle.nextChangeAt(780), 1100);
  assert.equal(idle.nextChangeAt(1100), 3100 + 280, 'rest flows into the next pass frame 0 without a redraw');
  assert.equal(idle.frameAt(3100 + 279), 0);
  assert.equal(idle.frameAt(3100 + 280), 1);
  assert.equal(idle.nextChangeAt(4200), 9200 + 280, 'second rest is 5 s');
  assert.equal(idle.frameAt(9200 + 400), 2);
  assert.equal(idle.nextChangeAt(10300), 10300 + 3500 + 280);
  assert.equal(idle.done(1e6), false);

  let changes = 0;
  const calm = m.idleWithRests(() => 0.5, { startAt: 0 });
  for (let t = 0, n = 0; t !== null && t < 60_000 && n < 1000; n++) {
    t = calm.nextChangeAt(t);
    changes++;
  }
  assert.ok(changes / 60 <= 3, `about ${(changes / 60).toFixed(2)} redraws a second at idle`);
});

/* ---------------------------------------------------------------- adapter */

const rest = { ...m.RESTING_SIGNALS };
const sig = (over) => ({ ...rest, ...over });
const viewOf = (signals, now = 1000) => {
  const a = m.createPetAdapter();
  a.signal(sig(signals), 0);
  return a.view(now);
};

test('priority: drag at |vx| >= 60 beats failure, waiting and work', () => {
  const busy = { failure: 'network', awaitingPerson: true, requestInFlight: true, surface: 'working' };
  assert.equal(viewOf({ ...busy, dragVx: 60 }).state, 'running-right');
  assert.equal(viewOf({ ...busy, dragVx: -240 }).state, 'running-left');
  const v = viewOf({ dragVx: 61 });
  assert.equal(v.loop, true);
  assert.match(v.reason, /drag/);
  assert.equal(viewOf({ dragVx: 59.9 }).state, 'idle', 'slow drag carries the idle pet');
  assert.match(viewOf({ dragVx: 10 }).reason, /move it/);
  assert.equal(viewOf({ dragVx: -59, failure: 'network' }).state, 'failed');
  assert.equal(viewOf({ dragVx: Number.NaN }).state, 'idle');
});

test('priority: failure plays once then holds; cancel is idle; a decline is not a failure', () => {
  const f = viewOf({ failure: 'provider', surface: 'error', awaitingPerson: true, requestInFlight: true });
  assert.equal(f.state, 'failed');
  assert.equal(f.loop, false);
  assert.equal(f.plays, 1);
  assert.equal(f.holdLast, true);
  assert.equal(f.until, null, 'held while the error shows');
  assert.match(f.reason, /provider returned an error/);
  for (const failure of ['setup', 'refused', 'truncated', 'steps', 'network']) {
    const v = viewOf({ failure, surface: 'error' });
    assert.equal(v.state, 'failed');
    assert.ok(v.reason.length > 10 && v.reason.length < 80);
  }
  const cancelled = viewOf({ failure: 'cancelled', surface: 'error' });
  assert.equal(cancelled.state, 'idle');
  assert.match(cancelled.reason, /cancelled/);
  // Declining a confirmation clears awaitingPerson and reports no failure.
  const a = m.createPetAdapter();
  a.signal(sig({ surface: 'working', requestInFlight: true, awaitingPerson: true }), 0);
  assert.equal(a.view(10).state, 'waiting');
  a.signal(sig({ surface: 'answer' }), 20);
  assert.notEqual(a.view(30).state, 'failed');
  assert.equal(a.view(30).state, 'idle');
});

test('priority: waiting beats work; work comes from a request in flight or the working surface', () => {
  const w = viewOf({ awaitingPerson: true, requestInFlight: true, surface: 'working' });
  assert.equal(w.state, 'waiting');
  assert.equal(w.loop, true);
  assert.equal(w.reason, 'Waiting for your answer in the confirmation');
  assert.equal(viewOf({ requestInFlight: true, surface: 'command' }).state, 'running');
  const r = viewOf({ surface: 'working' });
  assert.equal(r.state, 'running');
  assert.equal(r.loop, true);
  assert.equal(r.since, 0);
});

test('one-shots play once for exactly one pass, then expire', () => {
  const a = m.createPetAdapter();
  a.signal(sig({ surface: 'command' }), 0);
  a.event({ kind: 'invoked' }, 1000);
  const wave = a.view(1000);
  assert.deepEqual({ state: wave.state, loop: wave.loop, plays: wave.plays, since: wave.since, until: wave.until }, { state: 'waving', loop: false, plays: 1, since: 1000, until: 1700 });
  assert.equal(a.view(1699).state, 'waving');
  const after = a.view(1700);
  assert.equal(after.state, 'idle');
  assert.equal(after.since, 1700, 'idle restarts when the one-shot ends');

  a.event({ kind: 'verified-change' }, 2000);
  assert.equal(a.view(2000).state, 'jumping');
  assert.equal(a.view(2000).until, 2840);
  a.event({ kind: 'invoked' }, 2100);
  assert.equal(a.view(2100).state, 'jumping', 'a wave does not cut a verified-change jump short');
  a.event({ kind: 'verified-change' }, 2200);
  assert.equal(a.view(2200).since, 2200, 'a new verified change restarts the jump');
  assert.equal(a.view(3040).state, 'idle');

  const busy = m.createPetAdapter();
  busy.signal(sig({ requestInFlight: true }), 0);
  busy.event({ kind: 'verified-change' }, 100);
  assert.equal(busy.view(200).state, 'running', 'work outranks one-shots');
  busy.signal(sig({}), 1500);
  assert.equal(busy.view(1500).state, 'idle', 'an expired one-shot is not replayed later');
});

test('review plays twice after answer-shown on the answer surface, then falls through', () => {
  const a = m.createPetAdapter();
  a.signal(sig({ surface: 'answer' }), 0);
  assert.equal(a.view(10).state, 'idle', 'no review without the event');
  a.event({ kind: 'answer-shown' }, 100);
  const r = a.view(100);
  assert.equal(r.state, 'review');
  assert.equal(r.plays, 2);
  assert.equal(r.loop, false);
  assert.equal(r.until, 100 + 2 * 1030);
  assert.equal(a.view(2159).state, 'review');
  assert.equal(a.view(2160).state, 'idle');
  assert.equal(a.view(2160).since, 2160);

  const left = m.createPetAdapter();
  left.signal(sig({ surface: 'answer' }), 0);
  left.event({ kind: 'answer-shown' }, 0);
  left.signal(sig({ surface: 'command' }), 300);
  left.signal(sig({ surface: 'answer' }), 400);
  assert.equal(left.view(500).state, 'idle', 'leaving the answer ends its review');

  const early = m.createPetAdapter();
  early.signal(sig({ surface: 'working' }), 0);
  early.event({ kind: 'answer-shown' }, 50);
  early.signal(sig({ surface: 'answer' }), 60);
  assert.equal(early.view(70).state, 'review', 'the event may arrive just before the surface');
});

test('gaze looks at round(gaze / 22.5) mod 16 at rest or in command only', () => {
  const look = viewOf({ gaze: 157.5 });
  assert.deepEqual({ ...look }, { kind: 'look', index: 7, reason: 'Looking toward your pointer' });
  assert.equal(viewOf({ gaze: 350, surface: 'command' }).index, 0);
  assert.equal(viewOf({ gaze: 11.26 }).index, 1);
  assert.equal(viewOf({ gaze: null }).state, 'idle', 'deadzone shows idle');
  assert.equal(viewOf({ gaze: Number.POSITIVE_INFINITY }).state, 'idle');
  assert.equal(viewOf({ gaze: 90, requestInFlight: true }).state, 'running', 'gaze ignored while working');
  assert.equal(viewOf({ gaze: 90, surface: 'working' }).state, 'running');
  assert.equal(viewOf({ gaze: 90, surface: 'answer' }).state, 'idle');
  assert.equal(viewOf({ gaze: 90, surface: 'error' }).state, 'idle');
  assert.equal(viewOf({ gaze: 90, awaitingPerson: true }).state, 'waiting');
  const a = m.createPetAdapter();
  a.signal(sig({ gaze: 90 }), 0);
  a.event({ kind: 'invoked' }, 10);
  assert.equal(a.view(20).state, 'waving', 'one-shots outrank gaze');
});

test('reduced motion shows still key frames and never gazes', () => {
  const still = (over, now = 1000) => viewOf({ reducedMotion: true, ...over }, now);
  const cases = [
    [{}, 'idle', 0],
    [{ awaitingPerson: true }, 'waiting', 2],
    [{ requestInFlight: true }, 'running', 2],
    [{ failure: 'network' }, 'failed', 7],
    [{ dragVx: 300 }, 'running-right', 0],
    [{ dragVx: -300 }, 'running-left', 0],
  ];
  for (const [over, state, frame] of cases) {
    const v = still(over);
    assert.equal(v.state, state);
    assert.equal(v.still, true);
    assert.equal(v.frame, frame, `${state} key frame`);
    assert.equal(v.loop, false);
    assert.equal(v.plays, 0);
  }
  assert.equal(still({ gaze: 45 }).kind, 'state', 'no gaze under reduced motion');
  const a = m.createPetAdapter();
  a.signal(sig({ reducedMotion: true, surface: 'answer' }), 0);
  a.event({ kind: 'invoked' }, 0);
  assert.equal(a.view(10).frame, 2, 'waving key frame');
  assert.equal(a.view(10).until, 700, 'still one-shots keep their window');
  a.event({ kind: 'verified-change' }, 800);
  assert.equal(a.view(810).state, 'jumping');
  assert.equal(a.view(810).frame, 0, 'no jump');
  a.event({ kind: 'answer-shown' }, 2000);
  assert.equal(a.view(2010).frame, 2, 'review key frame');
  assert.equal(viewOf({}).still, false);
  assert.equal(viewOf({}).frame, null);
});

test('states keep their start time across unrelated signals and every view has a reason', () => {
  const a = m.createPetAdapter();
  a.signal(sig({ requestInFlight: true }), 100);
  a.signal(sig({ requestInFlight: true, surface: 'working' }), 400);
  assert.equal(a.view(500).since, 100, 'the work loop does not restart');
  a.signal(sig({ failure: 'network', surface: 'error' }), 600);
  a.signal(sig({ failure: 'provider', surface: 'error' }), 700);
  assert.equal(a.view(800).since, 600, 'failed is not replayed when the failure detail changes');
  a.signal(sig({}), 900);
  a.signal(sig({ gaze: 30 }), 950);
  a.signal(sig({}), 990);
  assert.equal(a.view(1000).since, 900, 'gaze does not restart idle');
  const reasons = new Set();
  for (const over of [{}, { surface: 'command' }, { surface: 'answer' }, { surface: 'error' }, { gaze: 10 }, { dragVx: 100 }, { failure: 'steps' }, { awaitingPerson: true }, { requestInFlight: true }]) {
    const v = viewOf(over);
    assert.equal(typeof v.reason, 'string');
    assert.ok(v.reason.length > 0 && v.reason.length <= 80);
    reasons.add(v.reason);
  }
  assert.ok(reasons.size >= 8, 'reasons describe the actual signal');
  assert.ok(Object.isFrozen(viewOf({})));
});
