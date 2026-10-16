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
  assert.ok(check('companionCancel', ['extra']));
  assert.ok(check('companionOpenHub', ['developer']), 'only listed hub views');
  assert.equal(check('companionOpenHub', ['notes', 'n_123']), null);
  assert.ok(check('companionSetMaterial', ['mica']));
  assert.ok(check('companionLayout', ['wide']));
});

test('layout requests are validated and clamped, never trusted as given', () => {
  assert.deepEqual(m.parseLayout({width: 440, height: 300, anchor: 'corner'}), {width: 440, height: 300, anchor: 'corner'});
  assert.deepEqual(m.parseLayout({width: 99999, height: 1, anchor: 'top', release: true}), {width: m.LAYOUT_LIMITS.maxW, height: m.LAYOUT_LIMITS.minH, anchor: 'top'});
  assert.equal(m.parseLayout({width: 400, height: 300, anchor: 'left'}), null);
  assert.equal(m.parseLayout({width: Number.NaN, height: 300, anchor: 'corner'}), null);
  assert.equal(m.parseLayout({width: 400, height: 300, anchor: 'corner', x: 0}), null, 'no position from the page');
  assert.equal(m.parseLayout({width: 400, height: 300, anchor: 'corner', release: 'yes'}), null);
  assert.equal(m.parseLayout([400, 300]), null);
});

test('the island docks inside the work area on any display, including ones left of or above the primary', () => {
  const M = m.LAYOUT_MARGIN;
  const inside = (r, w) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width && r.y + r.height <= w.y + w.height;
  const works = [
    {x: 0, y: 0, width: 1280, height: 680},
    {x: -1920, y: 0, width: 1920, height: 1040},
    {x: 2560, y: -300, width: 1536, height: 824},
    {x: 0, y: 0, width: 300, height: 200},
  ];
  for (const work of works) {
    for (const anchor of ['corner', 'top', 'right']) {
      for (const size of [{width: 196, height: 52}, {width: 440, height: 420}, {width: 820, height: 680}]) {
        const r = m.placeIsland(work, {...size, anchor});
        assert.ok(inside(r, work), `${anchor} ${JSON.stringify(size)} on ${JSON.stringify(work)} → ${JSON.stringify(r)}`);
      }
    }
  }
  // The window never leaves the work area, so the island body sits max(inset, margin) from the docked edges.
  const work = works[0];
  const gap = Math.max(12, M);
  const c = m.placeIsland(work, {width: 196, height: 52, anchor: 'corner'});
  assert.deepEqual(c, {x: 1280 - 196 - M - gap, y: 680 - 52 - M - gap, width: 196 + 2 * M, height: 52 + 2 * M});
  // Growing keeps the docked corner fixed.
  const g = m.placeIsland(work, {width: 440, height: 420, anchor: 'corner'});
  assert.equal(g.x + g.width - M, work.width - gap);
  assert.equal(g.y + g.height - M, work.height - gap);
  const t = m.placeIsland(work, {width: 440, height: 300, anchor: 'top'});
  assert.equal(t.y + M, gap);
  assert.equal(t.x + t.width / 2, 640);
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
