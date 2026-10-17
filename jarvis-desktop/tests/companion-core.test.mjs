// Desktop companion window policy (electron/companionCore.ts): its own IPC table stays separate from the hub's, senders are
// trusted only from the exact companion page, layout requests are clamped and docked inside the work area, and screen
// selections map to the captured image correctly at 100/125/150/200% display scaling. No Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'companion-core-entry.ts',
    loader: 'ts',
    contents: `
      export * from './electron/companionCore.ts';
      export { METHODS } from './electron/channels.ts';
      export { isTrustedUrl, validateArgsAgainst } from './electron/ipcCore.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const dist = path.join(root, 'dist');
const companionFile = pathToFileURL(path.join(dist, 'companion.html')).href;
const indexFile = pathToFileURL(path.join(dist, 'index.html')).href;
const dev = 'http://localhost:5173';

test('companion methods are separate from the hub table and every one has an argument spec', () => {
  for (const c of m.COMPANION_METHODS) assert.ok(!m.METHODS.includes(c), `${c} must not be a hub method`);
  assert.deepEqual(Object.keys(m.COMPANION_ARG_SPECS).sort(), [...m.COMPANION_METHODS].sort());
  for (const o of m.OVERLAY_METHODS) assert.ok(m.COMPANION_METHODS.includes(o));
  assert.equal(m.companionChannel('companionAsk'), 'companion:companionAsk');
  assert.ok(!m.companionChannel('companionAsk').startsWith('jarvis:'));
});

test('the hub preload does not expose companion channels and the companion preload exposes only them', async () => {
  const hub = await readFile(path.join(root, 'electron/preload.ts'), 'utf8');
  assert.ok(!/companion:/.test(hub) && !/companionChannel/.test(hub));
  const cmp = await readFile(path.join(root, 'electron/companionPreload.ts'), 'utf8');
  assert.ok(!/channel\(/.test(cmp.replace(/companionChannel\(/g, '')), 'no hub channel() calls');
  assert.ok(!/require\(|process\./.test(cmp), 'no Node access');
  const used = [...cmp.matchAll(/call\('([A-Za-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(used)].sort(), [...m.COMPANION_METHODS].sort());
});

test('only the exact companion page is a trusted companion sender', () => {
  assert.equal(m.isTrustedCompanionUrl(companionFile, companionFile), true);
  assert.equal(m.isTrustedCompanionUrl(`${companionFile}#overlay`, companionFile), true);
  assert.equal(m.isTrustedCompanionUrl(indexFile, companionFile), false);
  assert.equal(m.isTrustedCompanionUrl('file://evil-host/companion.html', companionFile), false);
  assert.equal(m.isTrustedCompanionUrl('https://example.com/companion.html', companionFile, dev), false);
  assert.equal(m.isTrustedCompanionUrl(`${dev}/companion.html`, companionFile), false, 'dev origin only when given');
  assert.equal(m.isTrustedCompanionUrl(`${dev}/companion.html`, companionFile, dev), true);
  assert.equal(m.isTrustedCompanionUrl(`${dev}/index.html`, companionFile, dev), false);
  assert.equal(m.isTrustedCompanionUrl('http://localhost:5174/companion.html', companionFile, dev), false);
  assert.equal(m.isTrustedCompanionUrl(undefined, companionFile), false);
  assert.equal(m.isTrustedCompanionUrl('not a url', companionFile), false);
  // And the hub keeps refusing the packaged companion page.
  assert.equal(m.isTrustedUrl(companionFile, indexFile), false);
});

test('companion arguments are checked before any handler runs', () => {
  const check = (method, args) => m.validateArgsAgainst(method, m.COMPANION_ARG_SPECS[method], args);
  assert.equal(check('companionAsk', ['What is this?']), null);
  assert.equal(check('companionAsk', ['What is this?', 'a'.repeat(36)]), null);
  assert.ok(check('companionAsk', ['']));
  assert.ok(check('companionAsk', ['x'.repeat(2001)]));
  assert.ok(check('companionAsk', ['ok', 'short']), 'region tokens are long random ids');
  assert.ok(check('companionAsk', [42]));
  assert.equal(check('companionAsk', ['type it', undefined, true]), null, 'the remembered window is opted in per request');
  assert.ok(check('companionAsk', ['type it', undefined, 'yes']));
  assert.equal(check('companionClearTarget', []), null);
  assert.ok(check('companionCancel', ['extra']));
  assert.ok(check('companionOpenHub', ['developer']), 'only listed hub views');
  assert.equal(check('companionOpenHub', ['notes', 'n_123']), null);
  assert.ok(check('companionSetMaterial', ['mica']));
  assert.ok(check('companionLayout', ['wide']));
  assert.equal(check('companionDrag', ['start']), null);
  assert.ok(check('companionDrag', ['move']), 'the page cannot send a position or a move step');
  assert.ok(check('companionDrag', [{x: 1, y: 2}]));
  assert.ok(check('companionHit', ['yes']));
  assert.equal(check('companionHit', [true]), null);
  assert.ok(check('companionResize', [200]), 'sizes are presets or steps, not numbers');
  assert.ok(check('companionDock', ['center']));
  assert.ok(check('companionGaze', [1]));
  assert.ok(check('companionSetAppearance', ['orb']));
});

test('the page asks only for a bubble size, which is clamped; never a position', () => {
  assert.deepEqual(m.parseBubbleLayout({bubble: {width: 440, height: 300}}), {bubble: {width: 440, height: 300}});
  assert.deepEqual(m.parseBubbleLayout({bubble: null}), {bubble: null});
  assert.deepEqual(m.parseBubbleLayout({bubble: {width: 99999, height: 1}}), {bubble: {width: m.BUBBLE_LIMITS.maxW, height: m.BUBBLE_LIMITS.minH}});
  assert.equal(m.parseBubbleLayout({bubble: {width: 400, height: 300, x: 0}}), null, 'no position from the page');
  assert.equal(m.parseBubbleLayout({bubble: {width: 400, height: 300}, x: 5}), null);
  assert.equal(m.parseBubbleLayout({bubble: {width: Number.NaN, height: 300}}), null);
  assert.equal(m.parseBubbleLayout({}), null);
  assert.equal(m.parseBubbleLayout([400, 300]), null);
});

const inside = (r, w) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width && r.y + r.height <= w.y + w.height;
const globalRect = (pl, r) => ({x: pl.window.x + r.x, y: pl.window.y + r.y, width: r.width, height: r.height});
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const WORKS = [
  {x: 0, y: 0, width: 1280, height: 680},
  {x: -1920, y: 0, width: 1920, height: 1040},
  {x: 2560, y: -300, width: 1536, height: 824},
  {x: 0, y: 0, width: 520, height: 400},
];

test('the pet stands on its ground point, keeps the cell aspect and stays inside the work area', () => {
  assert.deepEqual(m.petBox({x: 100, y: 500}, 96), {x: 56, y: 404, width: 89, height: 96});
  assert.equal(m.petWidth(128), Math.round(128 * 192 / 208));
  for (const work of WORKS) {
    for (const p of [{x: -99999, y: -99999}, {x: 99999, y: 99999}, {x: work.x + 10, y: work.y + 10}]) {
      for (const size of [64, 96, 128]) assert.ok(inside(m.petBox(m.clampPetPoint(p, size, work), size), work));
    }
  }
  assert.equal(m.clampSize(10), 64);
  assert.equal(m.clampSize(500), 128);
  assert.equal(m.resizePet(96, 'grow'), 104);
  assert.equal(m.resizePet(128, 'grow'), 128);
  assert.equal(m.resizePet(64, 'shrink'), 64);
  assert.equal(m.resizePet(100, 'S'), 64);
  assert.equal(m.resizePet(64, 'L'), 128);
});

test('docking: presets land inside the work area, and a drag near an edge snaps to it (bottom wins)', () => {
  for (const work of WORKS) {
    for (const t of ['bottom-left', 'bottom-right', 'left', 'right', 'top']) {
      for (const size of [64, 96, 128]) {
        const d = m.dockPoint(t, size, work);
        assert.ok(inside(m.petBox(d.point, size), work), `${t} ${size} ${JSON.stringify(work)}`);
      }
    }
  }
  const work = WORKS[0];
  const br = m.dockPoint('bottom-right', 96, work);
  assert.equal(br.dock, 'bottom');
  assert.equal(br.point.y, work.height - m.DOCK_INSET);
  assert.equal(m.petBox(br.point, 96).x + m.petWidth(96), work.width - m.DOCK_INSET);
  // Dropped 20 px above the taskbar: snaps onto it.
  const s1 = m.snapDock({x: 600, y: work.height - 20}, 96, work);
  assert.deepEqual([s1.dock, s1.point.y], ['bottom', work.height - m.DOCK_INSET]);
  // Bottom-left corner: bottom wins the tie.
  assert.equal(m.snapDock({x: 40, y: work.height - 5}, 96, work).dock, 'bottom');
  // Near the left edge only.
  const s2 = m.snapDock({x: 70, y: 300}, 96, work);
  assert.equal(s2.dock, 'left');
  assert.equal(m.petBox(s2.point, 96).x, m.DOCK_INSET);
  // In the middle: stays where dropped.
  assert.deepEqual(m.snapDock({x: 640, y: 400}, 96, work), {point: {x: 640, y: 400}, dock: 'free'});
});

test('the bubble sits beside the pet facing the middle of the screen, never covers it, and the pet never moves for it', () => {
  for (const work of WORKS) {
    for (const t of ['bottom-left', 'bottom-right', 'left', 'right', 'top']) {
      for (const bubble of [null, {width: 200, height: 52}, {width: 440, height: 420}, {width: 520, height: 620}]) {
        const {point} = m.dockPoint(t, 96, work);
        const pl = m.placePet(point, 96, bubble, work);
        const pet = globalRect(pl, pl.pet);
        assert.deepEqual(pet, m.petBox(point, 96), 'the pet stays on its ground point');
        assert.ok(inside(pl.window, work), `window inside: ${t} ${JSON.stringify(bubble)} ${JSON.stringify(work)}`);
        assert.ok(inside(pet, pl.window));
        if (bubble) {
          const b = globalRect(pl, pl.bubble);
          assert.ok(inside(b, work) && inside(b, pl.window));
          // When the screen can hold both side by side or stacked, the bubble never covers the pet.
          const room = bubble.width + m.petWidth(96) + 8 <= work.width || bubble.height + 96 + 8 <= work.height;
          if (room) assert.ok(!overlaps(b, pet), `bubble does not cover the pet: ${t} ${JSON.stringify(bubble)} ${JSON.stringify(work)}`);
          else assert.ok(b.height < bubble.height || !overlaps(b, pet), 'too small for both: the bubble is cut, not laid over the pet');
        } else {
          assert.equal(pl.bubble, null);
        }
      }
    }
  }
  const work = WORKS[0];
  const right = m.placePet(m.dockPoint('bottom-right', 96, work).point, 96, {width: 440, height: 300}, work);
  assert.equal(right.side, 'left', 'pet at the right edge: bubble opens towards the middle');
  const left = m.placePet(m.dockPoint('bottom-left', 96, work).point, 96, {width: 440, height: 300}, work);
  assert.equal(left.side, 'right');
  const narrow = m.placePet(m.dockPoint('bottom-right', 96, WORKS[3]).point, 96, {width: 520, height: 200}, WORKS[3]);
  assert.equal(narrow.side, 'above', 'no room beside: above');
  const top = m.placePet(m.dockPoint('top', 96, {x: 0, y: 0, width: 520, height: 680}).point, 96, {width: 520, height: 200}, {x: 0, y: 0, width: 520, height: 680});
  assert.equal(top.side, 'below', 'docked at the top with no room beside: below');
  // Rest window is just the pet plus the shadow margin.
  const rest = m.placePet({x: 640, y: 400}, 96, null, work);
  assert.deepEqual([rest.window.width, rest.window.height], [m.petWidth(96) + 2 * m.LAYOUT_MARGIN, 96 + 2 * m.LAYOUT_MARGIN]);
});

test('gaze is one of 16 clockwise look directions from the head, null inside the pet', () => {
  const pet = {x: 100, y: 100, width: 89, height: 96};
  const hx = 100 + 89 / 2, hy = 100 + 96 * 0.35;
  assert.equal(m.gazeBucket({x: hx, y: hy - 300}, pet), 0, 'up');
  assert.equal(m.gazeBucket({x: hx + 300, y: hy}, pet), 4, 'screen-right is 090');
  assert.equal(m.gazeBucket({x: hx, y: hy + 300}, pet), 8, 'down is 180');
  assert.equal(m.gazeBucket({x: hx - 300, y: hy}, pet), 12, 'screen-left is 270');
  assert.equal(m.gazeBucket({x: hx + 300, y: hy - 300}, pet), 2, 'up-right is 045');
  assert.equal(m.gazeBucket({x: hx - 300, y: hy - 300}, pet), 14, 'up-left is 315');
  assert.equal(m.gazeBucket({x: hx - 10, y: hy - 300}, pet), 0, 'slightly left of up rounds to 000, not 337.5');
  assert.equal(m.gazeBucket({x: 120, y: 150}, pet), null, 'inside the pet: deadzone');
});

test('selections are clipped to the display and tiny ones are refused', () => {
  const d = {width: 1536, height: 864};
  assert.deepEqual(m.parseSelection({x: 10, y: 20, width: 300, height: 200}, d), {x: 10, y: 20, width: 300, height: 200});
  assert.deepEqual(m.parseSelection({x: 1400, y: 800, width: 500, height: 500}, d), {x: 1400, y: 800, width: 136, height: 64});
  assert.deepEqual(m.parseSelection({x: -50, y: -50, width: 100, height: 100}, d), {x: 0, y: 0, width: 100, height: 100});
  assert.equal(m.parseSelection({x: 0, y: 0, width: 5, height: 300}, d), null);
  assert.equal(m.parseSelection({x: 0, y: 0, width: 50, height: 50, extra: 1}, d), null);
  assert.equal(m.parseSelection({x: '0', y: 0, width: 50, height: 50}, d), null);
  assert.equal(m.parseSelection(null, d), null);
});

test('crops map display DIP to the captured image at common Windows scale factors', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const dip = {width: 1536, height: 864};
    const img = {width: Math.round(dip.width * scale), height: Math.round(dip.height * scale)};
    const crop = m.cropForSelection({x: 100, y: 50, width: 400, height: 300}, dip, img);
    assert.equal(crop.x, Math.floor(100 * scale));
    assert.equal(crop.y, Math.floor(50 * scale));
    assert.equal(crop.width, Math.ceil(400 * scale));
    assert.equal(crop.height, Math.ceil(300 * scale));
    // The whole display maps to the whole image, never past its edge.
    assert.deepEqual(m.cropForSelection({x: 0, y: 0, ...dip}, dip, img), {x: 0, y: 0, ...img});
    const edge = m.cropForSelection({x: dip.width - 13, y: dip.height - 13, width: 13, height: 13}, dip, img);
    assert.ok(edge.x + edge.width <= img.width && edge.y + edge.height <= img.height);
  }
});

test('large crops are scaled down to the longest-edge limit, small ones are sent as they are', () => {
  assert.deepEqual(m.sendSize({width: 800, height: 600}), {width: 800, height: 600});
  assert.deepEqual(m.sendSize({width: 3840, height: 2160}), {width: m.REGION_MAX_EDGE, height: Math.round(2160 * (m.REGION_MAX_EDGE / 3840))});
  assert.deepEqual(m.sendSize({width: 1000, height: 4000}), {width: 392, height: m.REGION_MAX_EDGE});
});
