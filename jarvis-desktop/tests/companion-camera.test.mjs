// Camera-island appearance (backend): a fixed capsule at the top centre of the work area with the bubble directly below,
// always inside the work area (taskbar respected, tiny screens, negative origins, fractional DPI work areas); the third
// appearance value in the IPC enum and saved preferences; new profiles start as the camera island while existing ones
// keep their look; drag, resize and dock are no-ops in camera mode; no overlay, full-screen or maximize path exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'camera-entry.ts', loader: 'ts',
    contents: `
      export { placeCameraIsland, placePet, parseCompanionPrefs, CAMERA_ISLAND, APPEARANCES, COMPANION_ARG_SPECS, LAYOUT_MARGIN, PET_SIZE } from './electron/companionCore.ts';
      export { validateArgsAgainst } from './electron/ipcCore.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const abs = (p, r) => ({x: p.window.x + r.x, y: p.window.y + r.y, width: r.width, height: r.height});
const inside = (r, w) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width + 1e-9 && r.y + r.height <= w.y + w.height + 1e-9;

test('collapsed: a 236×38 capsule centred at the top of the work area, 8 DIP down; the window hugs it', () => {
  const work = {x: 0, y: 0, width: 1920, height: 1032};
  const p = m.placeCameraIsland(null, work);
  assert.deepEqual(abs(p, p.pet), {x: 842, y: 8, width: 236, height: 38});
  assert.equal(p.bubble, null);
  assert.equal(p.side, null);
  assert.ok(inside(p.window, work));
  assert.ok(p.window.width <= 236 + 2 * m.LAYOUT_MARGIN && p.window.height <= 38 + 8 + m.LAYOUT_MARGIN, 'a small window, never a full-screen overlay');
});

test('expanded: the bubble is centred directly below the capsule, side below', () => {
  const work = {x: 0, y: 40, width: 1920, height: 1000}; // a taskbar at the top moves the work area down
  const p = m.placeCameraIsland({width: 420, height: 300}, work);
  const cap = abs(p, p.pet), bub = abs(p, p.bubble);
  assert.deepEqual(cap, {x: 842, y: 48, width: 236, height: 38});
  assert.deepEqual(bub, {x: 750, y: 48 + 38 + m.CAMERA_ISLAND.gap, width: 420, height: 300});
  assert.equal(p.side, 'below');
  assert.equal(cap.x + cap.width / 2, bub.x + bub.width / 2, 'same centre line');
  assert.ok(inside(p.window, work) && inside(cap, work) && inside(bub, work));
});

test('negative origins, secondary displays and fractional DPI work areas stay inside their own work area', () => {
  const works = [
    {x: -1280, y: -200, width: 1280, height: 984},   // display to the left and above the primary
    {x: 1920, y: 0, width: 1536, height: 824},       // 1920×1080 physical at 125 %
    {x: 0, y: 0, width: 1280, height: 672},          // 1920×1080 at 150 %
    {x: 3456, y: 0, width: 1229.6, height: 690.4},   // fractional DIP from an odd scale
  ];
  for (const work of works) {
    for (const bubble of [null, {width: 520, height: 620}, {width: 160, height: 44}]) {
      const p = m.placeCameraIsland(bubble, work);
      assert.ok(inside(p.window, work), JSON.stringify({work, bubble, w: p.window}));
      assert.ok(inside(abs(p, p.pet), work));
      if (p.bubble) assert.ok(inside(abs(p, p.bubble), work));
      assert.ok(Math.abs(abs(p, p.pet).x + abs(p, p.pet).width / 2 - (work.x + work.width / 2)) <= 1, 'top centre');
    }
  }
});

test('tiny work areas: everything shrinks to fit rather than leaving the screen', () => {
  for (const work of [{x: 0, y: 0, width: 200, height: 60}, {x: 10, y: 10, width: 120, height: 30}, {x: -50, y: -50, width: 300, height: 120}]) {
    const p = m.placeCameraIsland({width: 520, height: 620}, work);
    for (const r of [p.window, abs(p, p.pet), abs(p, p.bubble)]) {
      assert.ok(inside(r, work), JSON.stringify({work, r}));
      assert.ok(r.width >= 1 && r.height >= 1);
    }
  }
});

test('randomised: no rectangle ever extends outside the work area', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 500; i++) {
    const work = {x: Math.round((rnd() - 0.5) * 6000), y: Math.round((rnd() - 0.5) * 3000), width: 40 + Math.round(rnd() * 4000), height: 20 + Math.round(rnd() * 2200)};
    const bubble = rnd() < 0.2 ? null : {width: 160 + Math.round(rnd() * 360), height: 44 + Math.round(rnd() * 576)};
    const p = m.placeCameraIsland(bubble, work);
    assert.ok(inside(p.window, work));
    assert.ok(inside(abs(p, p.pet), work));
    if (p.bubble) assert.ok(inside(abs(p, p.bubble), work));
  }
});

test('the pet layout is unchanged by the camera island', () => {
  const work = {x: 0, y: 0, width: 1920, height: 1032};
  const p = m.placePet({x: 1800, y: 1020}, 96, {width: 420, height: 300}, work);
  assert.equal(p.side, 'left');
  assert.ok(abs(p, p.pet).y + abs(p, p.pet).height === 1020, 'the pet still stands at its ground point');
});

test('appearance: three values in the IPC enum; anything else is refused', () => {
  assert.deepEqual([...m.APPEARANCES], ['pet', 'legacy-orb', 'camera-island']);
  const spec = m.COMPANION_ARG_SPECS.companionSetAppearance;
  assert.equal(m.validateArgsAgainst('companionSetAppearance', spec, ['camera-island']), null);
  for (const bad of ['overlay', 'CAMERA-ISLAND', '', 3, null]) assert.notEqual(m.validateArgsAgainst('companionSetAppearance', spec, [bad]), null, String(bad));
});

test('preferences: a new profile starts as the camera island; existing profiles keep their look; bad values never win', () => {
  assert.equal(m.parseCompanionPrefs(null).appearance, 'camera-island', 'no companion.json: new profile');
  assert.equal(m.parseCompanionPrefs('').appearance, 'pet', 'unreadable file: an existing profile keeps the pet');
  assert.equal(m.parseCompanionPrefs('{not json').appearance, 'pet');
  assert.equal(m.parseCompanionPrefs('{}').appearance, 'pet', 'saved before the camera island existed');
  assert.equal(m.parseCompanionPrefs('{"appearance":"legacy-orb"}').appearance, 'legacy-orb');
  assert.equal(m.parseCompanionPrefs('{"appearance":"camera-island"}').appearance, 'camera-island');
  assert.equal(m.parseCompanionPrefs('{"appearance":"overlay"}').appearance, 'pet');
  const kept = m.parseCompanionPrefs(JSON.stringify({appearance: 'camera-island', point: {x: 1700, y: 1000}, displayId: 2, dock: 'right', size: 128, material: 'acrylic'}));
  assert.deepEqual(kept, {point: {x: 1700, y: 1000}, displayId: 2, dock: 'right', size: 128, appearance: 'camera-island', material: 'acrylic'}, 'the pet position survives camera mode');
  assert.equal(m.parseCompanionPrefs('{"size":9999}').size, m.PET_SIZE.max);
  assert.equal(m.parseCompanionPrefs('[1,2]').appearance, 'pet');
});

test('window source: camera mode refuses drag, resize and dock, stops gaze, places at once; no overlay, full-screen or maximize path', async () => {
  const src = await readFile(path.join(root, 'electron', 'companionWindow.ts'), 'utf8');
  assert.match(src, /function dragStart\(\) \{[\s\S]{0,200}camera\(\)\) return false;/);
  assert.match(src, /companionResize: \(op: ResizeOp\) => \{[\s\S]{0,160}if \(camera\(\)\) return prefs\.size;/);
  assert.match(src, /companionDock: \(target: DockTarget\) => \{\s*if \(camera\(\)\) return prefs\.dock;/);
  assert.match(src, /const on = gazeWanted && !gazeLocked && !camera\(\)/);
  assert.match(src, /companionSetAppearance: \(a: Appearance\) => \{[\s\S]{0,300}updateGaze\(\);\s*place\(\);/);
  assert.match(src, /camera\(\) \? placeCameraIsland\(bubble, work\) : placePet\(/);
  assert.match(src, /send\(\{type: 'placement', \.\.\.placement, size: prefs\.size, dock: prefs\.dock, appearance: prefs\.appearance\}\)/);
  for (const forbidden of [/\.maximize\(/, /setFullScreen\(true/, /setKiosk\(/, /setSimpleFullScreen\(/]) assert.doesNotMatch(src, forbidden);
});
