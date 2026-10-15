// Workspace module tests: portable memory (store), evidence resolution and recap filtering (search), workbench helpers,
// bounded prompt tools and the three screens. Bundles the real TypeScript in memory with an in-memory file system and a
// fake bridge; no real files, desktop, network, model or Electron. Nothing here sends anything anywhere.
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
    sourcefile: 'workspace-test-entry.ts',
    loader: 'tsx',
    contents: `
      export * as store from './electron/services/store.ts';
      export * as search from './electron/services/search.ts';
      export * as portable from './electron/services/portable.ts';
      export {validateOpenUrl} from './electron/services/policy.ts';
      export {normalizeAbsolutePath} from './electron/services/paths.ts';
      export * as wb from './src/ui/workbench.ts';
      export * as pt from './src/ui/prompt-tools.ts';
      export { MemoryWorkbench } from './src/components/MemoryWorkbench.tsx';
      export { WritingWorkbench, DocumentImport, localDocumentsBridge } from './src/components/WritingWorkbench.tsx';
      export { PromptTools } from './src/components/PromptTools.tsx';
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
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { store, search, portable, wb, pt, MemoryWorkbench, WritingWorkbench, DocumentImport, localDocumentsBridge, PromptTools, createElement, renderToStaticMarkup } = mod;

// ---- fixtures ----------------------------------------------------------------------------------------------------
const NOW = new Date('2026-10-15T10:00:00.000Z');
const T0 = NOW.getTime();
const iso = (ms) => new Date(ms).toISOString();

function memFs() {
  const files = new Map();
  return {
    files,
    api: {
      mkdir: async () => {},
      readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
      readdir: async (dir) => [...files.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)),
      unlink: async (p) => { files.delete(p); },
    },
  };
}
async function mkStore() {
  const fs = memFs();
  let n = 0;
  const ps = new store.ProductivityStore({ dir: 'D:\\data', fs: fs.api, now: () => NOW, newId: () => `id${++n}` });
  await ps.load();
  return { ps, fs };
}

function appState() {
  return {
    settings: { onboarded: true, mode: 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'm', localEndpoint: 'http://127.0.0.1:11434', cloudModel: '', voice: '', allowedRoots: [], approvedApps: [], retainDays: 30 },
    capsules: [{ id: 'cap1', name: 'Installer', description: '', scene: 'default', createdAt: iso(T0 - 86400e3 * 5), updatedAt: iso(T0 - 3600e3), items: [] }],
    notes: [
      { id: 'note1', title: 'Spec doc', body: 'The installer must be unsigned for now.\nSecond paragraph about hashes.', tags: ['spec'], updatedAt: iso(T0 - 1800e3) },
      { id: 'note2', title: 'Scratch ideas', body: 'ideas', tags: [], updatedAt: iso(T0 - 86400e3 * 3) },
    ],
    tasks: [{ id: 'task1', title: 'Sign the installer', done: false, due: '2026-10-20', createdAt: iso(T0 - 600e3) }],
    chat: [],
    activity: [{ id: 'act1', at: iso(T0 - 900e3), kind: 'capsule', summary: 'Restored "Installer": 2 opened' }],
  };
}
function prod(over = {}) {
  const p = store.emptyProductivity();
  p.capsuleMeta.cap1 = { goals: [{ id: 'g1', text: 'Ship 0.1', done: false }], references: [{ id: 'r1', kind: 'note', target: 'note1', label: 'Spec doc' }, { id: 'r2', kind: 'note', target: 'gone-note', label: 'Old' }], updatedAt: iso(T0) };
  p.checkpoints = [
    { id: 'cp1', capsuleId: 'cap1', title: 'Installer builds', note: 'Unsigned, hash recorded.', createdAt: iso(T0 - 1200e3), refs: [{ kind: 'capsule', id: 'cap1' }, { kind: 'note', id: 'note1' }, { kind: 'task', id: 'gone-task' }] },
    { id: 'cp2', title: 'Planted tomatoes', note: '', createdAt: iso(T0 - 86400e3 * 2), refs: [] },
  ];
  p.shelf = [{ id: 's1', kind: 'url', target: 'https://example.com/spec', label: 'Spec', addedAt: iso(T0 - 86400e3), pinned: true }];
  p.timeline = [{ id: 'tl1', at: iso(T0 - 7200e3), endedAt: iso(T0 - 5400e3), app: 'code.exe', title: 'main.ts' }];
  return Object.assign(p, over);
}
const noop = async () => true;
function viewStore(over = {}) {
  const s = appState();
  return {
    api: { pickPath: async () => null, clearChat: async () => s, saveNote: async () => s, deleteNote: async () => s, getState: async () => s, chat: async () => { throw new Error('chat must not be called'); } },
    status: 'ready', loadError: null, state: s, settings: s.settings, cloudConfigured: false,
    productivityApi: null, productivity: null, productivityError: null,
    applyProductivity: noop, refreshProductivity: async () => {}, run: async (f) => f(), mutate: noop, reload: async () => {}, toast: () => {},
    ...over,
  };
}
const connected = (p = prod(), over = {}) => viewStore({ productivityApi: { get: async () => p, apply: async () => p, forgetHistory: async () => ({ removed: { chat: 0, activity: 0 } }) }, productivity: p, ...over });
const html = (el) => renderToStaticMarkup(el);

// ---- store: portable memory ----------------------------------------------------------------------------------------
test('parsePortable refuses what it cannot read, with a reason and no ops', () => {
  const ctx = { prod: store.emptyProductivity(), capsules: [] };
  for (const [raw, re] of [[42, /Paste/], ['', /Paste/], ['{nope', /not valid JSON/], ['{"format":"other"}', /not a Desktop Companion memory export/], ['{"format":"desktop-companion-memory","version":99}', /version 99/], ['x'.repeat(store.PORTABLE_LIMITS.rawChars + 1), /larger than/]]) {
    const r = store.parsePortable(raw, ctx, NOW);
    assert.equal(r.ok, false, String(raw).slice(0, 20));
    assert.match(r.problems[0], re);
    assert.equal(r.ops.length, 0);
  }
});

test('exportPortable is bounded to checkpoints, goals/references and shelf; a same-machine round trip plans nothing new', () => {
  const p = prod();
  const state = appState();
  const exp = store.exportPortable(p, state.capsules, NOW);
  assert.equal(exp.format, 'desktop-companion-memory');
  assert.equal(exp.version, store.PORTABLE_VERSION);
  assert.deepEqual(Object.keys(exp).sort(), ['capsules', 'checkpoints', 'exportedAt', 'format', 'shelf', 'version']);
  assert.ok(!('timeline' in exp) && !('focus' in exp), 'local-only data is not exported');
  const back = store.parsePortable(JSON.stringify(exp), { prod: p, capsules: state.capsules, noteIds: ['note1'], taskIds: ['task1'] }, NOW);
  assert.equal(back.ok, true);
  assert.equal(back.ops.length, 0, JSON.stringify(back));
  assert.equal(back.exportedAt, NOW.toISOString());
});

test('parsePortable into another machine keeps original checkpoint times, clamps future ones, matches capsules by name and drops unknown references honestly', () => {
  const exp = store.exportPortable(prod(), appState().capsules, NOW);
  exp.checkpoints.push({ id: 'cpX', title: 'From the future', note: '', createdAt: iso(T0 + 86400e3), refs: [] });
  exp.capsules.push({ id: 'elsewhere', name: 'Garden', goals: [{ text: 'Water' }], references: [] });
  const ctx = { prod: store.emptyProductivity(), capsules: [{ id: 'other-id', name: 'Installer' }], noteIds: [], taskIds: ['task1'] };
  const r = store.parsePortable(JSON.stringify(exp), ctx, NOW);
  assert.equal(r.ok, true);
  const cp = r.ops.filter((o) => o.op === 'checkpoint.add');
  assert.equal(cp.length, 3);
  assert.equal(cp[0].createdAt, iso(T0 - 1200e3), 'original time kept');
  assert.equal(cp[0].capsuleId, 'other-id', 'checkpoint re-homed to the capsule matched by name');
  assert.deepEqual(cp[0].refs, [], 'refs to records not present here are dropped');
  assert.equal(cp[2].createdAt, NOW.toISOString(), 'future time clamped');
  assert.ok(r.problems.some((m) => /dated in the future/.test(m)));
  assert.ok(r.problems.some((m) => /dropped a note reference/.test(m)));
  assert.ok(r.problems.some((m) => /No capsule here matches "Garden"/.test(m)));
  const meta = r.ops.find((o) => o.op === 'capsule.setMeta');
  assert.equal(meta.capsuleId, 'other-id');
  assert.deepEqual(meta.goals.map((g) => g.text), ['Ship 0.1']);
  assert.deepEqual(meta.references.map((x) => x.target), [], 'note references whose notes are not here are skipped');
  assert.equal(r.counts.shelf, 1);
  assert.equal(r.counts.skipped >= 2, true);
});

test('planned import ops are accepted by the real ProductivityStore and the stored checkpoint keeps its original time', async () => {
  const { ps, fs } = await mkStore();
  const exp = store.exportPortable(prod(), appState().capsules, NOW);
  const r = store.parsePortable(JSON.stringify(exp), { prod: ps.snapshot(), capsules: appState().capsules, noteIds: ['note1'], taskIds: ['task1'] }, NOW);
  for (const op of r.ops) await ps.apply(op);
  const s = ps.snapshot();
  assert.equal(s.checkpoints.length, 2);
  assert.deepEqual(s.checkpoints.map((c) => c.createdAt).sort(), [iso(T0 - 86400e3 * 2), iso(T0 - 1200e3)]);
  assert.deepEqual(s.capsuleMeta.cap1.goals.map((g) => g.text), ['Ship 0.1']);
  assert.equal(s.shelf.length, 1);
  assert.ok(fs.files.has(path.join('D:\\data', 'productivity.json')), 'persisted through the atomic sidecar write');
  // Second import of the same text is a no-op.
  const again = store.parsePortable(JSON.stringify(exp), { prod: s, capsules: appState().capsules, noteIds: ['note1'], taskIds: ['task1'] }, NOW);
  assert.equal(again.ops.length, 0);
});

test('checkpoint.update can replace the evidence list without touching title, note or the original time', async () => {
  const { ps } = await mkStore();
  await ps.apply({ op: 'checkpoint.add', title: 'Built', note: 'n', createdAt: iso(T0 - 5000e3), refs: [{ kind: 'note', id: 'note1' }, { kind: 'task', id: 'gone' }] });
  const before = ps.snapshot().checkpoints[0];
  await ps.apply({ op: 'checkpoint.update', id: before.id, refs: [{ kind: 'note', id: 'note1' }] });
  const after = ps.snapshot().checkpoints[0];
  assert.deepEqual(after.refs, [{ kind: 'note', id: 'note1' }]);
  assert.equal(after.createdAt, iso(T0 - 5000e3));
  assert.equal(after.title, 'Built');
  assert.equal(after.note, 'n');
  await assert.rejects(ps.apply({ op: 'checkpoint.update', id: before.id, refs: [{ kind: 'bogus', id: 'x' }] }), /reference kind is invalid/);
  await assert.rejects(ps.apply({ op: 'checkpoint.update', id: before.id, refs: 'nope' }), /refs must be a list/);
});

// ---- search: evidence and recap filtering --------------------------------------------------------------------------
test('resolveEvidence reports deleted records instead of inventing them', () => {
  const state = appState();
  const p = prod();
  assert.equal(search.resolveEvidence({ kind: 'note', id: 'note1' }, state, p).status, 'ok');
  assert.equal(search.resolveEvidence({ kind: 'note', id: 'note1' }, state, p).title, 'Spec doc');
  const gone = search.resolveEvidence({ kind: 'task', id: 'gone-task' }, state, p);
  assert.equal(gone.status, 'missing');
  assert.equal(gone.title, 'Deleted task');
  assert.equal(gone.linkable, true);
  assert.equal(search.resolveEvidence({ kind: 'checkpoint', id: 'cp1' }, state, p).status, 'ok');
  assert.equal(search.resolveEvidence({ kind: 'session', id: 'nope' }, state, null).status, 'missing');
  assert.equal(search.resolveEvidence({ kind: 'focus', id: 'nope' }, state, p).linkable, false);
});

test('filterRecap narrows by evidence kind and words; draftWorklogVerified flags lines whose source is gone', () => {
  const state = appState();
  const p = prod();
  const recap = search.buildDailyRecap(state, p, '2026-10-15');
  assert.ok(!recap.empty);
  const onlyCp = search.filterRecap(recap, { kinds: ['checkpoint'] });
  assert.ok(onlyCp.lines.every((l) => l.source.kind === 'checkpoint'));
  const words = search.filterRecap(recap, { query: 'installer builds' });
  assert.equal(words.lines.length, 1);
  assert.equal(search.filterRecap(recap, { query: 'zzz' }).empty, true);
  const stateWithoutNote = { ...state, notes: [] };
  const d = search.draftWorklogVerified(recap, stateWithoutNote, p, { withSources: true });
  assert.match(d.text, /^DRAFT/);
  assert.match(d.text, /\[note:note1, no longer available\]/);
  assert.equal(d.stale, 1);
  const plain = search.draftWorklogVerified(recap, stateWithoutNote, p);
  assert.match(plain.text, /\(source no longer available\)/);
  assert.equal(search.draftWorklogVerified({ title: 'x', lines: [], empty: true }, state, p).text.includes('No recorded activity'), true);
});

// ---- ui/workbench ---------------------------------------------------------------------------------------------------
test('workbenchStatus distinguishes loading, app error, disconnected sidecar, memory error and ready', () => {
  const base = { status: 'ready', loadError: null, productivityApi: {}, productivity: prod(), productivityError: null };
  assert.equal(wb.workbenchStatus({ ...base, status: 'loading' }).kind, 'loading');
  assert.equal(wb.workbenchStatus({ ...base, status: 'error', loadError: 'boom' }).message, 'boom');
  assert.equal(wb.workbenchStatus({ ...base, productivityApi: null }).kind, 'disconnected');
  assert.equal(wb.workbenchStatus({ ...base, productivity: null, productivityError: 'corrupt' }).kind, 'memory-error');
  assert.equal(wb.workbenchStatus({ ...base, productivity: null }).kind, 'loading');
  assert.equal(wb.workbenchStatus(base).kind, 'ready');
});

test('filterCheckpoints applies words, project, no-project and inclusive local dates, newest first', () => {
  const cps = prod().checkpoints;
  assert.deepEqual(wb.filterCheckpoints(cps, wb.EMPTY_CHECKPOINT_FILTER).map((c) => c.id), ['cp1', 'cp2']);
  assert.deepEqual(wb.filterCheckpoints(cps, { ...wb.EMPTY_CHECKPOINT_FILTER, query: 'hash' }).map((c) => c.id), ['cp1']);
  assert.deepEqual(wb.filterCheckpoints(cps, { ...wb.EMPTY_CHECKPOINT_FILTER, capsuleId: 'cap1' }).map((c) => c.id), ['cp1']);
  assert.deepEqual(wb.filterCheckpoints(cps, { ...wb.EMPTY_CHECKPOINT_FILTER, capsuleId: 'none' }).map((c) => c.id), ['cp2']);
  const day = wb.localDayKey(cps[1].createdAt);
  assert.deepEqual(wb.filterCheckpoints(cps, { ...wb.EMPTY_CHECKPOINT_FILTER, from: day, to: day }).map((c) => c.id), ['cp2']);
  assert.equal(wb.isFiltered(wb.EMPTY_CHECKPOINT_FILTER), false);
  assert.equal(wb.isFiltered({ ...wb.EMPTY_CHECKPOINT_FILTER, from: day }), true);
});

test('groupTimeline sums durations per local day; shortcuts match exact chords only', () => {
  const days = wb.groupTimeline(prod().timeline);
  assert.equal(days.length, 1);
  assert.equal(days[0].totalSec, 1800);
  assert.equal(wb.fmtDuration(1800), '30 min');
  assert.equal(wb.fmtDuration(3900), '1 h 5 min');
  const ev = (key, mods = {}) => ({ key, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(wb.matchShortcut(wb.MEMORY_SHORTCUTS, ev('n', { altKey: true })), 'new-checkpoint');
  assert.equal(wb.matchShortcut(wb.MEMORY_SHORTCUTS, ev('n', { altKey: true, ctrlKey: true })), null);
  assert.equal(wb.matchShortcut(wb.WRITING_SHORTCUTS, ev('s', { ctrlKey: true })), 'save');
  assert.equal(wb.matchShortcut(wb.WRITING_SHORTCUTS, ev(']', { altKey: true })), null);
  assert.ok(wb.UNAVAILABLE_SOURCES.some((u) => /PDF/.test(u.label)) && wb.UNAVAILABLE_SOURCES.some((u) => /Screen/.test(u.label)));
});

// ---- ui/prompt-tools -----------------------------------------------------------------------------------------------
test('buildPrompt refuses empty input and a missing language, and never fabricates a prompt', () => {
  assert.match(pt.buildPrompt('tone', { text: '   ', options: {} }, []).reason, /empty/);
  assert.match(pt.buildPrompt('diagnose', { text: '', options: {} }, []).reason, /Paste the error/);
  assert.match(pt.buildPrompt('translate', { text: 'hello', options: { language: '' } }, []).reason, /target language/);
  assert.match(pt.buildPrompt('translate', { text: 'hello', options: { language: 'x; drop table' } }, []).reason, /target language/);
  assert.match(pt.buildPrompt('explain', { text: '', options: {} }, []).reason, /Select a passage/);
  for (const r of [pt.buildPrompt('tone', { text: '', options: {} }, [])]) { assert.equal(r.ok, false); assert.equal(r.text, ''); }
});

test('buildPrompt cites the real note and source ids, carries the chosen options and is deterministic', () => {
  const state = appState();
  const { sources, missing } = pt.collectSources([{ kind: 'note', id: 'note2' }, { kind: 'task', id: 'task1' }, { kind: 'checkpoint', id: 'cp1' }, { kind: 'note', id: 'gone' }], state, prod());
  assert.deepEqual(missing, [{ kind: 'note', id: 'gone' }]);
  assert.equal(sources.length, 3);
  const a = pt.buildPrompt('translate', { text: 'Ship it today.', noteId: 'note1', noteTitle: 'Spec doc', options: { language: 'Hindi' } }, sources);
  assert.equal(a.ok, true);
  assert.match(a.text, /into Hindi/);
  assert.match(a.text, /\[note:note1\] "Spec doc"/);
  for (const tag of ['[note:note2]', '[task:task1]', '[checkpoint:cp1]']) assert.ok(a.text.includes(tag), tag);
  assert.match(a.text, /do not invent facts/);
  assert.deepEqual(a.citations, [{ kind: 'note', id: 'note1' }, { kind: 'note', id: 'note2' }, { kind: 'task', id: 'task1' }, { kind: 'checkpoint', id: 'cp1' }]);
  assert.equal(pt.buildPrompt('translate', { text: 'Ship it today.', noteId: 'note1', noteTitle: 'Spec doc', options: { language: 'Hindi' } }, sources).text, a.text);
  const tone = pt.buildPrompt('tone', { text: 'Ship it today.', options: { tone: 'formal' } }, []);
  assert.match(tone.text, /this tone: formal/);
  const ex = pt.buildPrompt('explain', { text: 'whole body', selection: 'a part', options: {} }, []);
  assert.match(ex.text, /Selected passage/);
  assert.ok(!ex.text.includes('whole body'));
  const fallback = pt.buildPrompt('explain', { text: 'whole body', options: {} }, []);
  assert.match(fallback.warnings[0], /whole note is used/);
});

test('buildPrompt enforces its character bounds and says what was cut', () => {
  const long = 'x'.repeat(pt.PROMPT_LIMITS.inputChars + 500);
  const r = pt.buildPrompt('tone', { text: long, options: { tone: 'neutral' } }, []);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, /cut at 6000 characters/);
  assert.ok(r.warnings.some((w) => /cut at its limit/.test(w)));
  const bigSources = Array.from({ length: pt.PROMPT_LIMITS.sources }, (_, i) => ({ kind: 'note', id: `n${i}`, title: `N${i}`, text: 'y'.repeat(pt.PROMPT_LIMITS.sourceChars), truncated: true }));
  const two = pt.buildPrompt('diagnose', { text: long, options: {} }, bigSources.slice(0, 2));
  assert.equal(two.ok, true, 'within promptChars');
  const over = pt.buildPrompt('diagnose', { text: long, options: {} }, [...bigSources, ...bigSources]);
  assert.equal(over.ok, false, 'full input plus four full sources exceeds promptChars');
  assert.match(over.reason, /Remove a source or shorten the draft/);
  assert.equal(over.citations.length <= pt.PROMPT_LIMITS.sources, true, 'sources capped');
  assert.equal(over.chars > pt.PROMPT_LIMITS.promptChars, true);
  const state = appState();
  state.notes[0].body = 'z'.repeat(pt.PROMPT_LIMITS.sourceChars + 10);
  const { sources } = pt.collectSources([{ kind: 'note', id: 'note1' }], state, null);
  assert.equal(sources[0].truncated, true);
});

test('reduceReply keeps the reply bounded and maps every stream outcome', () => {
  const tag = { streamId: 's', generation: 1, seq: 0 };
  let s = pt.reduceReply(pt.IDLE_REPLY, { ...tag, type: 'status', status: 'streaming' });
  assert.equal(s.status, 'streaming');
  s = pt.reduceReply(s, { ...tag, type: 'delta', text: 'a'.repeat(pt.PROMPT_LIMITS.replyChars - 1) });
  s = pt.reduceReply(s, { ...tag, type: 'delta', text: 'bbbb' });
  assert.equal(s.text.length, pt.PROMPT_LIMITS.replyChars);
  assert.equal(s.cut, true);
  const done = pt.reduceReply(s, { ...tag, type: 'done', outcome: 'truncated', reply: { id: 'r', role: 'assistant', text: 'final', createdAt: iso(T0), source: 'local' }, stored: [] });
  assert.equal(done.status, 'done');
  assert.equal(done.text, 'final');
  assert.equal(done.outcome, 'truncated');
  const failed = pt.reduceReply(pt.IDLE_REPLY, { ...tag, type: 'done', outcome: 'failed', reply: { id: 'r', role: 'assistant', text: '', createdAt: iso(T0), source: 'system' }, stored: [] });
  assert.equal(failed.status, 'error');
  const lost = pt.reduceReply(pt.IDLE_REPLY, { ...tag, type: 'lost', reason: 'main gone' });
  assert.match(lost.error, /main gone/);
  assert.equal(pt.reduceReply({ ...pt.IDLE_REPLY, status: 'stopping' }, { ...tag, type: 'delta', text: 'x' }).status, 'stopping');
});

test('createDraftSender streams only on send, forwards exactly the text, supports cancel and falls back to one-shot chat', async () => {
  const calls = { start: [], cancel: [], chat: [] };
  let handler = null;
  const api = {
    chat: async (t) => { calls.chat.push(t); return { id: 'm', role: 'assistant', text: 'one-shot', createdAt: iso(T0), source: 'cloud' }; },
    chatStreamStart: async (t) => { calls.start.push(t); return { streamId: 'st1', generation: 1, route: 'local' }; },
    onChatStream: (start, h) => { handler = h; return () => { handler = null; }; },
    chatStreamCancel: async (id) => { calls.cancel.push(id); handler?.({ streamId: id, generation: 1, seq: 9, type: 'done', outcome: 'cancelled', reply: { id: 'r', role: 'assistant', text: 'par', createdAt: iso(T0), source: 'local' }, stored: [] }); return true; },
  };
  const sender = pt.createDraftSender(api);
  assert.equal(calls.start.length, 0, 'creating the sender sends nothing');
  const states = [];
  const p = sender.send('PROMPT TEXT', (s) => states.push(s));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.start, ['PROMPT TEXT']);
  assert.equal(states.at(-1).route, 'local');
  handler({ streamId: 'st1', generation: 1, seq: 1, type: 'delta', text: 'hel' });
  assert.equal(states.at(-1).text, 'hel');
  await sender.cancel();
  await p;
  assert.deepEqual(calls.cancel, ['st1']);
  assert.equal(states.at(-1).status, 'done');
  assert.equal(states.at(-1).outcome, 'cancelled');
  assert.equal(handler, null, 'unsubscribed after the final event');
  assert.equal(calls.chat.length, 0, 'streaming path never used the one-shot call');
  // Fallback when the bridge has no streaming.
  const single = pt.createDraftSender({ chat: api.chat });
  assert.equal(single.canCancel, false);
  const got = [];
  await single.send('ONE', (s) => got.push(s));
  assert.deepEqual(calls.chat, ['ONE']);
  assert.equal(got.at(-1).status, 'done');
  assert.equal(got.at(-1).route, 'cloud');
  assert.equal(got.at(-1).transport, 'single');
  // Errors surface instead of inventing a reply.
  const bad = pt.createDraftSender({ chat: async () => { throw new Error('model offline'); } });
  const err = [];
  await bad.send('X', (s) => err.push(s));
  assert.equal(err.at(-1).status, 'error');
  assert.match(err.at(-1).error, /model offline/);
  assert.equal(err.at(-1).text, '');
});

test('describeRoute tells the truth about where a Send would go (SEC-05)', () => {
  assert.equal(pt.describeRoute({ mode: 'offline' }, true).route, 'local');
  assert.match(pt.describeRoute({ mode: 'offline' }, null).text, /nothing leaves the computer/);
  assert.equal(pt.describeRoute({ mode: 'online' }, true).route, 'cloud');
  assert.match(pt.describeRoute({ mode: 'online' }, true).text, /leaves the computer/);
  const refused = pt.describeRoute({ mode: 'online' }, false);
  assert.equal(refused.route, 'refused');
  assert.match(refused.text, /will refuse this prompt and nothing is sent/);
  assert.ok(!/local model answers/.test(refused.text), 'no claim that the local model answers in online mode');
  const unknown = pt.describeRoute({ mode: 'online' }, null);
  assert.equal(unknown.route, 'unknown');
  assert.match(unknown.text, /may go to the cloud provider/);
  assert.ok(!/nothing leaves/.test(unknown.text));
  assert.match(pt.describeRoute(null, null).text, /nothing leaves the computer/);
});

test('portable.ts is Node-free so the renderer can bundle it; store.ts re-exports it', async () => {
  const src = await readFile(path.join(root, 'electron/services/portable.ts'), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(src), 'no node: imports');
  assert.ok(!/from\s+['"]\.\/(paths|policy|validation|sidecar)['"]/.test(src), 'no Node-backed service imports');
  for (const m of src.matchAll(/^import\s+(type\s+)?\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/gm)) assert.equal(m[1]?.trim(), 'type', `only type imports allowed, saw: ${m[0]}`);
  assert.equal(store.PRODUCTIVITY_LIMITS, portable.PRODUCTIVITY_LIMITS);
  assert.equal(store.parsePortable, portable.parsePortable);
  assert.equal(store.exportPortable, portable.exportPortable);
  const mw = await readFile(path.join(root, 'src/components/MemoryWorkbench.tsx'), 'utf8');
  for (const line of mw.split('\n').filter((l) => /electron\/services\/store'/.test(l))) assert.match(line, /^import type /, `renderer value import from store.ts: ${line}`);
});

test('parsePortable pre-validates reference and shelf targets individually with the store rules (SEC-06)', async () => {
  const exp = store.exportPortable(prod(), appState().capsules, NOW);
  exp.capsules[0].references.push(
    { id: 'bad1', kind: 'url', target: 'javascript:alert(1)', label: 'js' },
    { id: 'bad2', kind: 'file', target: '\\\\server\\share\\x.txt', label: 'unc' },
    { id: 'bad3', kind: 'folder', target: 'C:\\Users\\..\\Windows', label: 'dotdot' },
    { id: 'bad4', kind: 'url', target: 'https://user:pw@example.com/', label: 'creds' },
    { id: 'ok1', kind: 'url', target: 'https://example.com/ok', label: 'ok' },
    { id: 'ok2', kind: 'file', target: 'C:\\Docs\\plan.md', label: 'ok' },
  );
  exp.shelf.push({ kind: 'file', target: 'relative\\path.txt', label: 'rel', pinned: false }, { kind: 'url', target: 'ftp://example.com/x', label: 'ftp', pinned: false });
  const { ps } = await mkStore();
  const r = store.parsePortable(JSON.stringify(exp), { prod: ps.snapshot(), capsules: appState().capsules, noteIds: ['note1'], taskIds: ['task1'] }, NOW);
  assert.equal(r.ok, true);
  const meta = r.ops.find((o) => o.op === 'capsule.setMeta');
  assert.deepEqual(meta.references.map((x) => x.target).sort(), ['C:\\Docs\\plan.md', 'https://example.com/ok', 'note1'].sort());
  assert.equal(r.counts.references, 3, 'two added safe targets and the exported note reference');
  for (const re of [/javascript/, /Network/, /"\.\."/, /credentials/, /absolute/, /ftp/]) assert.ok(r.problems.some((p) => re.test(p)), String(re));
  assert.equal(r.ops.filter((o) => o.op === 'shelf.add').length, 1, 'only the valid existing shelf item is planned');
  // Every planned op is accepted by the real store: the preview counts match what gets stored.
  for (const op of r.ops) await ps.apply(op);
  const s = ps.snapshot();
  assert.equal(s.capsuleMeta.cap1.references.length, 3);
  assert.equal(s.shelf.length, 1);
});

test('portable URL/path validity matches real store policy including hostile mailto headers', () => {
  for (const target of ['https://example.com/x', 'https://user:pw@example.com/', 'javascript:x', 'file:///C:/a',
    'mailto:person@example.com?subject=Hello', 'mailto:person@example.com?cc=other@example.com',
    'mailto:person@example.com?attach=C:/secret.txt', 'mailto:', 'mailto:invalid', 'mailto:x%ZZ@example.com',
    'mailto:person@example.com?subject=a&SUBJECT=b', 'mailto:person@example.com?cc=invalid',
    `mailto:person@example.com?body=${'a'.repeat(1001)}`]) {
    assert.equal(portable.checkTarget('url', target) === null, mod.validateOpenUrl(target).ok, target);
  }
  for (const target of ['C:\\Docs\\plan.md', 'C:/Docs/./plan.md', '\\\\host\\share\\a', 'C:relative',
    'C:\\a\\..\\b', 'C:\\a\\CON.txt', 'C:\\a\\file:stream', 'C:\\a\\trailing.']) {
    assert.equal(portable.checkTarget('file', target) === null, !('error' in mod.normalizeAbsolutePath(target)), target);
  }
});

test('portable preview keeps valid goals across duplicate capsules, skips refused fields and normalizes shelf duplicates', async () => {
  const {ps} = await mkStore();
  const exp = store.exportPortable(ps.snapshot(), appState().capsules, NOW);
  exp.capsules = [
    {id: 'cap1', name: 'Installer', goals: [{text: 'First safe goal'}, {text: 'bad\u0000goal'}], references: [{kind: 'url', target: 'mailto:p@example.com?attach=C:/secret.txt'}]},
    {id: 'cap1', name: 'Installer', goals: [{text: 'Second safe goal'}], references: [{kind: 'url', target: 'https://example.com', note: 'bad\nreference note'}]},
  ];
  exp.shelf = [{kind: 'file', target: 'C:/Docs/./plan.md', label: 'plan'}, {kind: 'file', target: 'c:\\docs\\PLAN.md', label: 'duplicate'}];
  const parsed = portable.parsePortable(JSON.stringify(exp), {prod: ps.snapshot(), capsules: appState().capsules}, NOW);
  assert.equal(parsed.counts.goals, 2);
  assert.equal(parsed.counts.references, 0);
  assert.equal(parsed.counts.shelf, 1);
  assert.equal(parsed.counts.skipped, 3);
  assert.equal(parsed.ops.filter((o) => o.op === 'capsule.setMeta').length, 1);
  for (const op of parsed.ops) await ps.apply(op);
  assert.deepEqual(ps.snapshot().capsuleMeta.cap1.goals.map((g) => g.text), ['First safe goal', 'Second safe goal']);
  assert.equal(ps.snapshot().shelf[0].target, 'C:\\Docs\\plan.md');
  const full = ps.snapshot();
  full.shelf = Array.from({length: portable.PRODUCTIVITY_LIMITS.shelf}, (_, i) => ({id: `s${i}`, kind: 'file', target: `C:\\Docs\\${i}.txt`, label: '', pinned: false, addedAt: NOW.toISOString()}));
  const blocked = portable.parsePortable(JSON.stringify(exp), {prod: full, capsules: appState().capsules}, NOW);
  assert.equal(blocked.counts.shelf, 0);
  assert.ok(blocked.problems.some((p) => /shelf holds at most/.test(p)));
});

test('renderer workbench entry bundles for browser without Node builtin shims (SEC-07)', async () => {
  await build({stdin: {contents: "export * from './src/ui/workbench.ts'; export * from './electron/services/portable.ts';", resolveDir: root, loader: 'ts'}, bundle: true, write: false, platform: 'browser', logLevel: 'silent'});
});

test('PromptTools disables Send for unknown/refused online route, enables known cloud/local route', () => {
  const sendDisabled = (markup) => {
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((b) => b.includes('Send to assistant'));
    assert.ok(button, 'send button renders');
    return /\bdisabled(?:=|\s|>)/.test(button);
  };
  for (const key of [null, false, true]) {
    globalThis.__store = connected(prod(), {settings: {...appState().settings, mode: 'online'}, cloudConfigured: key});
    assert.equal(sendDisabled(html(createElement(PromptTools, {input: {text: 'draft'}}))), key !== true);
  }
  globalThis.__store = connected(prod(), {settings: {...appState().settings, mode: 'offline'}, cloudConfigured: null});
  assert.equal(sendDisabled(html(createElement(PromptTools, {input: {text: 'draft'}}))), false);
});

// ---- screens ----------------------------------------------------------------------------------------------------------
test('MemoryWorkbench shows loading, app error, disconnected and memory-error states with recovery actions', () => {
  globalThis.__store = viewStore({ status: 'loading', state: null, settings: null });
  assert.match(html(createElement(MemoryWorkbench)), /Loading your workspace/);
  globalThis.__store = viewStore({ status: 'error', loadError: 'disk gone', state: null, settings: null });
  const err = html(createElement(MemoryWorkbench));
  assert.match(err, /disk gone/);
  assert.match(err, /Try again/);
  globalThis.__store = viewStore();
  const off = html(createElement(MemoryWorkbench));
  assert.match(off, /Local memory storage is not connected/);
  assert.match(off, /Clear chat history/, 'chat clearing is still offered');
  assert.ok(!off.includes('Checkpoints</button>'), 'no sections without a store');
  globalThis.__store = viewStore({ productivityApi: {}, productivity: null, productivityError: 'productivity.json is damaged' });
  const bad = html(createElement(MemoryWorkbench));
  assert.match(bad, /productivity.json is damaged/);
  assert.match(bad, /Reload memory/);
});

test('MemoryWorkbench overview counts real records, lists shortcuts and unavailable sources, and warns about stale references', () => {
  globalThis.__store = connected();
  const out = html(createElement(MemoryWorkbench));
  assert.match(out, /Checkpoints<\/span><span[^>]*>2</);
  assert.match(out, /1 checkpoint reference\(s\) point at deleted records/);
  assert.match(out, /Alt\+N/);
  assert.match(out, /PDF documents/);
  assert.match(out, /Screen capture or window text/);
  assert.match(out, /Installer builds/, 'today recap shows the checkpoint');
  assert.match(out, /data-motion="full"/);
  globalThis.__store = connected(prod(), { settings: { ...appState().settings, reduceMotion: true } });
  assert.match(html(createElement(MemoryWorkbench)), /data-motion="reduced"/);
});

test('MemoryWorkbench checkpoints section keeps original times, marks deleted evidence and offers two-step delete', () => {
  globalThis.__store = connected();
  const out = html(createElement(MemoryWorkbench, { initialSection: 'checkpoints' }));
  assert.match(out, new RegExp(`datetime="${iso(T0 - 1200e3)}"`, 'i'));
  assert.match(out, /Deleted task/);
  assert.match(out, /Drop missing task reference/);
  assert.match(out, /\[checkpoint:cp1\]/);
  assert.match(out, /2 checkpoints, newest first/);
  assert.match(out, />Delete</);
  assert.ok(!out.includes('Confirm delete'), 'delete needs a second click');
  globalThis.__store = connected(store.emptyProductivity());
  assert.match(html(createElement(MemoryWorkbench, { initialSection: 'checkpoints' })), /Record where you stopped/);
});

test('MemoryWorkbench projects, shelf, timeline, recap and portability sections render from the store and stay honest', () => {
  globalThis.__store = connected();
  const projects = html(createElement(MemoryWorkbench, { initialSection: 'projects' }));
  assert.match(projects, /1 reference\(s\) point at deleted notes or tasks/);
  assert.match(projects, /Ship 0.1/);
  const shelf = html(createElement(MemoryWorkbench, { initialSection: 'shelf' }));
  assert.match(shelf, /https:\/\/example.com\/spec/);
  assert.match(shelf, /Nothing is opened, copied or watched/);
  const timeline = html(createElement(MemoryWorkbench, { initialSection: 'timeline' }));
  assert.match(timeline, /Application timeline is off/);
  assert.match(timeline, /code.exe/);
  const recap = html(createElement(MemoryWorkbench, { initialSection: 'recap' }));
  assert.match(recap, /DRAFT — assembled from local records only/);
  assert.match(recap, /\[checkpoint:cp1\]/);
  assert.match(recap, /no model is involved/);
  const port = html(createElement(MemoryWorkbench, { initialSection: 'portability' }));
  assert.match(port, /Preview first, then apply/);
  assert.match(port, /Focus history, the timeline, reminders and recents stay local/);
  globalThis.__store = connected(store.emptyProductivity(), { state: { ...appState(), capsules: [] } });
  assert.match(html(createElement(MemoryWorkbench, { initialSection: 'projects' })), /No capsules yet/);
});

test('WritingWorkbench renders loading, error, empty and ready states and never calls the assistant on its own', () => {
  globalThis.__store = viewStore({ status: 'loading', state: null, settings: null });
  assert.match(html(createElement(WritingWorkbench)), /Loading your notes/);
  globalThis.__store = viewStore({ status: 'error', loadError: 'nope', state: null, settings: null });
  assert.match(html(createElement(WritingWorkbench)), /nope/);
  globalThis.__store = viewStore({ state: { ...appState(), notes: [] } });
  const empty = html(createElement(WritingWorkbench));
  assert.match(empty, /No notes yet/);
  assert.match(empty, /Scratch pad/);
  globalThis.__store = connected();
  const ready = html(createElement(WritingWorkbench, { initialNoteId: 'note1' }));
  assert.match(ready, /Spec doc/);
  assert.match(ready, /Ctrl\+S/);
  assert.match(ready, /Word documents \(.docx\)/);
  assert.match(ready, /Send to assistant/);
  assert.match(ready, /Nothing sent yet/);
  assert.match(ready, /Offline mode: the local model answers/);
});

test('Document import: not connected without the bridge, plain-text preview with editable title, unsupported reason verbatim, nothing stored before Save', async () => {
  assert.equal(localDocumentsBridge({ chat: async () => {} }), null);
  const calls = { choose: 0, save: [], discard: [] };
  const ready = { status: 'ready', token: 'tok1', name: 'notes.md', format: 'markdown', bytes: 120, chars: 110, lines: 3, text: '# Heading\n<script>alert(1)</script>\n**bold**', suggestedTitle: 'notes' };
  const api = {
    documentsChoose: async () => { calls.choose++; return ready; },
    documentsSave: async (token, options) => { calls.save.push([token, options]); return { saved: true, title: options?.title ?? 'notes' }; },
    documentsDiscard: async (token) => { calls.discard.push(token); return true; },
  };
  const docs = localDocumentsBridge(api);
  assert.ok(docs);
  globalThis.__store = connected();
  const off = html(createElement(WritingWorkbench));
  assert.match(off, /Document import is not connected/);
  assert.ok(!off.includes('Choose file'), 'no chooser without the bridge');
  globalThis.__store = connected(prod(), { api: { ...connected().api, ...api } });
  const on = html(createElement(WritingWorkbench));
  assert.match(on, /Choose file/);
  assert.equal(calls.choose, 0, 'rendering never opens the dialog');
  const previewed = html(createElement(DocumentImport, { docs, onSaved: () => {}, initialPreview: ready }));
  assert.match(previewed, /notes\.md/);
  assert.match(previewed, /<textarea[^>]*readonly[^>]*>/i);
  assert.ok(previewed.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'document text is escaped, never rendered as HTML');
  assert.ok(!previewed.includes('<h1>') && !previewed.includes('<strong>bold'), 'markdown is not rendered');
  assert.match(previewed, /value="notes"/, 'title prefilled from suggestedTitle');
  assert.match(previewed, /Save as note/);
  assert.match(previewed, /Discard/);
  assert.ok(!/[A-Z]:\\|\/Users\//.test(previewed), 'no path is shown');
  assert.equal(calls.save.length + calls.discard.length, 0, 'nothing stored before Save');
  const unsupported = html(createElement(DocumentImport, { docs, onSaved: () => {}, initialPreview: { status: 'unsupported', name: 'spec.pdf', format: 'pdf', reason: 'PDF files are not read by this app; export the text first.' } }));
  assert.match(unsupported, /Not supported: spec\.pdf/);
  assert.match(unsupported, /PDF files are not read by this app; export the text first\./);
  const cancelled = html(createElement(DocumentImport, { docs, onSaved: () => {}, initialPreview: { status: 'cancelled' } }));
  assert.match(cancelled, /No document chosen/);
  // The bridge forwards token and options unchanged.
  await docs.saveAsNote('tok1', { title: 'My title' });
  assert.deepEqual(calls.save, [['tok1', { title: 'My title' }]]);
  await docs.discard('tok1');
  assert.deepEqual(calls.discard, ['tok1']);
});

test('PromptTools shows the exact prompt with real citations, disables Send on an empty draft and lists only app-owned sources', () => {
  globalThis.__store = connected();
  const filled = html(createElement(PromptTools, { input: { text: 'Draft text here', noteId: 'note1', noteTitle: 'Spec doc' } }));
  assert.match(filled, /Task: Rewrite the draft below/);
  assert.match(filled, /\[note:note1\]/);
  assert.match(filled, /cites note:note1/);
  assert.match(filled, /Sign the installer — task · open/);
  assert.match(filled, /Installer builds — checkpoint/);
  assert.ok(!filled.includes('Spec doc — note'), 'the current note is not offered as its own source');
  assert.match(filled, /Nothing is sent until you do/);
  const empty = html(createElement(PromptTools, { input: { text: '' } }));
  assert.match(empty, /The draft is empty/);
  assert.match(empty, /<button[^>]*disabled[^>]*>[\s\S]*?Send to assistant/);
  globalThis.__store = connected(prod(), { settings: { ...appState().settings, mode: 'online' }, cloudConfigured: true });
  assert.match(html(createElement(PromptTools, { input: { text: 'x' } })), /leaves the computer and goes to your cloud model/);
});
