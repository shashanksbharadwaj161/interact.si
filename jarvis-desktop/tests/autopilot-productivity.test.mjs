// Productivity module tests: sidecar store, memory/recap helpers, capsule preview/packs, and the new views.
// Bundles the real TypeScript in memory with an in-memory file system; no real files, desktop, network or Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const iconNames = new Set();
for (const dir of ['src/components', 'src/ui']) {
  for (const f of await readdir(path.join(root, dir))) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = await readFile(path.join(root, dir, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
}

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'productivity-test-entry.ts',
    loader: 'tsx',
    contents: `
      export * as store from './electron/services/store.ts';
      export * as search from './electron/services/search.ts';
      export * as capsules from './electron/services/capsules.ts';
      export * as reminders from './electron/services/reminders.ts';
      export * as validation from './electron/services/validation.ts';
      export { ProjectMemory, RestoreTools } from './src/components/Capsules.tsx';
      export { MemoryControls, MemorySearch } from './src/components/MemorySearch.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'stub' }));
        // Views read their data through useReady(); tests supply it through globalThis.__store.
        b.onResolve({ filter: /\/ui\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onLoad({ filter: /^icons$/, namespace: 'stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ contents: 'export const useReady = () => globalThis.__store; export const useStore = () => globalThis.__store; export const useOptionalStore = () => globalThis.__store ?? null;' }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { store, search, capsules, reminders, validation, ProjectMemory, RestoreTools, MemoryControls, MemorySearch, createElement, renderToStaticMarkup } = mod;

// ---- helpers ---------------------------------------------------------------------------------------------------
const T0 = Date.parse('2026-10-14T12:00:00.000Z');

function memFs(files = new Map()) {
  const f = { files, failRename: false, failWrite: false, renames: 0 };
  f.api = {
    mkdir: async () => {},
    readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
    writeFile: async (p, d) => { if (f.failWrite) throw new Error('disk full'); files.set(p, d); },
    rename: async (a, b) => {
      if (f.failRename) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      f.renames++;
      files.set(b, files.get(a));
      files.delete(a);
    },
    readdir: async (dir) => [...files.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)),
    unlink: async (p) => { files.delete(p); },
  };
  return f;
}

function mk(opts = {}) {
  const fs = opts.fs ?? memFs();
  let n = 0;
  let nowMs = opts.now ?? T0;
  const ps = new store.ProductivityStore({ dir: 'D:\\data', fs: fs.api, now: () => new Date(nowMs), newId: () => `id${++n}` });
  return { ps, fs, setNow: (v) => { nowMs = v; } };
}
const file = (fs) => JSON.parse(fs.files.get(path.join('D:\\data', 'productivity.json')));
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));

// ---- ProductivityStore -------------------------------------------------------------------------------------------
test('capsule goals and references persist and reload; ids are generated and stable', async () => {
  const { ps, fs } = mk();
  await ps.load();
  await ps.apply({ op: 'capsule.setMeta', capsuleId: 'c1', goals: [{ text: 'Ship v1' }, { text: 'Write docs', done: true }], references: [{ kind: 'url', target: 'https://example.com/spec', label: 'Spec' }, { kind: 'folder', target: 'C:\\Work\\proj', label: 'Repo' }, { kind: 'note', target: 'n1' }] });
  const s = ps.snapshot();
  assert.deepEqual(s.capsuleMeta.c1.goals.map((g) => [g.text, g.done]), [['Ship v1', false], ['Write docs', true]]);
  assert.equal(s.capsuleMeta.c1.references.length, 3);
  // Updating only goals keeps references.
  await ps.apply({ op: 'capsule.setMeta', capsuleId: 'c1', goals: [{ id: s.capsuleMeta.c1.goals[0].id, text: 'Ship v1', done: true }] });
  assert.equal(ps.snapshot().capsuleMeta.c1.references.length, 3);
  assert.equal(ps.snapshot().capsuleMeta.c1.goals.length, 1);
  const again = mk({ fs });
  await again.ps.load();
  assert.deepEqual(again.ps.snapshot().capsuleMeta, ps.snapshot().capsuleMeta);
});

test('invalid references and operations are rejected without changing memory or disk', async () => {
  const { ps, fs } = mk();
  await ps.load();
  const before = fs.files.get(ps.statePath);
  const bad = [
    { op: 'capsule.setMeta', capsuleId: 'c1', references: [{ kind: 'file', target: '\\\\evil\\share\\x.exe' }] },
    { op: 'capsule.setMeta', capsuleId: 'c1', references: [{ kind: 'folder', target: 'C:\\a\\..\\b' }] },
    { op: 'capsule.setMeta', capsuleId: 'c1', references: [{ kind: 'url', target: 'javascript:alert(1)' }] },
    { op: 'capsule.setMeta', capsuleId: 'c1', references: [{ kind: 'url', target: 'file:///C:/x' }] },
    { op: 'capsule.setMeta', capsuleId: '../x', goals: [] },
    { op: 'capsule.setMeta', capsuleId: 'c1', goals: [{ text: '   ' }] },
    { op: 'capsule.setMeta', capsuleId: 'c1', goals: [{ text: 'a\u0007b' }] },
    { op: 'checkpoint.add', title: '' },
    { op: 'nope' },
    { op: 5 },
    null,
    'x',
  ];
  for (const b of bad) await assert.rejects(ps.apply(b), undefined, JSON.stringify(b));
  assert.deepEqual(ps.snapshot(), store.emptyProductivity());
  assert.equal(fs.files.get(ps.statePath), before);
});

test('a failed write rolls memory back, removes the temp file and keeps the previous file', async () => {
  const { ps, fs } = mk();
  await ps.load();
  await ps.apply({ op: 'checkpoint.add', title: 'first' });
  const good = fs.files.get(ps.statePath);
  fs.failRename = true;
  await rejects(ps.apply({ op: 'checkpoint.add', title: 'second' }), /Could not save data to disk/);
  assert.deepEqual(ps.snapshot().checkpoints.map((c) => c.title), ['first']);
  assert.equal(fs.files.get(ps.statePath), good);
  assert.ok(![...fs.files.keys()].some((k) => k.endsWith('.tmp')), 'temp file cleaned up');
  fs.failRename = false;
  await ps.apply({ op: 'checkpoint.add', title: 'third' });
  assert.deepEqual(ps.snapshot().checkpoints.map((c) => c.title), ['first', 'third']);
});

test('corrupt data is quarantined and restored from the previous copy, or reset when none exists', async () => {
  const a = mk();
  await a.ps.load();
  await a.ps.apply({ op: 'checkpoint.add', title: 'keep me' });
  await mk({ fs: a.fs }).ps.load(); // a clean load writes the .prev copy
  a.fs.files.set(a.ps.statePath, '{"schemaVersion":1,"state":{"checkpoints":[{"id":"!!"}]}}');
  const b = mk({ fs: a.fs });
  const r = await b.ps.load();
  assert.equal(r.recovered, true);
  assert.deepEqual(b.ps.snapshot().checkpoints.map((c) => c.title), ['keep me']);
  assert.ok([...a.fs.files.keys()].some((k) => /productivity\.corrupt-\d{8}-\d{6}\.json$/.test(k)), 'bad file kept for inspection');

  const c = mk();
  c.fs.files.set(c.ps.statePath, 'not json');
  const rc = await c.ps.load();
  assert.equal(rc.recovered, true);
  assert.match(rc.warning, /reset/);
  assert.deepEqual(c.ps.snapshot(), store.emptyProductivity());
});

test('data from a newer version is read-only and never overwritten', async () => {
  const { ps, fs } = mk();
  const newer = JSON.stringify({ schemaVersion: 99, state: { future: true } });
  fs.files.set(ps.statePath, newer);
  const r = await ps.load();
  assert.equal(r.readOnly, true);
  await rejects(ps.apply({ op: 'checkpoint.add', title: 'x' }), /read-only/);
  assert.equal(fs.files.get(ps.statePath), newer);
});

test('the application timeline is off until enabled, and titles need a second opt-in', async () => {
  const { ps } = mk();
  await ps.load();
  const rec = { op: 'timeline.record', at: '2026-10-14T10:00:00Z', endedAt: '2026-10-14T10:30:00Z', app: 'code.exe', title: 'secret plans.docx' };
  await rejects(ps.apply(rec), /timeline is off/);
  assert.equal(ps.snapshot().timeline.length, 0);
  await ps.apply({ op: 'policy.set', timelineEnabled: true });
  await ps.apply(rec);
  assert.equal(ps.snapshot().timeline[0].title, undefined, 'title dropped by default');
  await ps.apply({ op: 'policy.set', timelineTitles: true });
  await ps.apply({ ...rec, at: '2026-10-14T11:00:00Z', endedAt: '2026-10-14T11:10:00Z' });
  assert.equal(ps.snapshot().timeline[1].title, 'secret plans.docx');
  await ps.apply({ op: 'policy.set', timelineEnabled: false });
  assert.equal(ps.snapshot().policy.timelineTitles, false, 'turning the timeline off also turns titles off');
});

test('focus sessions are validated and a re-reported session is not duplicated', async () => {
  const { ps } = mk();
  await ps.load();
  const f = { op: 'focus.record', startedAt: '2026-10-14T09:00:00Z', endedAt: '2026-10-14T09:25:00Z', plannedSec: 1500, actualSec: 1500, outcome: 'completed', taskId: 't1', taskTitle: 'Write' };
  await ps.apply(f);
  await ps.apply({ ...f, startedAt: '2026-10-14T09:00:07Z' });
  assert.equal(ps.snapshot().focus.length, 1);
  await ps.apply({ ...f, startedAt: '2026-10-14T10:00:00Z', endedAt: '2026-10-14T10:25:00Z' });
  assert.equal(ps.snapshot().focus.length, 2);
  await assert.rejects(ps.apply({ ...f, startedAt: '2026-10-14T11:00:00Z', endedAt: '2026-10-14T10:00:00Z' }));
  await assert.rejects(ps.apply({ ...f, startedAt: '2026-10-14T12:00:00Z', endedAt: '2026-10-14T12:25:00Z', actualSec: -1 }));
  await assert.rejects(ps.apply({ ...f, startedAt: '2026-10-14T13:00:00Z', endedAt: '2026-10-14T13:25:00Z', outcome: 'maybe' }));
});

test('retention removes old records on load and per policy; 0 keeps forever', async () => {
  const a = mk();
  await a.ps.load();
  const day = 86_400_000;
  const old = new Date(T0 - 400 * day).toISOString(), recent = new Date(T0 - 2 * day).toISOString();
  for (const [s, e] of [[old, old], [recent, recent]]) await a.ps.apply({ op: 'focus.record', startedAt: s, endedAt: e, plannedSec: 60, actualSec: 60, outcome: 'completed' });
  await a.ps.apply({ op: 'checkpoint.add', title: 'cp' });
  a.setNow(T0 + 800 * day);
  const b = mk({ fs: a.fs, now: T0 + 800 * day });
  await b.ps.load();
  assert.equal(b.ps.snapshot().focus.length, 0, 'default 365 days drops both focus sessions');
  assert.equal(b.ps.snapshot().checkpoints.length, 1, 'checkpoints default to keep');
  await b.ps.apply({ op: 'policy.set', retainDays: { checkpoints: 30 } });
  await b.ps.applyRetention();
  assert.equal(b.ps.snapshot().checkpoints.length, 0);
  await assert.rejects(b.ps.apply({ op: 'policy.set', retainDays: { focus: -1 } }));
  await assert.rejects(b.ps.apply({ op: 'policy.set', retainDays: { focus: 99999 } }));
});

test('forget removes only the chosen scope and honours a before-date', async () => {
  const { ps, setNow } = mk();
  await ps.load();
  await ps.apply({ op: 'checkpoint.add', title: 'old' });
  setNow(T0 + 1000);
  await ps.apply({ op: 'checkpoint.add', title: 'new' });
  await ps.apply({ op: 'shelf.add', kind: 'url', target: 'https://example.com/a', label: 'A' });
  await ps.apply({ op: 'capsule.setMeta', capsuleId: 'c1', goals: [{ text: 'g' }] });
  await ps.apply({ op: 'forget', scope: 'checkpoints', before: new Date(T0 + 500).toISOString() });
  assert.deepEqual(ps.snapshot().checkpoints.map((c) => c.title), ['new']);
  assert.equal(ps.snapshot().shelf.length, 1, 'other scopes untouched');
  await ps.apply({ op: 'forget', scope: 'all', before: new Date(T0 + 10_000).toISOString() });
  assert.equal(ps.snapshot().capsuleMeta.c1.goals.length, 1, 'a dated forget keeps capsule goals');
  await ps.apply({ op: 'forget', scope: 'all' });
  assert.deepEqual(ps.snapshot(), { ...store.emptyProductivity(), policy: ps.snapshot().policy });
  await assert.rejects(ps.apply({ op: 'forget', scope: 'bogus' }));
});

test('reconcile drops data for capsules and tasks that no longer exist', async () => {
  const { ps } = mk();
  await ps.load();
  await ps.apply({ op: 'capsule.setMeta', capsuleId: 'gone', goals: [{ text: 'x' }] });
  await ps.apply({ op: 'capsule.setMeta', capsuleId: 'live', references: [{ kind: 'task', target: 'tGone' }, { kind: 'task', target: 'tLive' }] });
  await ps.apply({ op: 'checkpoint.add', title: 'cp', capsuleId: 'gone' });
  await ps.apply({ op: 'reminder.dismiss', taskId: 'tGone', due: '2026-10-20' });
  await ps.reconcile({ capsuleIds: ['live'], taskIds: ['tLive'] });
  const s = ps.snapshot();
  assert.deepEqual(Object.keys(s.capsuleMeta), ['live']);
  assert.deepEqual(s.capsuleMeta.live.references.map((r) => r.target), ['tLive']);
  assert.equal(s.checkpoints[0].capsuleId, undefined, 'checkpoint kept, link removed');
  assert.equal(s.reminders.length, 0);
});

test('reminder snooze must be in the future; dismiss and clear work per task and due value', async () => {
  const { ps } = mk();
  await ps.load();
  await rejects(ps.apply({ op: 'reminder.snooze', taskId: 't1', due: '2026-10-14', until: new Date(T0 - 1000).toISOString() }), /future/);
  await ps.apply({ op: 'reminder.snooze', taskId: 't1', due: '2026-10-14', until: new Date(T0 + 600_000).toISOString() });
  await ps.apply({ op: 'reminder.dismiss', taskId: 't2', due: '2026-10-14' });
  assert.equal(ps.snapshot().reminders.length, 2);
  await ps.apply({ op: 'reminder.dismiss', taskId: 't1', due: '2026-10-14' });
  assert.deepEqual(ps.snapshot().reminders.filter((r) => r.taskId === 't1').map((r) => r.state), ['dismissed']);
  await ps.apply({ op: 'reminder.clear', taskId: 't1', due: '2026-10-14' });
  assert.equal(ps.snapshot().reminders.length, 1);
});

test('associations need an existing session, can be corrected, and go away with the session', async () => {
  const { ps } = mk();
  await ps.load();
  await ps.apply({ op: 'policy.set', timelineEnabled: true });
  await rejects(ps.apply({ op: 'association.set', sessionId: 'nope', taskId: 't1' }), /Session not found/);
  await ps.apply({ op: 'timeline.record', at: '2026-10-14T10:00:00Z', app: 'code.exe' });
  const sid = ps.snapshot().timeline[0].id;
  await rejects(ps.apply({ op: 'association.set', sessionId: sid }), /task or a capsule/);
  await ps.apply({ op: 'association.set', sessionId: sid, taskId: 't1' });
  await ps.apply({ op: 'association.set', sessionId: sid, capsuleId: 'c1' });
  assert.deepEqual(ps.snapshot().associations.map((a) => [a.taskId, a.capsuleId]), [[undefined, 'c1']]);
  await ps.apply({ op: 'timeline.delete', id: sid });
  assert.equal(ps.snapshot().associations.length, 0);
});

test('shelf and recents hold references only, dedupe, and recents stay bounded', async () => {
  const { ps } = mk();
  await ps.load();
  await ps.apply({ op: 'shelf.add', kind: 'file', target: 'C:\\Work\\a.txt', label: 'A' });
  await rejects(ps.apply({ op: 'shelf.add', kind: 'file', target: 'c:\\work\\A.TXT' }), /Already/);
  await assert.rejects(ps.apply({ op: 'shelf.add', kind: 'file', target: '\\\\host\\s\\x' }));
  const id = ps.snapshot().shelf[0].id;
  await ps.apply({ op: 'shelf.pin', id, pinned: true });
  assert.equal(ps.snapshot().shelf[0].pinned, true);
  for (let i = 0; i < 60; i++) await ps.apply({ op: 'recent.record', kind: 'url', target: `https://example.com/${i}` });
  await ps.apply({ op: 'recent.record', kind: 'url', target: 'https://example.com/59' });
  const r = ps.snapshot().recents;
  assert.equal(r.length, 50);
  assert.equal(r[0].count, 2, 'reopening moves it to the front and counts');
});

test('concurrent operations are serialized and none is lost', async () => {
  const { ps, fs } = mk();
  await ps.load();
  await Promise.all(Array.from({ length: 25 }, (_, i) => ps.apply({ op: 'checkpoint.add', title: `c${i}` })));
  assert.equal(ps.snapshot().checkpoints.length, 25);
  assert.equal(file(fs).state.checkpoints.length, 25);
});

// ---- Store.forgetHistory (main data file) ------------------------------------------------------------------------
test('forgetHistory removes only chat/activity, records a count-only entry, and is atomic on write failure', async () => {
  const fs = memFs();
  let n = 0;
  const st = new store.Store({ dir: 'D:\\main', fs: fs.api, now: () => new Date(T0), newId: () => `m${++n}` });
  await st.load();
  const iso = (d) => new Date(T0 - d * 86_400_000).toISOString();
  await st.mutate((d) => {
    d.notes.push({ id: 'n1', title: 'Keep', body: 'b', tags: [], updatedAt: iso(0) });
    d.chat.push({ id: 'ch1', role: 'user', text: 'old secret', createdAt: iso(40), source: 'local' }, { id: 'ch2', role: 'user', text: 'new', createdAt: iso(1), source: 'local' });
    d.activity.push({ id: 'a1', at: iso(40), kind: 'x', summary: 'old' }, { id: 'a2', at: iso(1), kind: 'x', summary: 'new' });
  });
  fs.failRename = true;
  await assert.rejects(st.forgetHistory({ chat: true }));
  fs.failRename = false;
  assert.equal(st.snapshot().chat.length, 2, 'failed write changed nothing');
  const r = await st.forgetHistory({ chat: true, activity: true, before: iso(10) });
  assert.deepEqual(r.removed, { chat: 1, activity: 1 });
  const s = st.snapshot();
  assert.deepEqual(s.chat.map((m) => m.id), ['ch2']);
  assert.equal(s.notes.length, 1);
  const memory = s.activity.find((a) => a.kind === 'memory');
  assert.match(memory.summary, /Forgot 1 chat message\(s\) and 1 activity entry/);
  assert.ok(!JSON.stringify(s.activity).includes('old secret'));
  await assert.rejects(st.forgetHistory({ chat: true, before: 'not a date' }));
});

// ---- search ----------------------------------------------------------------------------------------------------
const iso = (s) => new Date(s).toISOString();
function appState() {
  const T = iso('2026-10-10T08:00:00Z');
  return {
    settings: { retainDays: 30 },
    notes: [
      { id: 'n1', title: 'Launch checklist', body: 'Verify installer signing', tags: ['snippet', 'launch'], updatedAt: iso('2026-10-14T09:30:00Z') },
      { id: 'n2', title: 'Groceries', body: 'milk and eggs', tags: [], updatedAt: iso('2026-09-01T09:30:00Z') },
    ],
    tasks: [
      { id: 't1', title: 'Fix installer bug', done: false, due: '2026-10-14', createdAt: iso('2026-10-14T07:00:00Z') },
      { id: 't2', title: 'Pay invoice', done: true, createdAt: T },
    ],
    capsules: [
      { id: 'c1', name: 'Launch project', description: '', scene: 'graphite', createdAt: T, updatedAt: T, items: [] },
      { id: 'c2', name: 'Garden', description: '', scene: 'graphite', createdAt: T, updatedAt: T, items: [] },
    ],
    chat: [{ id: 'm1', role: 'user', text: 'installer question', createdAt: T, source: 'local' }],
    activity: [
      { id: 'a1', at: iso('2026-10-14T10:00:00Z'), kind: 'capsule', summary: 'Restored capsule "Launch project": 2 opened, 0 failed' },
      { id: 'a2', at: iso('2026-10-14T11:00:00Z'), kind: 'import', summary: 'Imported data', details: 'installer notes' },
    ],
  };
}
function prodState(over = {}) {
  const p = store.emptyProductivity();
  p.capsuleMeta.c1 = { updatedAt: iso('2026-10-14T00:00:00Z'), goals: [{ id: 'g1', text: 'Sign the installer', done: false }, { id: 'g2', text: 'Publish notes', done: true }], references: [{ id: 'r1', kind: 'note', target: 'n1', label: '' }, { id: 'r2', kind: 'task', target: 't1', label: '' }, { id: 'r3', kind: 'url', target: 'https://example.com/spec', label: 'Spec doc' }] };
  p.checkpoints.push({ id: 'k1', capsuleId: 'c1', title: 'Installer builds', note: 'Signing step still manual', createdAt: iso('2026-10-13T17:00:00Z'), refs: [] }, { id: 'k2', capsuleId: 'c2', title: 'Planted tomatoes', note: '', createdAt: iso('2026-10-12T17:00:00Z'), refs: [] });
  p.shelf.push({ id: 's1', kind: 'file', target: 'C:\\Docs\\installer-guide.pdf', label: 'Installer guide', addedAt: iso('2026-10-11T00:00:00Z'), pinned: false });
  p.focus.push({ id: 'f1', startedAt: iso('2026-10-14T08:00:00Z'), endedAt: iso('2026-10-14T08:25:00Z'), plannedSec: 1500, actualSec: 1500, outcome: 'completed', taskId: 't1', taskTitle: 'Fix installer bug', capsuleId: 'c1' });
  return Object.assign(p, over);
}
const cats = (r) => r.map((x) => `${x.category}:${x.id}`);

test('search finds checkpoints, shelf items, capsule goals and references; history and chat stay opt-in', () => {
  const s = appState(), p = prodState();
  const base = search.searchState(s, 'installer');
  assert.deepEqual(cats(base).sort(), ['task:t1', 'note:n1'].sort(), 'without the sidecar only notes and tasks match');
  const all = cats(search.searchState(s, 'installer', { productivity: p }));
  for (const k of ['checkpoint:k1', 'reference:s1', 'capsule:c1']) assert.ok(all.includes(k), k);
  assert.ok(!all.some((k) => k.startsWith('history:') || k.startsWith('chat:')));
  const withHistory = cats(search.searchState(s, 'installer', { productivity: p, includeHistory: true, includeChat: true }));
  assert.ok(withHistory.includes('history:a2') && withHistory.includes('chat:m1'));
  assert.ok(!search.searchState(s, 'installer', { includeHistory: 'yes' }).some((r) => r.category === 'history'), 'only literal true opts in');
  assert.ok(cats(search.searchState(s, 'spec', { productivity: p })).includes('capsule:c1'), 'reference labels reach the capsule');
});

test('project scope, tag, category and date filters narrow results', () => {
  const s = appState(), p = prodState();
  assert.deepEqual(cats(search.searchState(s, 'installer', { productivity: p, capsuleId: 'c1', includeHistory: true })).sort(), ['capsule:c1', 'checkpoint:k1', 'note:n1', 'task:t1'].sort());
  assert.deepEqual(cats(search.searchState(s, 'planted', { productivity: p, capsuleId: 'c1' })), [], 'another project checkpoint is out of scope');
  assert.deepEqual(cats(search.searchState(s, 'planted', { productivity: p })), ['checkpoint:k2']);
  assert.deepEqual(cats(search.searchState(s, 'launch', { tag: '#Snippet' })), ['note:n1']);
  assert.deepEqual(cats(search.searchState(s, 'installer', { productivity: p, categories: ['checkpoint'] })), ['checkpoint:k1']);
  const since = search.searchState(s, 'groceries milk', { since: iso('2026-10-01T00:00:00Z') });
  assert.equal(since.length, 0);
  assert.equal(search.searchState(s, 'groceries', { since: iso('2026-08-01T00:00:00Z') }).length, 1);
});

test('external records are searched as their own category and malformed ones are ignored', () => {
  const ext = [{ source: 'calendar', id: 'e1', title: 'Installer review', text: 'Room 4', at: iso('2026-10-14T14:00:00Z') }, { source: 5, id: 'bad', title: 'installer' }, { source: 'clipboard', id: '../x', title: 'installer' }];
  const r = search.searchState(appState(), 'installer review', { external: ext });
  assert.deepEqual(cats(r), ['external:e1']);
  assert.equal(search.CATEGORY_LABELS.external, 'Other sources');
});

// ---- recaps and worklog ----------------------------------------------------------------------------------------
test('daily recap lists only recorded evidence for that local day, each line with its source', () => {
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const noon = new Date(2026, 9, 14, 12, 0, 0);
  const s = appState();
  s.notes[0].updatedAt = noon.toISOString();
  s.tasks[0].createdAt = new Date(2026, 9, 14, 9, 0, 0).toISOString();
  s.activity[0].at = new Date(2026, 9, 14, 10, 0, 0).toISOString();
  s.activity[1].at = new Date(2026, 9, 14, 11, 0, 0).toISOString(); // an import is not a work event
  const p = prodState();
  p.focus[0].endedAt = new Date(2026, 9, 14, 8, 25, 0).toISOString();
  p.checkpoints[0].createdAt = new Date(2026, 9, 13, 17, 0, 0).toISOString(); // yesterday
  p.policy.timelineEnabled = true;
  p.timeline.push({ id: 'tl1', at: new Date(2026, 9, 14, 9, 0, 0).toISOString(), endedAt: new Date(2026, 9, 14, 10, 0, 0).toISOString(), app: 'code.exe' });
  const r = search.buildDailyRecap(s, p, day(noon));
  const kinds = r.lines.map((l) => l.source.kind).sort();
  assert.deepEqual(kinds, ['activity', 'focus', 'note', 'session', 'task']);
  assert.ok(r.lines.every((l) => l.source.id), 'every line cites a record');
  assert.match(r.lines.find((l) => l.source.kind === 'focus').text, /25 min on "Fix installer bug"/);
  assert.match(r.lines.find((l) => l.source.kind === 'session').text, /code\.exe for 60 min/);
  assert.ok(!r.lines.some((l) => /Imported/.test(l.text)));
  assert.equal(r.empty, false);
  const none = search.buildDailyRecap(s, p, '2026-01-01');
  assert.equal(none.empty, true);
  assert.equal(search.buildDailyRecap(s, p, '2026-02-31').empty, true, 'impossible date yields nothing');
  assert.match(search.draftWorklog(none), /DRAFT[\s\S]*No recorded activity to report/);
  const draft = search.draftWorklog(r, { withSources: true });
  assert.match(draft, /^DRAFT — assembled from local records only/);
  assert.match(draft, /\[focus:f1\]/);
});

test('resume recap covers open goals, latest checkpoints, focus time, linked notes/tasks and last restore', () => {
  const r = search.buildResumeRecap(appState(), prodState(), 'c1');
  const text = r.lines.map((l) => l.text).join('\n');
  assert.match(text, /Goal open: Sign the installer/);
  assert.ok(!/Publish notes/.test(text), 'done goals are not listed as open');
  assert.match(text, /Checkpoint 2026-10-13: Installer builds — Signing step still manual/);
  assert.match(text, /Focus on this capsule: 1 session\(s\), 25 min total/);
  assert.match(text, /Note: Launch checklist/);
  assert.match(text, /Task open: Fix installer bug/);
  assert.match(text, /Last restored 2026-10-14/);
  assert.equal(search.buildResumeRecap(appState(), prodState(), 'c2').lines.some((l) => /Goal/.test(l.text)), false);
  const missing = search.buildResumeRecap(appState(), prodState(), 'nope');
  assert.equal(missing.empty, true);
});

test('association suggestions are word-based, skip finished tasks and never claim certainty', () => {
  const s = appState();
  const r = search.suggestAssociations('Installer - Visual Studio Code', s);
  assert.deepEqual(r.map((x) => `${x.kind}:${x.id}`), ['task:t1']);
  assert.match(r[0].reason, /shares "installer"/);
  assert.deepEqual(search.suggestAssociations('invoice', s), [], 'done task is not suggested');
  assert.deepEqual(search.suggestAssociations('an of', s), [], 'short words are ignored');
});

// ---- reminders -------------------------------------------------------------------------------------------------
test('reminder status reflects snooze and dismiss; the scheduler list re-announces after a snooze', async () => {
  const due = iso('2026-10-14T11:00:00Z');
  const task = { id: 't1', title: 'Call', done: false, due, createdAt: due };
  const now = Date.parse('2026-10-14T11:30:00Z');
  assert.equal(search.reminderStatus(task, [], now).state, 'due');
  assert.equal(search.reminderStatus(task, [], Date.parse('2026-10-14T10:00:00Z')).state, 'upcoming');
  assert.equal(search.reminderStatus({ ...task, done: true }, [], now).state, 'none');
  assert.equal(search.reminderStatus({ id: 'x', done: false }, [], now).state, 'none');
  const snooze = { key: 'k', taskId: 't1', due, state: 'snoozed', until: iso('2026-10-14T12:00:00Z'), at: due };
  assert.deepEqual(search.reminderStatus(task, [snooze], now), { state: 'snoozed', until: snooze.until });
  assert.equal(search.reminderStatus(task, [snooze], Date.parse('2026-10-14T12:01:00Z')).state, 'due', 'an elapsed snooze is due again');
  assert.equal(search.reminderStatus(task, [{ ...snooze, state: 'dismissed' }], now).state, 'dismissed');
  assert.equal(search.reminderStatus(task, [{ ...snooze, due: 'other' }], now).state, 'due', 'a state for another due value does not apply');

  // Drive the real scheduler with the effective task list.
  const clock = { t: now };
  const notified = [];
  const tasks = [task];
  const states = [snooze];
  const r = new reminders.Reminders({ tasks: () => search.effectiveReminderTasks(tasks, states), now: () => clock.t, notify: (title) => notified.push(title), setTimer: () => 0, clearTimer: () => {} });
  r.rearm();
  assert.equal(r.nextAt(), Date.parse(snooze.until), 'next announcement is the snooze end');
  clock.t = Date.parse(snooze.until) + 1;
  assert.equal(await r.fire(), 1);
  assert.deepEqual(notified, ['Call']);
  assert.deepEqual(search.effectiveReminderTasks(tasks, [{ ...snooze, state: 'dismissed' }]), [], 'dismissed tasks are not scheduled');
});

test('snooze presets produce future times; tomorrow is 09:00 local', () => {
  const now = new Date(2026, 9, 14, 22, 15, 0).getTime();
  assert.equal(Date.parse(search.snoozeUntil('10m', now)) - now, 600_000);
  assert.equal(Date.parse(search.snoozeUntil('1h', now)) - now, 3_600_000);
  const t = new Date(search.snoozeUntil('tomorrow', now));
  assert.deepEqual([t.getDate(), t.getHours(), t.getMinutes()], [15, 9, 0]);
});

// ---- focus -----------------------------------------------------------------------------------------------------
test('focus recorder only records observed transitions of a minute or more', () => {
  const cur = (phase, remainingSec, extra = {}) => ({ phase, durationSec: 1500, remainingSec, taskId: 't1', taskTitle: 'Write', ...extra });
  let obs = null, rec;
  ({ next: obs, record: rec } = search.observeFocus(null, cur('idle', 1500), T0));
  assert.equal(rec, null);
  ({ next: obs, record: rec } = search.observeFocus(obs, cur('running', 1500), T0));
  assert.equal(obs.startedAt, T0);
  ({ next: obs, record: rec } = search.observeFocus(obs, cur('running', 900), T0 + 600_000));
  assert.equal(rec, null);
  ({ next: obs, record: rec } = search.observeFocus(obs, cur('done', 0), T0 + 1_500_000));
  assert.equal(rec.outcome, 'completed');
  assert.equal(rec.actualSec, 1500);
  assert.equal(rec.startedAt, new Date(T0).toISOString());
  assert.equal(rec.taskId, 't1');
  // Stopped after 10 minutes is recorded as stopped with the elapsed focus time.
  let o2 = search.observeFocus(null, cur('running', 1500), T0).next;
  o2 = search.observeFocus(o2, cur('running', 900), T0 + 600_000).next;
  const stopped = search.observeFocus(o2, cur('idle', 1500), T0 + 610_000);
  assert.deepEqual([stopped.record.outcome, stopped.record.actualSec], ['stopped', 600]);
  // Stopped after 20 seconds is an accidental start: nothing recorded.
  let o3 = search.observeFocus(null, cur('running', 1500), T0).next;
  o3 = search.observeFocus(o3, cur('running', 1480), T0 + 20_000).next;
  assert.equal(search.observeFocus(o3, cur('idle', 1500), T0 + 21_000).record, null);
  // Already running when observation began: start reconstructed from elapsed time, and a reload into 'done' records nothing.
  const mid = search.observeFocus(null, cur('running', 1000), T0);
  assert.equal(mid.next.startedAt, T0 - 500_000);
  assert.equal(search.observeFocus(search.observeFocus(null, cur('idle', 0), T0).next, cur('done', 0), T0).record, null);
});

test('focus summary totals per task and completion counts', () => {
  const p = prodState();
  p.focus.push({ id: 'f2', startedAt: iso('2026-10-13T08:00:00Z'), endedAt: iso('2026-10-13T08:10:00Z'), plannedSec: 1500, actualSec: 600, outcome: 'stopped' });
  const all = search.focusSummary(p.focus);
  assert.deepEqual([all.sessions, all.completed, all.totalSec], [2, 1, 2100]);
  assert.deepEqual(all.byTask.map((t) => [t.title, t.sec]), [['Fix installer bug', 1500], ['No task', 600]]);
  assert.equal(search.focusSummary(p.focus, Date.parse('2026-10-14T00:00:00Z')).sessions, 1);
});

test('retention preview counts what the settings would remove without changing anything', () => {
  const s = appState();
  s.settings.retainDays = 30;
  s.chat[0].createdAt = iso('2026-01-01T00:00:00Z');
  s.activity[0].at = iso('2026-01-01T00:00:00Z');
  const p = prodState();
  p.policy.retainDays.focus = 1;
  const before = JSON.stringify([s, p]);
  const r = search.previewRetention(s, p, Date.parse('2026-10-20T00:00:00Z'));
  assert.deepEqual(r, { chat: 1, activity: 1, focus: 1, checkpoints: 0, reminders: 0, timeline: 0 });
  assert.equal(JSON.stringify([s, p]), before);
  assert.equal(search.previewRetention(s, undefined, Date.parse('2026-10-20T00:00:00Z')).focus, 0);
});

// ---- search navigation and contract compatibility --------------------------------------------------------------------
test('navResult maps a result to a screen that holds it and returns null when none does', () => {
  const p = prodState();
  const r = (category, id) => ({ category, id, title: 't', snippet: '', relevance: 1 });
  assert.deepEqual(search.navResult(r('note', 'n1'), p), { ...r('note', 'n1') });
  assert.equal(search.navResult(r('checkpoint', 'k1'), p).category, 'capsule');
  assert.equal(search.navResult(r('checkpoint', 'k1'), p).id, 'c1', 'a checkpoint opens its capsule, not its own id');
  p.checkpoints[0].capsuleId = undefined;
  assert.equal(search.navResult(r('checkpoint', 'k1'), p), null, 'a checkpoint without a capsule has no screen');
  assert.equal(search.navResult(r('checkpoint', 'zzz'), p), null);
  for (const c of ['reference', 'history', 'external']) assert.equal(search.navResult(r(c, 'x'), p), null, c);
});

test('the original two-option call only ever yields contract categories', () => {
  const s = appState();
  const r = search.searchState(s, 'installer', { includeChat: true, limit: 10 });
  assert.ok(r.length >= 3);
  assert.ok(r.every((x) => ['note', 'task', 'capsule', 'chat'].includes(x.category)));
});

// ---- ProductivityStore: damaged saved data ---------------------------------------------------------------------------
test('a saved goal without an id is treated as damage and recovered, not silently given an empty id', async () => {
  const a = mk();
  await a.ps.load();
  await a.ps.apply({ op: 'checkpoint.add', title: 'safe' });
  await mk({ fs: a.fs }).ps.load(); // writes the .prev copy
  const bad = { schemaVersion: 1, savedAt: '2026-10-14T00:00:00Z', state: { capsuleMeta: { c1: { updatedAt: '2026-10-14T00:00:00Z', goals: [{ text: 'no id' }], references: [] } } } };
  a.fs.files.set(a.ps.statePath, JSON.stringify(bad));
  const b = mk({ fs: a.fs });
  const r = await b.ps.load();
  assert.equal(r.recovered, true);
  assert.deepEqual(b.ps.snapshot().capsuleMeta, {});
  assert.deepEqual(b.ps.snapshot().checkpoints.map((c) => c.title), ['safe']);
});

test('an interrupted write (leftover .tmp) never replaces good data', async () => {
  const a = mk();
  await a.ps.load();
  await a.ps.apply({ op: 'checkpoint.add', title: 'good' });
  a.fs.files.set(a.ps.statePath + '.tmp', '{"half written');
  const b = mk({ fs: a.fs });
  const r = await b.ps.load();
  assert.equal(r.recovered, false);
  assert.deepEqual(b.ps.snapshot().checkpoints.map((c) => c.title), ['good']);
});

test('rejected operations from a hostile caller leave no temp file and no partial state', async () => {
  const { ps, fs } = mk();
  await ps.load();
  const before = fs.files.get(ps.statePath);
  const hostile = [
    { op: 'shelf.add', kind: 'file', target: 'C:\\x\\..\\..\\Windows\\System32\\cmd.exe' },
    { op: 'shelf.add', kind: 'url', target: 'http://user:pw@host/' },
    { op: 'recent.record', kind: 'app', target: '..\\evil.exe' },
    { op: 'checkpoint.add', title: 'x', refs: [{ kind: 'note', id: '../../etc' }] },
    { op: 'checkpoint.add', title: 'x'.repeat(500) },
    { op: 'policy.set', retainDays: { focus: 'many' } },
    { op: 'forget', scope: 'all', before: 'yesterday-ish' },
  ];
  for (const h of hostile) await assert.rejects(ps.apply(h), undefined, JSON.stringify(h));
  assert.equal(fs.files.get(ps.statePath), before);
  assert.ok(![...fs.files.keys()].some((k) => k.endsWith('.tmp')));
});

// ---- main Store: recovery, read-only, retention, backup rotation ----------------------------------------------------
function mainStore(fs = memFs(), now = () => new Date(T0)) {
  let n = 0;
  return { fs, st: new store.Store({ dir: 'D:\\main', fs: fs.api, now, newId: () => `m${++n}` }) };
}
const mainPath = path.join('D:\\main', 'state.json');
const backupDir = path.join('D:\\main', 'backups');
const envelope = (state, schemaVersion = 1) => JSON.stringify({ schemaVersion, savedAt: new Date(T0).toISOString(), state });
const msgAt = (id, at) => ({ id, role: 'user', text: id, createdAt: at, source: 'local' });
const daysAgo = (d) => new Date(T0 - d * 86_400_000).toISOString();

test('a corrupt main state file is quarantined and the newest valid backup is restored', async () => {
  const fs = memFs();
  const good = validation.defaultState();
  good.notes.push({ id: 'n1', title: 'from backup', body: '', tags: [], updatedAt: daysAgo(1) });
  fs.files.set(path.join(backupDir, 'state-20261013-120000.json'), envelope(good));
  fs.files.set(path.join(backupDir, 'state-20261014-110000.json'), '{"broken'); // newest is itself damaged: skipped
  fs.files.set(mainPath, '{"schemaVersion":1,"state":');
  const { st } = mainStore(fs);
  const r = await st.load();
  assert.equal(r.recovered, true);
  assert.deepEqual(st.snapshot().notes.map((n) => n.title), ['from backup']);
  assert.ok([...fs.files.keys()].some((k) => /state\.corrupt-\d{8}-\d{6}\.json$/.test(k)), 'damaged file kept for inspection');
  assert.ok(st.snapshot().activity.some((a) => a.kind === 'recovery'), 'the recovery is visible in the activity log');
  assert.deepEqual(JSON.parse(fs.files.get(mainPath)).state.notes.map((n) => n.id), ['n1'], 'repaired file written back');
});

test('with no usable backup a corrupt file resets to defaults instead of crashing', async () => {
  const fs = memFs();
  fs.files.set(mainPath, 'garbage');
  const { st } = mainStore(fs);
  const r = await st.load();
  assert.equal(r.recovered, true);
  assert.match(r.warning, /could not be recovered/);
  assert.deepEqual(st.snapshot().notes, []);
});

test('data written by a newer version opens read-only and is never overwritten', async () => {
  const fs = memFs();
  const newer = envelope(validation.defaultState(), 99);
  fs.files.set(mainPath, newer);
  const { st } = mainStore(fs);
  const r = await st.load();
  assert.equal(r.readOnly, true);
  assert.equal(st.isReadOnly, true);
  await assert.rejects(st.mutate((d) => { d.notes.length = 0; }), /read-only/);
  await assert.rejects(st.importDocument(JSON.stringify({ format: 'jarvis-export', schemaVersion: 1, state: validation.defaultState() })), /read-only/);
  assert.equal(fs.files.get(mainPath), newer);
});

test('load drops chat and activity older than retainDays and keeps notes, tasks and capsules', async () => {
  const fs = memFs();
  const s = validation.defaultState();
  s.settings.retainDays = 30;
  s.notes.push({ id: 'n1', title: 'ancient note', body: '', tags: [], updatedAt: daysAgo(500) });
  s.tasks.push({ id: 't1', title: 'ancient task', done: true, createdAt: daysAgo(500) });
  s.chat.push(msgAt('old', daysAgo(45)), msgAt('new', daysAgo(2)));
  s.activity.push({ id: 'a1', at: daysAgo(45), kind: 'x', summary: 'old' }, { id: 'a2', at: daysAgo(2), kind: 'x', summary: 'new' });
  fs.files.set(mainPath, envelope(s));
  const { st } = mainStore(fs);
  await st.load();
  const g = st.snapshot();
  assert.deepEqual(g.chat.map((m) => m.id), ['new']);
  assert.deepEqual(g.activity.map((a) => a.id), ['a2']);
  assert.equal(g.notes.length, 1);
  assert.equal(g.tasks.length, 1);
  // applyRetention applies the same rule later in the session, atomically.
  await st.mutate((d) => { d.chat.push(msgAt('stale', daysAgo(400))); });
  await st.applyRetention();
  assert.deepEqual(st.snapshot().chat.map((m) => m.id), ['new']);
});

test('backup rotation keeps the newest ten, the newest of each of the last seven days and five pre-import files', async () => {
  let now = T0;
  const { fs, st } = mainStore(memFs(), () => new Date(now));
  await st.load();
  const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const seed = (prefix, ms) => fs.files.set(path.join(backupDir, `${prefix}-${stampOf(ms)}.json`), envelope(validation.defaultState()));
  const d = 86_400_000;
  seed('state', T0 - 30 * d); seed('state', T0 - 30 * d + 1000);
  seed('state', T0 - 3 * d - 6 * 3600_000); seed('state', T0 - 3 * d);
  for (let i = 0; i < 7; i++) seed('pre-import', T0 - 20 * d + i * 1000);
  for (let i = 0; i < 11; i++) { now = T0 + i * 1000; await st.backup('auto'); }
  const names = (await fs.api.readdir(backupDir)).sort();
  const rolling = names.filter((n) => n.startsWith('state-'));
  assert.equal(rolling.length, 11, 'ten newest plus the newest of the day three days ago');
  assert.ok(rolling.includes(`state-${stampOf(T0 - 3 * d)}.json`), 'newest backup of an older day within the window is kept');
  assert.ok(!rolling.includes(`state-${stampOf(T0 - 3 * d - 6 * 3600_000)}.json`), 'a second backup of that day is not');
  assert.ok(!rolling.some((n) => n.includes(stampOf(T0 - 30 * d))), 'backups outside both rules are removed');
  assert.equal(names.filter((n) => n.startsWith('pre-import-')).length, 5);
});

test('importing keeps current permissions even when the file lists more folders and apps', async () => {
  const { fs, st } = mainStore();
  await st.load();
  const incoming = validation.defaultState();
  incoming.settings.approvedApps = ['code.exe'];
  incoming.settings.allowedRoots = ['C:\\Work'];
  incoming.notes.push({ id: 'imp', title: 'imported', body: '', tags: [], updatedAt: daysAgo(1) });
  const done = await st.importDocument(JSON.stringify({ format: 'jarvis-export', schemaVersion: 1, state: incoming }));
  assert.deepEqual(done.settings.approvedApps, []);
  assert.deepEqual(done.settings.allowedRoots, []);
  assert.deepEqual(done.notes.map((n) => n.id), ['imp']);
  const entry = done.activity.at(-1);
  assert.equal(entry.kind, 'import');
  assert.match(entry.details, /approved app\(s\): code\.exe/);
  assert.match(entry.details, /allowed folder\(s\): C:\\Work/);
  assert.ok([...fs.files.keys()].some((k) => path.basename(k).startsWith('pre-import-')));
});

// ---- capsule preview, geometry and portable packs --------------------------------------------------------------------
const win = (over = {}) => ({ hwnd: 1, pid: 100, title: 'Docs - Editor', process: 'code.exe', x: 10, y: 20, width: 800, height: 600, minimized: false, maximized: false, foreground: false, elevated: 0, ...over });
const rect = (over = {}) => ({ title: 'Docs', process: 'code.exe', x: 0, y: 0, width: 400, height: 300, ...over });

test('previewGeometry matches, reports blocked and unmatched windows, and flags rectangles off every display', () => {
  const rows = capsules.previewGeometry({ windows: [rect(), rect({ process: 'ghost.exe' }), rect({ process: 'admin.exe' }), rect({ x: 9000 })] },
    [win(), win({ hwnd: 2, process: 'admin.exe', elevated: 1 }), win({ hwnd: 3, process: 'code.exe', title: 'other' })], [999], [{ x: 0, y: 0, width: 1920, height: 1080 }]);
  assert.deepEqual(rows.map((r) => r.status), ['match', 'no-match', 'blocked', 'match']);
  assert.equal(rows[0].window.hwnd, 1, 'title match wins over the same process with another title');
  assert.equal(rows[3].window.hwnd, 3, 'a window is used at most once');
  assert.equal(rows[3].offscreen, true);
  assert.equal(rows[0].offscreen, false);
  assert.match(rows[2].reason, /elevated/);
  assert.equal(capsules.previewGeometry({}, [win()], []).length, 0);
});

test('captureGeometry saves only ticked, restorable windows and explains every skip', () => {
  const r = capsules.captureGeometry([win(), win({ hwnd: 2, minimized: true }), win({ hwnd: 3, maximized: true }), win({ hwnd: 4, elevated: 1 }), win({ hwnd: 5, pid: 999 }), win({ hwnd: 6, width: 0 }), win({ hwnd: 7 })],
    [1, 2, 3, 4, 5, 6, 77], [999]);
  assert.deepEqual(r.windows.map((w) => w.process), ['code.exe']);
  assert.equal(r.windows[0].x, 10);
  assert.equal(r.skipped.length, 6, 'window 7 was not ticked and is ignored; the other six are all explained');
  assert.ok(r.skipped.every((s) => s.reason));
  assert.match(r.skipped.find((s) => s.hwnd === 77).reason, /no longer open/);
  assert.match(r.skipped.find((s) => s.hwnd === 2).reason, /Minimized/);
});

test('previewRestore authorizes every item without running it and survives a failing window listing', async () => {
  let ran = 0;
  const actions = { prepareItem: async (kind, target) => (target.includes('blocked') ? { ok: false, reason: 'Outside your allowed folders' } : { ok: true, detail: `Open ${target}`, run: async () => { ran++; return { ok: true }; } }), claimAction: () => true };
  const state = { capsules: [{ id: 'c1', name: 'Proj', description: '', scene: 'graphite', createdAt: 'x', updatedAt: 'x', items: [{ kind: 'file', label: 'A', target: 'C:\\ok\\a.txt' }, { kind: 'file', label: 'B', target: 'C:\\blocked\\b.txt' }], windows: [rect()] }] };
  const native = { listWindows: async () => { throw new Error('enumeration failed'); }, moveWindow: async () => { throw new Error('must not move'); } };
  const deps = { state: () => state, actions, native, selfPids: () => [] };
  const r = await capsules.previewRestore(deps, 'c1');
  assert.deepEqual(r.items.map((i) => [i.ok, i.detail]), [[true, 'Open C:\\ok\\a.txt'], [false, 'Outside your allowed folders']]);
  assert.match(r.windowsError, /enumeration failed/);
  assert.equal(ran, 0, 'previewing never launches anything');
  await assert.rejects(capsules.previewRestore(deps, 'nope'), /not found/);
  await assert.rejects(capsules.previewRestore(deps, 5), /invalid/);
});

const sampleCapsule = () => ({ id: 'c1', name: 'Launch', description: 'ship it', scene: 'graphite', createdAt: 'x', updatedAt: 'x', items: [{ kind: 'folder', label: 'Repo', target: 'C:\\Work\\proj\\src' }, { kind: 'url', label: 'Spec', target: 'https://example.com/spec' }, { kind: 'file', label: 'Outside', target: 'D:\\Elsewhere\\x.txt' }], windows: [rect()] });

test('a capsule pack replaces the project root with a token, reports unmapped paths and round-trips through a new root', () => {
  const meta = { goals: [{ text: 'Ship' }], references: [{ kind: 'folder', target: 'C:\\Work\\proj', label: 'Repo' }, { kind: 'note', target: 'n1', label: '' }, { kind: 'url', target: 'https://example.com/a', label: 'A', note: 'n' }] };
  const out = capsules.exportCapsulePack(sampleCapsule(), meta, [{ name: 'project', path: 'C:\\Work\\proj' }], new Date(T0));
  const doc = JSON.parse(out.json);
  assert.equal(doc.format, capsules.PACK_FORMAT);
  assert.equal(doc.capsules[0].items[0].target, '{ROOT:project}\\src');
  assert.deepEqual(out.unmapped, ['D:\\Elsewhere\\x.txt']);
  assert.equal(doc.capsules[0].references.length, 2, 'note references are internal ids and do not travel');
  assert.ok(!out.json.includes('"id"'), 'no internal ids in the pack');

  const needs = capsules.parseCapsulePack(out.json);
  assert.deepEqual(needs.roots, ['project']);
  assert.ok(needs.skipped.some((s) => /ROOT:project/.test(s.reason)));
  const ok = capsules.parseCapsulePack(out.json, [{ from: '{ROOT:project}', to: 'E:\\Other\\proj' }]);
  assert.equal(ok.capsules[0].items[0].target, 'E:\\Other\\proj\\src');
  assert.deepEqual(ok.capsules[0].goals, ['Ship']);
  assert.ok(ok.notes[0].includes('not pre-approved'));
  assert.equal(ok.capsules[0].windows.length, 1);
});

test('importing a hostile or malformed pack skips unsafe items and rejects non-packs', () => {
  const pack = (capsule) => JSON.stringify({ format: capsules.PACK_FORMAT, schemaVersion: 1, capsules: [capsule] });
  const r = capsules.parseCapsulePack(pack({ name: 'Evil', scene: 'x'.repeat(200), items: [
    { kind: 'file', target: '\\\\attacker\\share\\payload.exe', label: 'unc' },
    { kind: 'file', target: 'C:\\a\\..\\..\\Windows\\cmd.exe', label: 'traversal' },
    { kind: 'file', target: '..\\relative.txt', label: 'relative' },
    { kind: 'url', target: 'javascript:alert(1)', label: 'js' },
    { kind: 'url', target: 'file:///C:/secret', label: 'file url' },
    { kind: 'app', target: 'C:\\Windows\\System32\\cmd.exe', label: 'app path' },
    { kind: 'file', target: 'C:\\ok\\fine.txt\u0000.exe', label: 'nul' },
    { kind: 'folder', target: 'C:\\Work\\fine', label: 'fine' },
    { kind: 'rocket', target: 'x' }, 'not an object',
  ], windows: [{ process: 'a.exe', x: 0, y: 0, width: -5, height: 5 }, { process: '', x: 0, y: 0, width: 5, height: 5 }], goals: [5, '  ', 'real goal'], references: [{ kind: 'url', target: 'https://ok.example/', label: 'ok' }, { kind: 'file', target: '\\\\x\\y' }] }));
  // An absolute app path is plain data here; approval is checked per item when the capsule is restored (prepareItem),
  // so a pack cannot approve anything. Everything unsafe in form (UNC, traversal, relative, NUL, bad URL, unknown kind) is dropped.
  assert.deepEqual(r.capsules[0].items.map((i) => i.label), ['app path', 'fine']);
  assert.ok(r.notes.some((n) => /not pre-approved/.test(n)));
  assert.ok(r.skipped.length >= 8);
  assert.equal(r.capsules[0].scene.length, 64);
  assert.equal(r.capsules[0].windows, undefined);
  assert.deepEqual(r.capsules[0].goals, ['real goal']);
  assert.deepEqual(r.capsules[0].references.map((x) => x.label), ['ok']);
  for (const bad of ['{', '[]', JSON.stringify({ format: 'other', schemaVersion: 1, capsules: [{}] }), JSON.stringify({ format: capsules.PACK_FORMAT, schemaVersion: 2, capsules: [{ name: 'x' }] }),
    JSON.stringify({ format: capsules.PACK_FORMAT, schemaVersion: 1, capsules: [] }), pack({ name: '   ' }), 5, 'x'.repeat(capsules.PACK_LIMITS.bytes + 1)]) {
    assert.throws(() => capsules.parseCapsulePack(bad), undefined, String(bad).slice(0, 30));
  }
  assert.throws(() => capsules.parseCapsulePack(JSON.stringify({ format: capsules.PACK_FORMAT, schemaVersion: 1, capsules: Array.from({ length: 21 }, () => ({ name: 'n' })) })), /1 to 20/);
});

test('path mapping prefers the longest root and only matches whole path segments', () => {
  const m = [{ from: 'C:\\Work', to: 'E:\\A' }, { from: 'C:\\Work\\proj', to: 'E:\\B' }];
  assert.deepEqual(capsules.mapPath('C:\\Work\\proj\\x.txt', m), { path: 'E:\\B\\x.txt' });
  assert.deepEqual(capsules.mapPath('C:\\Work\\other\\y.txt', m), { path: 'E:\\A\\other\\y.txt' });
  assert.deepEqual(capsules.mapPath('C:\\Workshop\\z.txt', m), { path: 'C:\\Workshop\\z.txt' }, 'C:\\Workshop is not under C:\\Work');
  assert.ok('error' in capsules.mapPath('{ROOT:proj}\\a', []));
  assert.ok('error' in capsules.mapPath('{ROOT:proj}\\..\\..\\b', [{ from: '{ROOT:proj}', to: 'E:\\B' }]), 'a mapped path may not climb out');
});

// ---- views -------------------------------------------------------------------------------------------------------------
const noop = async () => true;
function viewStore(over = {}) {
  const s = appState();
  s.settings = { retainDays: 30 };
  return { state: s, settings: s.settings, api: { pickPath: async () => null, clearChat: async () => s, saveCapsule: async () => s, getState: async () => s }, productivityApi: null, productivity: null, productivityError: null, applyProductivity: noop, refreshProductivity: async () => {}, run: async (f) => f(), mutate: noop, toast: () => {}, ...over };
}
const html = (el) => renderToStaticMarkup(el);
const capsuleOf = (s) => s.capsules[0];

test('ProjectMemory says plainly that storage is not connected and offers no forms', () => {
  globalThis.__store = viewStore();
  const out = html(createElement(ProjectMemory, { capsule: capsuleOf(globalThis.__store.state) }));
  assert.match(out, /Local productivity storage is not connected/);
  assert.ok(!/Add checkpoint|Save checkpoint/i.test(out));
});

test('ProjectMemory shows saved goals, checkpoints, references and a recap built from them', () => {
  const p = prodState();
  globalThis.__store = viewStore({ productivityApi: { get: async () => p, apply: async () => p }, productivity: p });
  const out = html(createElement(ProjectMemory, { capsule: capsuleOf(globalThis.__store.state) }));
  for (const text of ['Sign the installer', 'Installer builds', 'Spec doc']) assert.ok(out.includes(text), text);
  assert.match(out, /Goal open: Sign the installer/);
  assert.ok(!out.includes('Planted tomatoes'), 'another capsule checkpoint is not shown');
});

test('RestoreTools hides capture and pack controls that this build cannot perform', () => {
  const state = appState();
  globalThis.__store = viewStore();
  const none = html(createElement(RestoreTools, { capsule: capsuleOf(state), dirty: false }));
  assert.match(none, /not connected in this build/);
  assert.ok(!none.includes('Preview restore'));
  const p = store.emptyProductivity();
  globalThis.__store = viewStore({ productivity: p, productivityApi: { get: async () => p, apply: async () => p, capsule: { previewRestore: async () => ({ capsule: 'x', items: [], windows: [] }) } } });
  const some = html(createElement(RestoreTools, { capsule: capsuleOf(state), dirty: false }));
  assert.ok(some.includes('Preview restore'));
  assert.ok(!some.includes('Choose windows to save'), 'window listing is not offered without listWindows/captureGeometry');
  const dirty = html(createElement(RestoreTools, { capsule: capsuleOf(state), dirty: true }));
  assert.match(dirty, /<button[^>]*disabled[^>]*>[\s\S]*?Preview restore/, 'preview is disabled while edits are unsaved');
});

test('MemoryControls starts with the timeline off, offers per-scope forgetting and marks screen/audio capture unavailable', () => {
  const p = store.emptyProductivity();
  globalThis.__store = viewStore({ productivityApi: { get: async () => p, apply: async () => p }, productivity: p });
  const out = html(createElement(MemoryControls));
  assert.match(out, /Record which applications I use/);
  for (const w of ['Forget chat history', 'Forget checkpoints', 'Forget application timeline', 'Forget file shelf', 'Forget everything above']) assert.ok(out.includes(w), w);
  assert.match(out, /Not available: screen history and meeting capture/);
  assert.match(out, /Nothing is currently past its retention period/);
  globalThis.__store = viewStore();
  const noApi = html(createElement(MemoryControls));
  assert.match(noApi, /not connected/);
  assert.match(noApi, /Clear chat history/);
  assert.ok(!noApi.includes('Forget checkpoints'));
});

test('MemoryControls previews what retention would remove before anything is deleted', () => {
  const p = prodState();
  p.policy.retainDays.focus = 1;
  globalThis.__store = viewStore({ productivityApi: { get: async () => p, apply: async () => p }, productivity: p });
  globalThis.__store.state.chat[0].createdAt = '2020-01-01T00:00:00.000Z';
  const out = html(createElement(MemoryControls));
  assert.match(out, /saved record\(s\) are due to be removed/);
});

test('MemorySearch links results that have a screen and lists the rest without a link', () => {
  const s = appState(), p = prodState();
  p.checkpoints[0].capsuleId = undefined; // no screen for this checkpoint
  const out = html(createElement(MemorySearch, { state: s, productivity: p, initialQuery: 'installer', onNavigate: () => {} }));
  assert.ok(/<button[^>]*data-result[^>]*>[\s\S]*?Launch checklist/.test(out), 'a note result is a button');
  assert.ok(/data-nolink[^>]*>[\s\S]*?Installer builds/.test(out), 'a checkpoint with no capsule is listed without a link');
  assert.ok(/data-nolink[^>]*>[\s\S]*?Installer guide/.test(out), 'a shelf item is listed without a link');
  assert.ok(!out.includes('installer question'), 'chat history stays off until switched on');
});

test('forgetHistory validates what arrives over IPC: a date, booleans, and at least one history kind', async () => {
  assert.deepEqual(store.parseForgetHistory({ chat: true, before: '2026-10-01T00:00:00Z' }), { chat: true, activity: false, before: '2026-10-01T00:00:00.000Z' });
  for (const bad of [undefined, null, 'chat', [], {}, { chat: false }, { chat: 'yes' }, { activity: 1 }, { chat: true, before: 'never' }, { chat: true, before: 5 }]) {
    assert.throws(() => store.parseForgetHistory(bad), undefined, JSON.stringify(bad));
  }
  const { fs, st } = mainStore();
  await st.load();
  await st.mutate((d) => { d.chat.push(msgAt('c1', daysAgo(1))); });
  const before = fs.files.get(mainPath);
  await assert.rejects(st.forgetHistory({}));
  await assert.rejects(st.forgetHistory({ chat: 'true' }));
  assert.equal(fs.files.get(mainPath), before, 'a rejected request changes nothing');
  assert.equal(st.snapshot().chat.length, 1);
});

test('MemorySearch reads productivity data from the app store when its caller passes none', () => {
  const p = prodState();
  globalThis.__store = viewStore({ productivityApi: { get: async () => p, apply: async () => p }, productivity: p });
  const s = globalThis.__store.state;
  const fromStore = html(createElement(MemorySearch, { state: s, initialQuery: 'planted', onNavigate: () => {} }));
  assert.ok(fromStore.includes('Planted tomatoes'), 'a checkpoint is found without the caller passing the sidecar');
  const override = html(createElement(MemorySearch, { state: s, initialQuery: 'planted', productivity: null, onNavigate: () => {} }));
  assert.ok(!override.includes('Planted tomatoes'), 'an explicit null turns sidecar search off');
  globalThis.__store = viewStore();
  assert.ok(!html(createElement(MemorySearch, { state: s, initialQuery: 'planted', onNavigate: () => {} })).includes('Planted tomatoes'), 'no sidecar connected: nothing invented');
});
