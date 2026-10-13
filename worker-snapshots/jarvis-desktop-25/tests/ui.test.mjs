import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Browser globals that src/preview.ts expects.
const store = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  },
});

// Bundle the pure TypeScript modules in memory (no files are written) and import the result.
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'ui-test-entry.ts',
    loader: 'ts',
    contents: `
      export * as util from './src/ui/util.ts';
      export * as audio from './src/ui/audio.ts';
      export * as scenes from './src/ui/scenes.ts';
      export * as roadmap from './src/ui/roadmap.ts';
      export * as nav from './src/ui/nav.tsx';
      export * as preview from './src/preview.ts';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  plugins: [
    {
      // nav.tsx only needs icon identifiers; replace the icon package with inert placeholders.
      name: 'icon-stub',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({
          contents: ['House', 'ChatCircleDots', 'Robot', 'Cube', 'Note', 'CheckSquare', 'Desktop', 'Pulse', 'GearSix', 'Flask', 'Code'].map((n) => `export const ${n} = () => null;`).join(';'),
        }));
      },
    },
  ],
  logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const { util, audio, scenes, roadmap, nav, preview } = mod;

test('errMsg strips IPC wrappers, collapses whitespace and bounds length', () => {
  assert.equal(util.errMsg(new Error("Error invoking remote method 'chat': Error: model\n  not   running")), 'model not running');
  assert.equal(util.errMsg(undefined, 'fallback'), 'fallback');
  assert.ok(util.errMsg(new Error('x'.repeat(1000))).length <= 240);
});

test('endpoint helpers only accept http(s) and recognise loopback hosts', () => {
  assert.equal(util.parseHttpUrl('ftp://localhost'), null);
  assert.equal(util.parseHttpUrl('not a url'), null);
  assert.ok(util.parseHttpUrl('http://127.0.0.1:11434'));
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) assert.ok(util.isLoopbackHost(h), h);
  for (const h of ['example.com', '192.168.1.5', '127.0.0.1.evil.com']) assert.ok(!util.isLoopbackHost(h), h);
});

test('due buckets group tasks by local date, treating empty or invalid dates as undated', () => {
  const today = '2026-10-13';
  assert.equal(util.dueBucket({ due: '2026-10-12' }, today), 'overdue');
  assert.equal(util.dueBucket({ due: '2026-10-13T08:00:00Z' }, today), 'today');
  assert.equal(util.dueBucket({ due: '2026-10-14' }, today), 'upcoming');
  assert.equal(util.dueBucket({ due: '' }, today), 'none');
  assert.equal(util.dueBucket({}, today), 'none');
  assert.equal(util.dueBucket({ due: 'soon' }, today), 'none');
});

test('tags are normalised and clocks formatted', () => {
  assert.equal(util.normalizeTag('  #Big Idea '), 'big-idea');
  assert.equal(util.normalizeTag('x'.repeat(40)).length, 24);
  assert.equal(util.fmtClock(25 * 60), '25:00');
  assert.equal(util.fmtClock(-5), '00:00');
  assert.equal(util.fmtClock(61), '01:01');
});

test('encodeWav writes a valid 16-bit mono PCM header and clamped samples', () => {
  const wav = audio.encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(tag(36), 'data');
  assert.equal(v.getUint32(40, true), 12);
  assert.equal(v.getUint32(4, true), wav.length - 8);
  assert.equal(wav.length, 44 + 12);
  const s = (i) => v.getInt16(44 + i * 2, true);
  assert.deepEqual([s(0), s(1), s(2), s(3), s(4)], [0, 32767, -32768, 32767, -32768]);
  assert.ok(Math.abs(s(5) - 16383) <= 1);
});

test('peakOf finds the loudest sample so silent clips can be rejected', () => {
  assert.ok(Math.abs(audio.peakOf(new Float32Array([0, 0.2, -0.7, 0.1])) - 0.7) < 1e-6);
  assert.equal(audio.peakOf(new Float32Array(10)), 0);
});

test('scene star fields are deterministic and scene lookups are safe', () => {
  assert.equal(scenes.starShadow(10, 5), scenes.starShadow(10, 5));
  assert.notEqual(scenes.starShadow(10, 5), scenes.starShadow(10, 6));
  assert.equal(scenes.starShadow(10, 5).split('),').length, 10);
  assert.equal(scenes.sceneName('orbit'), 'Orbit');
  assert.ok(scenes.isKnownScene(scenes.DEFAULT_SCENE));
  assert.ok(!scenes.isKnownScene('made-up'));
});

test('roadmap covers all 140 scopes once, and only claims interfaces that exist', () => {
  const items = roadmap.ROADMAP.flatMap((c) => c.items);
  assert.equal(items.length, 140);
  assert.equal(new Set(items.map((i) => i.id)).size, 140);
  assert.deepEqual([...items.map((i) => i.id)].sort((a, b) => a - b), Array.from({ length: 140 }, (_, i) => i + 1));
  for (const i of items) {
    assert.ok(['ui', 'planned', 'research'].includes(i.status));
    assert.ok(['First', 'Expansion', 'Experimental'].includes(i.tier));
    if (i.status === 'ui') assert.ok(i.note, `interface-built item ${i.id} must say what it depends on`);
    if (i.tier === 'Experimental') assert.equal(i.status === 'planned', false, `experimental ${i.id} cannot be plain planned`);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  for (const unbuilt of [12, 14, 24, 33, 82, 109, 129, 137]) assert.notEqual(byId[unbuilt].status, 'ui', `${unbuilt} has no UI`);
});

test('navigation resolves hashes and falls back to Home', () => {
  assert.equal(nav.viewFromHash('#/settings'), 'settings');
  assert.equal(nav.viewFromHash('#computer'), 'computer');
  assert.equal(nav.viewFromHash('#/nope'), 'home');
  assert.equal(nav.viewFromHash(''), 'home');
  assert.equal(new Set(nav.VIEWS.map((v) => v.id)).size, nav.VIEWS.length);
});

test('preview bridge: demo CRUD works and persists; native, AI, voice and key actions are unavailable', async () => {
  assert.equal(preview.isPreviewBridge(), false);
  const api = preview.createPreviewBridge();
  assert.equal(preview.isPreviewBridge(), true);

  let state = await api.getState();
  assert.equal(state.settings.onboarded, false);
  assert.equal(state.settings.mode, 'offline');

  state = await api.saveSettings({ onboarded: true, theme: 'paper' });
  assert.equal(state.settings.theme, 'paper');

  state = await api.saveCapsule({ name: 'Demo', items: [{ kind: 'url', target: 'https://example.com/', label: 'x' }] });
  const cap = state.capsules[0];
  assert.equal(cap.name, 'Demo');
  state = await api.saveCapsule({ id: cap.id, description: 'edited' });
  assert.equal(state.capsules.length, 1);
  assert.equal(state.capsules[0].description, 'edited');
  assert.equal(state.capsules[0].items.length, 1, 'partial save keeps items');

  const outcome = await api.restoreCapsule(cap.id);
  assert.deepEqual(outcome.opened, [], 'restore must not pretend to open anything');
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].reason, /preview/i);

  state = await api.saveNote({ title: 'n', body: 'b', tags: ['t'] });
  assert.equal(state.notes.length, 1);
  state = await api.saveTask({ title: 'task', due: '2026-10-14' });
  const task = state.tasks[0];
  state = await api.saveTask({ id: task.id, done: true });
  assert.equal(state.tasks[0].done, true);
  assert.equal(state.tasks[0].title, 'task');
  state = await api.saveTask({ id: task.id, due: '' });
  assert.equal(state.tasks[0].due, '');
  state = await api.deleteTask(task.id);
  assert.equal(state.tasks.length, 0);

  // persisted to localStorage so a reload keeps demo data
  assert.match(store.get('jarvis.preview.state.v1'), /Demo/);

  const seen = [];
  const off = api.onActivity((a) => seen.push(a));
  await api.saveNote({ title: 'again' });
  off();
  await api.saveNote({ title: 'after unsubscribe' });
  assert.equal(seen.length, 1);
  assert.match(seen[0].summary, /preview/i);

  await assert.rejects(api.chat('hi'), /preview/i);
  await assert.rejects(api.setCloudKey('sk-secret-value'), /never stored/i);
  assert.deepEqual(await api.cloudKeyStatus(), { configured: false });
  const spoken = await api.speak('hello');
  assert.equal(spoken.ok, false);
  assert.ok(spoken.reason);
  const heard = await api.transcribe([1, 2, 3]);
  assert.equal(heard.text, '');
  assert.ok(heard.reason);
  assert.equal(await api.pickPath('file'), null);
  assert.deepEqual(await api.exportData(), { path: null });
  await assert.rejects(api.importData(), /unavailable/i);
  const pv = await api.previewAction({ type: 'launch', target: 'notepad.exe' });
  assert.equal(pv.allowed, false);
  await assert.rejects(api.executeAction(pv.id, true), /unavailable/i);

  const sys = await api.getSystemInfo();
  assert.ok(sys.capabilities.some((c) => c.available), 'demo storage is the only real capability');
  assert.deepEqual(sys.capabilities.filter((c) => c.available).map((c) => c.id), ['preview-storage']);

  await preview.seedPreviewDemo(api);
  state = await api.getState();
  assert.ok(state.capsules.some((c) => c.name.startsWith('[Demo]')));
  assert.ok(state.tasks.every((t) => !t.title.startsWith('[Demo]') || t.title.includes('[Demo]')));
  preview.resetPreviewData();
  state = await api.getState();
  assert.equal(state.capsules.length, 0);
  assert.equal(state.settings.onboarded, false);
});
