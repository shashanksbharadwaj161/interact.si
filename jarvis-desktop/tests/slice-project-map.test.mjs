import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/project-map.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {MAP_LIMITS, buildProjectMap, mapKeyboardTarget} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const now = '2026-10-20T00:00:00.000Z';
const opts = (extra = {}) => ({width:720, height:300, now, ...extra});
function data() {
  return {
    capsules: [
      {id:'c-zeta', name:'Zeta', items:[{kind:'url',target:'https://a.example',label:'a'}]},
      {id:'c-alpha2', name:'Alpha', items:[]},
      {id:'c-alpha1', name:'Alpha', items:[]},
    ],
    checkpoints: [
      {id:'cp3', title:'Third', createdAt:'2026-10-03T00:00:00.000Z', capsuleId:'c-zeta', refs:[{kind:'capsule',id:'c-zeta'},{kind:'capsule',id:'c-alpha1'}]},
      {id:'cp1', title:'First', createdAt:'2026-10-01T00:00:00.000Z', capsuleId:'c-zeta', refs:[]},
      {id:'cp2', title:'Second', createdAt:'2026-10-02T00:00:00.000Z', capsuleId:'c-zeta', refs:[{kind:'task',id:'t1'}]},
      {id:'cpbad', title:'Broken date', createdAt:'not a date', capsuleId:'c-zeta', refs:[]},
      {id:'cpnone', title:'No date', capsuleId:'c-alpha1', refs:[]},
      {id:'cpA', title:'Alpha work', createdAt:'2026-10-05T00:00:00.000Z', capsuleId:'c-alpha1', refs:[]},
      {id:'orphan', title:'No capsule', createdAt:'2026-10-04T00:00:00.000Z', refs:[]},
    ],
    tasks: [
      {id:'t1', title:'Linked task', done:false, capsuleId:'c-alpha2'},
      {id:'t2', title:'Loose task', done:true, createdAt:'2026-10-01T00:00:00.000Z'},
    ],
  };
}
const lane = (m, id) => m.lanes.find((l) => l.capsuleId === id);
const node = (m, id) => m.lanes.flatMap((l) => l.nodes).find((n) => n.id === id);

test('lanes are ordered by capsule name then id, and output is frozen and deterministic', () => {
  const m = buildProjectMap(data(), opts());
  assert.deepEqual(m.lanes.map((l) => l.capsuleId), ['c-alpha1','c-alpha2','c-zeta']);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.lanes[0].nodes[0]) && Object.isFrozen(m.edges));
  assert.deepEqual(buildProjectMap(data(), opts()), m);
  const ys = m.lanes.map((l) => l.y);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2]);
  for (const n of m.lanes.flatMap((l) => l.nodes)) assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y));
  assert.equal(node(m, 'checkpoint:orphan'), undefined, 'records without a lane are not invented into one');
  assert.equal(node(m, 'task:t2'), undefined);
  assert.equal(node(m, 'task:t1').y, lane(m, 'c-alpha2').y);
});

test('dated checkpoints are placed monotonically by createdAt within the time range', () => {
  const m = buildProjectMap(data(), opts());
  assert.deepEqual(m.timeRange, {since:'2026-10-01T00:00:00.000Z', until:'2026-10-05T00:00:00.000Z'});
  const xs = ['cp1','cp2','cp3'].map((id) => node(m, `checkpoint:${id}`).x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], xs.join(','));
  assert.ok(node(m, 'checkpoint:cp3').x < node(m, 'checkpoint:cpA').x);
  assert.equal(node(m, 'checkpoint:cp1').at, '2026-10-01T00:00:00.000Z');
  assert.equal(node(m, 'checkpoint:cp3').refs, 2);
});

test('single dated checkpoint uses a now-based range; no dates gives a null range', () => {
  const one = {capsules:[{id:'c',name:'C',items:[]}], checkpoints:[{id:'x',title:'X',createdAt:'2026-10-10T00:00:00.000Z',capsuleId:'c',refs:[]}], tasks:[]};
  const m = buildProjectMap(one, opts());
  assert.deepEqual(m.timeRange, {since:'2026-10-10T00:00:00.000Z', until:now});
  assert.equal(buildProjectMap({capsules:one.capsules, checkpoints:[], tasks:[]}, opts()).timeRange, null);
});

test('invalid or missing dates go to a trailing undated column with at:null', () => {
  const m = buildProjectMap(data(), opts());
  const bad = node(m, 'checkpoint:cpbad'), none = node(m, 'checkpoint:cpnone');
  assert.equal(bad.at, null);
  assert.equal(none.at, null);
  const maxDated = Math.max(...m.lanes.flatMap((l) => l.nodes).filter((n) => n.at).map((n) => n.x));
  assert.ok(bad.x > maxDated && none.x > maxDated);
  const z = lane(m, 'c-zeta').nodes.map((n) => n.id);
  assert.equal(z[0], 'capsule:c-zeta');
  assert.equal(z[z.length - 1], 'checkpoint:cpbad');
});

test('timeline edges chain each lane\'s dated checkpoints in time order only', () => {
  const m = buildProjectMap(data(), opts());
  const tl = m.edges.filter((e) => e.kind === 'timeline').map((e) => `${e.from}>${e.to}`);
  assert.deepEqual(tl, ['checkpoint:cp1>checkpoint:cp2', 'checkpoint:cp2>checkpoint:cp3']);
});

test('reference edges connect checkpoints to other lanes only', () => {
  const m = buildProjectMap(data(), opts());
  const refs = m.edges.filter((e) => e.kind === 'reference').map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(refs, ['checkpoint:cp2>task:t1', 'checkpoint:cp3>capsule:c-alpha1']);
});

test('labels are truncated at labelChars with an ellipsis', () => {
  assert.equal(MAP_LIMITS.labelChars, 60);
  const long = 'x'.repeat(100);
  const m = buildProjectMap({capsules:[{id:'c', name:long, items:[]}], checkpoints:[{id:'k', title:`  ${'y'.repeat(61)}\n`, createdAt:now, capsuleId:'c', refs:[]}], tasks:[]}, opts());
  assert.equal(m.lanes[0].name.length, 60);
  assert.ok(m.lanes[0].name.endsWith('…'));
  assert.equal(node(m, 'checkpoint:k').label, `${'y'.repeat(59)}…`);
  const short = buildProjectMap({capsules:[{id:'c', name:'z'.repeat(60), items:[]}], checkpoints:[], tasks:[]}, opts());
  assert.equal(short.lanes[0].name, 'z'.repeat(60));
});

test('truncation counts capsules over 100 and nodes over 200 per lane; selected capsule is kept', () => {
  const capsules = Array.from({length:105}, (_, i) => ({id:`c${String(i).padStart(3,'0')}`, name:`Cap ${String(i).padStart(3,'0')}`, items:[]}));
  const checkpoints = Array.from({length:250}, (_, i) => ({id:`k${i}`, title:`K${i}`, createdAt:new Date(Date.UTC(2026,0,1) + i * 60000).toISOString(), capsuleId:'c000', refs:[]}));
  const m = buildProjectMap({capsules, checkpoints, tasks:[]}, opts({height:6000, selectedCapsuleId:'c104'}));
  assert.equal(m.lanes.length, MAP_LIMITS.capsules);
  assert.deepEqual(m.truncated, {capsules:5, nodes:51});
  assert.equal(lane(m, 'c000').nodes.length, MAP_LIMITS.nodesPerCapsule);
  assert.ok(lane(m, 'c104'), 'selected capsule stays on the map');
  assert.deepEqual(buildProjectMap(data(), opts()).truncated, {capsules:0, nodes:0});
});

test('keyboard navigation: left/right in lane, up/down nearest in adjacent lane, home/end, null branches', () => {
  const m = buildProjectMap(data(), opts());
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cp1', 'ArrowRight'), 'checkpoint:cp2');
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cp1', 'ArrowLeft'), 'capsule:c-zeta');
  assert.equal(mapKeyboardTarget(m, 'capsule:c-zeta', 'ArrowLeft'), null);
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cp2', 'Home'), 'capsule:c-zeta');
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cp2', 'End'), 'checkpoint:cpbad');
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cpbad', 'End'), null);
  assert.equal(mapKeyboardTarget(m, 'capsule:c-zeta', 'ArrowUp'), 'capsule:c-alpha2');
  assert.equal(mapKeyboardTarget(m, 'checkpoint:cpbad', 'ArrowUp'), 'task:t1');
  assert.equal(mapKeyboardTarget(m, 'capsule:c-alpha1', 'ArrowUp'), null);
  assert.equal(mapKeyboardTarget(m, 'capsule:c-alpha1', 'ArrowDown'), 'capsule:c-alpha2');
  assert.equal(mapKeyboardTarget(m, 'capsule:c-alpha1', 'Tab'), null);
  assert.equal(mapKeyboardTarget(m, 'missing', 'ArrowDown'), 'capsule:c-alpha1');
  assert.equal(mapKeyboardTarget(buildProjectMap({capsules:[], checkpoints:[], tasks:[]}, opts()), null, 'Home'), null);
});

test('descriptive errors for bad size, non-array inputs and invalid now', () => {
  const d = data();
  assert.throws(() => buildProjectMap(d, {width:0, height:10}), /width must be a positive number/);
  assert.throws(() => buildProjectMap(d, {width:10, height:-1}), /height must be a positive number/);
  assert.throws(() => buildProjectMap(d, {width:Number.NaN, height:10}), /width/);
  assert.throws(() => buildProjectMap({capsules:'x', checkpoints:[], tasks:[]}, opts()), /capsules must be an array/);
  assert.throws(() => buildProjectMap({capsules:[], checkpoints:{}, tasks:[]}, opts()), /checkpoints must be an array/);
  assert.throws(() => buildProjectMap({capsules:[], checkpoints:[], tasks:'t'}, opts()), /tasks must be an array/);
  assert.throws(() => buildProjectMap(null, opts()), /input must be an object/);
  assert.throws(() => buildProjectMap(d, opts({now:'yesterday-ish'})), /now must be a valid date/);
});

test('project-map.ts is pure: no fetch, document, window, network or Electron references', () => {
  const src = fs.readFileSync(path.join(root, 'src/ui/project-map.ts'), 'utf8');
  for (const bad of [/\bfetch\b/, /\bdocument\b/, /\bwindow\b/, /XMLHttpRequest/, /WebSocket/, /from ['"]electron['"]/, /\bimport\b/]) assert.ok(!bad.test(src), String(bad));
});

async function loadPanel() {
  const iconNames = new Set();
  for (const dir of ['src/components', 'src/ui']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (!/\.tsx?$/.test(f)) continue;
      const text = fs.readFileSync(path.join(root, dir, f), 'utf8');
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
        for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''); if (name) iconNames.add(name); }
      }
    }
  }
  const out = await build({
    stdin: {resolveDir: root, sourcefile: 'project-map-entry.ts', loader: 'tsx', contents: `export { ProjectMapPanel } from './src/components/Capsules.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`},
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    banner: {js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});`},
    plugins: [{name: 'stubs', setup(b) {
      b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'stub'}));
      b.onResolve({filter: /\/ui\/store$/}, () => ({path: 'store', namespace: 'stub'}));
      b.onLoad({filter: /^icons$/, namespace: 'stub'}, () => ({contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';')}));
      b.onLoad({filter: /^store$/, namespace: 'stub'}, () => ({contents: 'export const useReady = () => globalThis.__store; export const useStore = () => globalThis.__store; export const useOptionalStore = () => globalThis.__store ?? null;'}));
    }}],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

test('ProjectMapPanel renders real lanes as a focusable SVG group, and an empty state without capsules', async () => {
  const {ProjectMapPanel, createElement, renderToStaticMarkup} = await loadPanel();
  const d = data();
  globalThis.__store = {state: {capsules: d.capsules, tasks: d.tasks, notes: []}, productivity: {checkpoints: d.checkpoints}};
  const html = renderToStaticMarkup(createElement(ProjectMapPanel, {selectedId: 'c-zeta', onSelect: () => {}}));
  assert.match(html, /role="group" aria-label="Project map"/);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'exactly one node is in the tab order');
  assert.match(html, /aria-label="checkpoint: First, 2026-10-01T00:00:00.000Z"/);
  assert.match(html, /aria-label="checkpoint: Broken date, undated"/);
  assert.ok(!html.includes('No capsule'), 'orphan checkpoint is not drawn');
  assert.match(html, /project-map-node-selected/);
  globalThis.__store = {state: {capsules: [], tasks: [], notes: []}, productivity: null};
  const empty = renderToStaticMarkup(createElement(ProjectMapPanel, {selectedId: null, onSelect: () => {}}));
  assert.match(empty, /No capsules yet, so there is nothing to map/);
  assert.ok(!empty.includes('<svg'));
  delete globalThis.__store;
});

test('Capsules.tsx wires the map panel with roving focus and the scoped stylesheet', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/Capsules.tsx'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'src/styles/project-map.css')));
  assert.match(src, /strokeDasharray=\{e\.kind === 'reference'/);
  assert.match(src, /role="group" aria-label="Project map"/);
  assert.match(src, /mapKeyboardTarget\(map, n\.id, e\.key\)/);
  assert.match(src, /tabIndex=\{n\.id === activeId \? 0 : -1\}/);
  assert.match(src, /<ProjectMapPanel selectedId=.* onSelect=\{requestOpen\} \/>/);
  const css = fs.readFileSync(path.join(root, 'src/styles/project-map.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of rules.match(/^[^{}]+(?=\{)/gm)) for (const part of sel.split(',')) assert.match(part.trim(), /^\.project-map/, part);
  assert.ok(!/animation|transition/.test(rules));
});
