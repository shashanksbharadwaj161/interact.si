// Notes and Memory search: draft keeping, bounded rendering, restored/stale-draft notices, source-linked search results
// and the existing tag controls. Bundles the real TypeScript in memory and renders it to static markup; no Electron,
// network, files or desktop input. Interactive flows (typing, Save, Delete) need a DOM and are not exercised here.
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
    sourcefile: 'parallel-notes-entry.ts',
    loader: 'tsx',
    contents: `
      export * as store from './electron/services/store.ts';
      export { Notes, NOTE_PAGE, noteDrafts, noteSnippet, sameDraft } from './src/components/Notes.tsx';
      export { MemorySearch, describeSource } from './src/components/MemorySearch.tsx';
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
        b.onResolve({ filter: /\/ui\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onLoad({ filter: /^icons$/, namespace: 'stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ contents: 'export const useReady = () => globalThis.__store; export const useStore = () => globalThis.__store; export const useOptionalStore = () => globalThis.__store ?? null;' }));
      },
    },
  ],
  logLevel: 'silent',
});
const { store, Notes, NOTE_PAGE, noteDrafts, noteSnippet, sameDraft, MemorySearch, describeSource, createElement, renderToStaticMarkup } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const T = '2026-10-10T08:00:00.000Z';
const res = (category, id) => ({ category, id, title: '', snippet: '', relevance: 1 });

function appState(extraNotes = 0) {
  const notes = [
    { id: 'n1', title: 'Launch checklist', body: 'Verify installer signing', tags: ['snippet', 'launch'], updatedAt: hoursAgo(2) },
    { id: 'n2', title: 'Groceries', body: 'milk and eggs', tags: ['home'], updatedAt: hoursAgo(50) },
  ];
  // Older notes pad the list; the two above stay the newest.
  for (let i = 0; i < extraNotes; i++) notes.push({ id: `bulk${i}`, title: `Bulk note ${i}`, body: `body ${i}`, tags: i % 2 ? ['bulk'] : [], updatedAt: hoursAgo(100 + i) });
  return {
    settings: { retainDays: 30 },
    notes,
    tasks: [{ id: 't1', title: 'Fix installer bug', done: false, due: '2026-10-14', createdAt: T }, { id: 't2', title: 'Pay installer invoice', done: true, createdAt: T }],
    capsules: [{ id: 'c1', name: 'Launch project', description: '', scene: 'graphite', createdAt: T, updatedAt: hoursAgo(5), items: [] }],
    chat: [{ id: 'm1', role: 'user', text: 'installer question', createdAt: hoursAgo(1), source: 'local' }],
    activity: [],
  };
}
function prodState() {
  const p = store.emptyProductivity();
  p.capsuleMeta = { c1: { goals: [], references: [{ kind: 'note', target: 'n1', label: 'Launch checklist' }] } };
  p.checkpoints = [
    { id: 'cp1', capsuleId: 'c1', title: 'Installer builds', note: 'installer builds are green', createdAt: hoursAgo(3), refs: [] },
    { id: 'cp2', title: 'Installer orphan', note: 'installer checkpoint with no capsule', createdAt: hoursAgo(3), refs: [] },
  ];
  return p;
}
function viewStore(state, over = {}) {
  return { state, settings: state.settings, api: { getState: async () => state, saveNote: async () => state, deleteNote: async () => state }, productivity: null, mutate: async () => true, toast: () => {}, ...over };
}
const html = (el) => renderToStaticMarkup(el);
const renderNotes = (state, props = {}, over = {}) => {
  globalThis.__store = viewStore(state, over);
  return html(createElement(Notes, props));
};

test.beforeEach(() => noteDrafts.reset());

test('noteSnippet reads only the start of a body, so a maximum-size note is as cheap as a short one', () => {
  const huge = 'word '.repeat(4000);
  assert.equal(huge.length, 20000);
  const s = noteSnippet(huge);
  assert.ok(s.length <= 72, `snippet is ${s.length} characters`);
  assert.equal(noteSnippet('  a\n\n  b\tc '), 'a b c');
  assert.equal(noteSnippet(''), '');
  // text beyond the inspected prefix is never read
  assert.equal(noteSnippet(`${'x'.repeat(400)}${' '.repeat(100_000)}tail`).includes('tail'), false);
});

test('sameDraft compares title, body and tag order', () => {
  const d = { id: 'a', title: 't', body: 'b', tags: ['x', 'y'] };
  assert.equal(sameDraft(d, { ...d, tags: ['x', 'y'] }), true);
  assert.equal(sameDraft(d, { ...d, tags: ['y', 'x'] }), false);
  assert.equal(sameDraft(d, { ...d, tags: ['x'] }), false);
  assert.equal(sameDraft(d, { ...d, body: 'b ' }), false);
  assert.equal(sameDraft(d, { ...d, title: 'T' }), false);
});

test('the in-memory draft cache is bounded, keeps recency order and forgets cleared drafts', () => {
  for (let i = 0; i < 30; i++) noteDrafts.set(`k${i}`, { draft: { title: `d${i}`, body: '', tags: [] } });
  assert.equal(noteDrafts.size(), 20, 'only the 20 newest drafts are kept');
  assert.equal(noteDrafts.get('k0'), undefined);
  assert.equal(noteDrafts.latest(), 'k29');
  noteDrafts.set('k15', { draft: { title: 'again', body: '', tags: [] } });
  assert.equal(noteDrafts.latest(), 'k15', 'editing a draft again makes it the latest');
  noteDrafts.clear('k15');
  assert.equal(noteDrafts.get('k15'), undefined);
  assert.equal(noteDrafts.latest(), 'k29');
  noteDrafts.reset();
  assert.equal(noteDrafts.latest(), undefined);
});

test('Notes opens the first note, shows tag filters with counts and does not claim unsaved changes', () => {
  const out = renderNotes(appState());
  assert.match(out, /value="Launch checklist"/);
  assert.match(out, /Verify installer signing/);
  assert.ok(out.includes('#snippet') && out.includes('#home'));
  assert.match(out, /2 notes\./);
  assert.ok(!out.includes('Unsaved changes'));
  assert.ok(!out.includes('Unsaved draft restored'));
  assert.ok(!out.includes('Revert'), 'nothing to revert on a clean note');
  assert.match(out, /Ctrl\+S saves/);
});

test('Notes with no notes explains where text is kept and offers a first note', () => {
  const out = renderNotes({ ...appState(), notes: [] });
  assert.match(out, /No notes yet/);
  assert.match(out, /Write the first note/);
  assert.match(out, /stay on this computer/);
  assert.match(out, /Select or create a note/);
});

test('a long note list renders one page and says how many are not shown', () => {
  const total = 2 + 250;
  const out = renderNotes(appState(250));
  assert.equal((out.match(/data-note/g) ?? []).length, NOTE_PAGE, 'one page of notes is in the DOM');
  assert.match(out, new RegExp(`Show ${NOTE_PAGE} more \\(${total - NOTE_PAGE} not shown\\)`));
  assert.match(out, new RegExp(`${total} notes\\.`));
  assert.ok(!out.includes('Bulk note 249'), 'notes past the page are not rendered');
  const state = appState();
  state.notes[0].body = 'word '.repeat(4000);
  assert.match(renderNotes(state), /Limit of 20,000 characters reached/);
});

test('a routed note opens first, and a deep link to an unknown id falls back to the first note', () => {
  assert.match(renderNotes(appState(), { initialItem: 'n2' }), /value="Groceries"/);
  assert.match(renderNotes(appState(), { initialItem: 'does-not-exist' }), /value="Launch checklist"/);
});

test('an unsaved draft left on leaving the page is restored with an explicit notice and a way back', () => {
  const state = appState();
  noteDrafts.set('n2', { draft: { id: 'n2', title: 'Groceries', body: 'milk, eggs and flour', tags: ['home'] }, loadedAt: state.notes[1].updatedAt });
  const out = renderNotes(state);
  assert.match(out, /value="Groceries"/, 'the draft note is reopened rather than the first note');
  assert.match(out, /milk, eggs and flour/);
  assert.match(out, /Unsaved draft restored/);
  assert.match(out, /Unsaved changes/);
  assert.match(out, /lost if the app closes/, 'says plainly that the draft is memory-only');
  assert.match(out, />Revert</);
  assert.ok(out.includes('Launch checklist'), 'the other note is still listed');
  assert.ok(!out.includes('changed after you started editing'));
});

test('a restored draft built on an older saved version warns before it would overwrite a newer one', () => {
  noteDrafts.set('n2', { draft: { id: 'n2', title: 'Groceries', body: 'my edit', tags: [] }, loadedAt: '2020-01-01T00:00:00.000Z' });
  const out = renderNotes(appState());
  assert.match(out, /This note changed after you started editing/);
  assert.match(out, /replaces the stored version/);
});

test('an explicit deep link wins over a stored draft, and a draft for another note is flagged in the list', () => {
  const state = appState();
  noteDrafts.set('n2', { draft: { id: 'n2', title: 'Groceries', body: 'edited', tags: [] }, loadedAt: state.notes[1].updatedAt });
  const out = renderNotes(state, { initialItem: 'n1' });
  assert.match(out, /value="Launch checklist"/);
  assert.ok(!out.includes('Unsaved draft restored'));
  assert.match(out, /Groceries \(unsaved draft\)/, 'the list marks the note that still has an unsaved draft');
});

test('an unsaved new-note draft is restored as a new note that can be cleared', () => {
  noteDrafts.set('new', { draft: { title: 'Idea', body: 'half a thought', tags: ['draft'] } });
  const out = renderNotes(appState());
  assert.match(out, /value="Idea"/);
  assert.match(out, /half a thought/);
  assert.match(out, />Clear draft</);
  assert.ok(!out.includes('>Delete<'), 'a note that was never saved cannot be deleted');
});

test('a stored draft for a note that no longer exists is ignored instead of resurrecting a stale id', () => {
  noteDrafts.set('gone', { draft: { id: 'gone', title: 'Ghost', body: 'x', tags: [] } });
  const out = renderNotes(appState());
  assert.ok(!out.includes('Ghost'));
  assert.match(out, /value="Launch checklist"/);
});

test('delete confirmation wording and Cancel-first focus are in place', async () => {
  // ConfirmDialog renders nothing while closed, so pin the source that builds its text and the dialog's focus target.
  const src = await readFile(path.join(root, 'src/components/Notes.tsx'), 'utf8');
  assert.match(src, /cannot be undone; automatic backups/);
  assert.match(src, /still reference/);
  const dialog = await readFile(path.join(root, 'src/ui/Dialog.tsx'), 'utf8');
  assert.match(dialog, /onClick=\{onCancel\} disabled=\{busy\} data-autofocus/, 'Cancel takes initial focus in confirm dialogs');
});

// ---- Memory search -------------------------------------------------------------------------------------------------

test('describeSource states only what the stored record shows', () => {
  const state = appState(), prod = prodState();
  const note = describeSource(res('note', 'n1'), state, prod);
  assert.match(note, /^Note · #snippet #launch · updated /);
  assert.match(note, /in capsule Launch project/, 'the capsule that references the note is named');
  assert.ok(!describeSource(res('note', 'n2'), state, prod).includes('capsule'), 'an unreferenced note is not attributed to a capsule');
  assert.equal(describeSource(res('note', 'zzz'), state, prod), 'Note', 'unknown record adds no invented detail');
  assert.equal(describeSource(res('task', 't1'), state), 'Task (open) · due 2026-10-14');
  assert.equal(describeSource(res('task', 't2'), state), 'Task (done)');
  assert.match(describeSource(res('checkpoint', 'cp1'), state, prod), /^Checkpoint in capsule Launch project · /);
  assert.match(describeSource(res('checkpoint', 'cp2'), state, prod), /^Checkpoint · /);
  assert.equal(describeSource(res('checkpoint', 'cp1'), state), 'Checkpoint', 'without the sidecar nothing is claimed');
  assert.match(describeSource(res('chat', 'm1'), state), /^Chat message \(local\) · /);
  assert.equal(describeSource(res('history', 'a'), state), 'Activity log');
  assert.equal(describeSource(res('reference', 'r'), state), 'File shelf');
  assert.match(describeSource(res('external', 'e1'), state, null, [{ source: 'Calendar', id: 'e1', title: 'x', at: hoursAgo(1) }]), /^Calendar · /);
  assert.equal(describeSource(res('external', 'e2'), state), 'Other source');
});

test('MemorySearch results show their source, and the note tag filter offers the tags that exist', () => {
  const state = appState(), prod = prodState();
  const out = html(createElement(MemorySearch, { state, productivity: prod, initialQuery: 'installer', onNavigate: () => {} }));
  assert.match(out, /data-source[^>]*>Note · #snippet #launch/);
  assert.match(out, /data-source[^>]*>Checkpoint in capsule Launch project/);
  assert.match(out, /data-source[^>]*>Task \(open\) · due 2026-10-14/);
  assert.ok(!out.includes('installer question'), 'chat history stays off until switched on');
  for (const tag of ['home', 'launch', 'snippet']) assert.ok(out.includes(`<option value="${tag}"`), `tag suggestion ${tag}`);
  assert.ok(!out.includes('Clear filters'), 'no filter is active, so no clear button');
  assert.match(out, /Nothing is sent to a model or the internet/);
});

test('MemorySearch with no tagged notes says so, and an empty query shows guidance rather than results', () => {
  const state = appState();
  state.notes.forEach((n) => (n.tags = []));
  const out = html(createElement(MemorySearch, { state, initialQuery: '', onNavigate: () => {} }));
  assert.match(out, /No notes have tags yet/);
  assert.match(out, /Search what you have saved/);
  assert.ok(!out.includes('data-source'));
  assert.match(html(createElement(MemorySearch, { state, initialQuery: '!!!', onNavigate: () => {} })), /Type letters or numbers to search/);
});

test('MemorySearch keeps the best-matches-only message and bounds the rendered results', () => {
  const state = appState(80);
  state.notes.forEach((n) => (n.title = `Report ${n.id}`));
  const out = html(createElement(MemorySearch, { state, initialQuery: 'report', limit: 5, onNavigate: () => {} }));
  assert.equal((out.match(/data-result/g) ?? []).length, 5);
  assert.match(out, /5 results \(showing the best matches only\)/);
});
