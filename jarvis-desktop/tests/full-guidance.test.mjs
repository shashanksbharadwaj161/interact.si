// Guided setup and help: status selection from real capability/feature/settings inputs, staleness, manual-mark rules,
// strict preference validation, tour bounds, keyboard movement, callback wiring and rendered labels.
// Bundles the real TypeScript in memory. No Electron, network, microphone, model download or desktop input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Icons are inert in these tests; collect the names this component imports so the stub matches the source.
const componentSource = await readFile(path.join(root, 'src/components/GuidedSetup.tsx'), 'utf8');
const guidanceSource = await readFile(path.join(root, 'src/ui/guidance.ts'), 'utf8');
const primitivesSource = await readFile(path.join(root, 'src/ui/primitives.tsx'), 'utf8');
const iconNames = new Set();
for (const text of [componentSource, primitivesSource]) {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
      if (name) iconNames.add(name);
    }
  }
}

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'full-guidance-entry.ts',
    loader: 'ts',
    contents: `
      export * as G from './src/ui/guidance.ts';
      export { GuidedSetup, GuidedSetupView } from './src/components/GuidedSetup.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
      },
    },
  ],
  logLevel: 'silent',
});
const { G, GuidedSetup, GuidedSetupView, createElement, renderToStaticMarkup } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const CAPS_ALL = [
  { id: 'stt', name: 'Speech recognition (Windows, basic)', available: true },
  { id: 'local-llm', name: 'Local model (Ollama)', available: true, reason: 'Ollama is running and llama3.2 is installed.' },
];
const FEATURES_ALL = [
  { id: 'chat-streaming', available: true },
  { id: 'chat-cancel', available: true },
  { id: 'local-models', available: true },
];
const SETTINGS = { mode: 'offline', reduceMotion: false, localModel: 'llama3.2', cloudModel: '', allowedRoots: ['C:/Work'], approvedApps: [] };

function input(over = {}) {
  return { capabilities: CAPS_ALL, apiFeatures: FEATURES_ALL, settings: SETTINGS, cloudKeyConfigured: false, counts: { notes: 0, tasks: 0, capsules: 0 }, systemReducedMotion: false, webgl2: true, checkedAt: NOW - 1000, ...over };
}
const prefs = (over = {}) => ({ ...G.DEFAULT_GUIDANCE_PREFS, marked: {}, ...over });
const items = (inp = input(), p = prefs(), now = NOW) => G.buildGuideItems(inp, p, now);
const byId = (list, id) => list.find((i) => i.id === id);

/* ------------------------------------------------------------------ state selection ------------------------------------------------------------------ */

test('never-checked statuses leave capability topics unknown and not done', () => {
  const list = items(input({ capabilities: null, apiFeatures: null, checkedAt: null }));
  for (const id of ['dictation', 'streaming', 'local-models']) {
    assert.equal(byId(list, id).status, 'unknown', id);
    assert.equal(byId(list, id).canMarkDone, false, id);
    assert.match(byId(list, id).reason, /Not checked yet/);
  }
  assert.equal(G.statusFreshness({ checkedAt: null }, NOW), 'unchecked');
  // Local data topics still follow the saved counts.
  assert.equal(byId(list, 'notes').status, 'todo');
});

test('fresh capabilities drive dictation: available, unavailable with reason, or not reported', () => {
  assert.equal(byId(items(), 'dictation').status, 'todo');
  assert.equal(byId(items(), 'dictation').canMarkDone, true);
  const off = items(input({ capabilities: [{ id: 'stt', name: 'Speech', available: false, reason: 'Windows speech recognition is not installed' }] }));
  assert.equal(byId(off, 'dictation').status, 'unavailable');
  assert.equal(byId(off, 'dictation').reason, 'Windows speech recognition is not installed');
  assert.equal(byId(off, 'dictation').canMarkDone, false);
  const missing = items(input({ capabilities: [] }));
  assert.equal(byId(missing, 'dictation').status, 'unavailable');
  assert.match(byId(missing, 'dictation').reason, /not reported by this computer/);
});

test('stale, future-dated or failed checks are never trusted to claim availability', () => {
  const stale = items(input({ checkedAt: NOW - G.STALE_AFTER_MS - 1 }));
  for (const id of ['dictation', 'streaming', 'local-models']) assert.equal(byId(stale, id).status, 'unknown', id);
  assert.match(byId(stale, 'dictation').reason, /out of date/);
  assert.equal(G.statusFreshness({ checkedAt: NOW - G.STALE_AFTER_MS }, NOW), 'fresh');
  assert.equal(G.statusFreshness({ checkedAt: NOW + 5 * 60 * 1000 }, NOW), 'stale');
  assert.equal(G.statusFreshness({ checkedAt: Number.NaN }, NOW), 'unchecked');
  const failed = items(input({ capabilitiesError: 'IPC timed out' }));
  assert.equal(G.statusFreshness(input({ capabilitiesError: 'IPC timed out' }), NOW), 'error');
  assert.equal(byId(failed, 'local-models').status, 'unknown');
  assert.match(byId(failed, 'local-models').reason, /IPC timed out/);
});

test('streaming needs the build feature and a ready route; it never assumes a fallback', () => {
  assert.equal(byId(items(input({ apiFeatures: [] })), 'streaming').status, 'unavailable');
  assert.match(byId(items(input({ apiFeatures: [] })), 'streaming').reason, /not supported by this build/);
  const reported = items(input({ apiFeatures: [{ id: 'chat-streaming', available: false, reason: 'Preview bridge' }] }));
  assert.equal(byId(reported, 'streaming').reason, 'Preview bridge');

  const offlineDown = items(input({ capabilities: [{ id: 'local-llm', name: 'x', available: false, reason: 'Ollama did not respond' }] }));
  assert.equal(byId(offlineDown, 'streaming').status, 'blocked');
  assert.match(byId(offlineDown, 'streaming').reason, /Ollama did not respond/);
  assert.equal(byId(offlineDown, 'streaming').canMarkDone, false);

  const online = (s, key) => byId(items(input({ settings: { ...SETTINGS, mode: 'online', cloudModel: s }, cloudKeyConfigured: key })), 'streaming');
  assert.equal(online('', true).status, 'blocked');
  assert.equal(online('claude-sonnet-5-5', false).status, 'blocked');
  assert.match(online('claude-sonnet-5-5', false).reason, /sends nothing/);
  assert.equal(online('claude-sonnet-5-5', null).status, 'unknown');
  const ready = online('claude-sonnet-5-5', true);
  assert.equal(ready.status, 'todo');
  assert.deepEqual(ready.facts.find((f) => f.label === 'Route'), { label: 'Route', value: 'Cloud API (online)' });
  const noCancel = byId(items(input({ apiFeatures: [{ id: 'chat-streaming', available: true }] })), 'streaming');
  assert.equal(noCancel.facts.find((f) => f.label === 'Stop button').value, 'Not supported by this build');
  assert.equal(byId(items(input({ settings: null })), 'streaming').status, 'unknown');
});

test('local models: done only from the live check; missing Ollama is fixable, not downloaded', () => {
  assert.equal(byId(items(), 'local-models').status, 'done');
  assert.equal(byId(items(), 'local-models').reason, 'Ollama is running and llama3.2 is installed.');
  const down = byId(items(input({ capabilities: [{ id: 'local-llm', name: 'x', available: false, reason: 'Model not installed.' }] })), 'local-models');
  assert.equal(down.status, 'blocked');
  assert.match(down.reason, /Nothing is downloaded automatically/);
  const noFeature = byId(items(input({ apiFeatures: [{ id: 'local-models', available: false, reason: 'No runtime' }] })), 'local-models');
  assert.equal(noFeature.status, 'unavailable');
});

test('saved counts finish notes, tasks and capsules with bounded, pluralized evidence', () => {
  const list = items(input({ counts: { notes: 3, tasks: 1, capsules: -4 } }));
  assert.equal(byId(list, 'notes').status, 'done');
  assert.match(byId(list, 'notes').reason, /3 notes/);
  assert.match(byId(list, 'tasks').reason, /1 task saved/);
  assert.equal(byId(list, 'capsules').status, 'todo');
  assert.equal(byId(items(input({ counts: { notes: Number.NaN, tasks: 0, capsules: 0 } })), 'notes').status, 'todo');
  assert.equal(byId(items(input({ counts: null })), 'tasks').status, 'unknown');
});

test('privacy and motion facts describe real settings without exposing secrets', () => {
  const list = items(input({ cloudKeyConfigured: true, systemReducedMotion: true, webgl2: false }));
  const facts = Object.fromEntries(byId(list, 'privacy').facts.map((f) => [f.label, f.value]));
  assert.equal(facts.Mode, 'Offline: chat stays on this computer');
  assert.equal(facts['Cloud API key'], 'Saved (protected by Windows)');
  assert.equal(facts['Allowed folders'], '1');
  const motion = Object.fromEntries(byId(list, 'motion').facts.map((f) => [f.label, f.value]));
  assert.equal(motion['Animations now'], 'Reduced');
  assert.equal(motion['3D studio'], 'Still preview only (no WebGL2)');
  assert.equal(Object.fromEntries(byId(items(input({ systemReducedMotion: null })), 'motion').facts.map((f) => [f.label, f.value]))['Animations now'], 'Unknown');
});

/* ------------------------------------------------------------------ marks and summary ------------------------------------------------------------------ */

test('manual marks: done only while usable; skips are excluded from progress', () => {
  const sttOff = [{ id: 'stt', name: 'Speech', available: false }, CAPS_ALL[1]];
  const unavailable = items(input({ capabilities: sttOff }));
  const dict = byId(unavailable, 'dictation');
  const p0 = prefs();
  assert.equal(G.reduceGuidancePrefs(p0, { type: 'mark-done', item: dict }), p0, 'refused for an unavailable feature');

  // A stored "done" for a feature that is now unavailable is not counted.
  const stored = items(input({ capabilities: sttOff }), prefs({ marked: { dictation: 'done' } }));
  assert.equal(byId(stored, 'dictation').status, 'unavailable');
  assert.equal(byId(stored, 'dictation').markIgnored, true);
  assert.equal(G.summarizeGuide(stored).done, 1, 'only local-models (live check) is done');

  const p1 = G.reduceGuidancePrefs(p0, { type: 'mark-done', item: byId(items(), 'privacy') });
  assert.equal(p1.marked.privacy, 'done');
  assert.equal(byId(items(input(), p1), 'privacy').status, 'done');
  assert.equal(byId(items(input(), p1), 'privacy').canMarkDone, false);

  const p2 = G.reduceGuidancePrefs(p1, { type: 'skip', topic: 'motion' });
  const s = G.summarizeGuide(items(input(), p2));
  assert.equal(s.skipped, 1);
  assert.equal(s.applicable, 7);
  assert.equal(s.done, 2);
  assert.equal(G.progressLabel(s), '2 of 7 done · 1 skipped');
  assert.equal(s.next, 'notes');

  // Real evidence wins over a skip; clearing removes only that mark.
  const evidence = items(input({ counts: { notes: 2, tasks: 0, capsules: 0 } }), prefs({ marked: { notes: 'skipped' } }));
  assert.equal(byId(evidence, 'notes').status, 'done');
  const p3 = G.reduceGuidancePrefs(p2, { type: 'clear-mark', topic: 'motion' });
  assert.equal(p3.marked.motion, undefined);
  assert.equal(p3.marked.privacy, 'done');
  assert.equal(G.reduceGuidancePrefs(p3, { type: 'clear-mark', topic: 'motion' }), p3);
  assert.deepEqual(G.reduceGuidancePrefs(p3, { type: 'reset' }), prefs());
});

test('summary counts blocked/unknown/unavailable and picks the next useful topic', () => {
  const list = items(input({ capabilities: [{ id: 'local-llm', name: 'x', available: false }], counts: { notes: 1, tasks: 1, capsules: 1 } }), prefs({ marked: { privacy: 'done', motion: 'done' } }));
  const s = G.summarizeGuide(list);
  assert.deepEqual({ done: s.done, blocked: s.blocked, unavailable: s.unavailable, next: s.next }, { done: 5, blocked: 2, unavailable: 1, next: 'streaming' });
  assert.equal(G.progressLabel(s), '5 of 7 done · 2 need attention · 1 not available here');
  const hidden = G.visibleItems(list, true);
  assert.deepEqual(hidden.map((i) => i.id), ['dictation', 'streaming', 'local-models']);
  assert.equal(G.selectTopic(hidden, 'notes'), 'dictation');
  assert.equal(G.selectTopic([], 'notes'), null);
});

/* ------------------------------------------------------------------ preference validation ------------------------------------------------------------------ */

test('stored preferences are validated strictly; invalid parts are dropped and reported', () => {
  assert.deepEqual(G.normalizeGuidancePrefs(undefined), { prefs: prefs(), problems: [] });
  for (const bad of ['x', 5, [], true]) {
    const r = G.normalizeGuidancePrefs(bad);
    assert.deepEqual(r.prefs, prefs());
    assert.equal(r.problems.length, 1);
  }
  const r = G.normalizeGuidancePrefs({ v: 1, marked: { notes: 'done', tasks: 'maybe', bogus: 'done' }, lastTopic: 'nope', hideFinished: 'yes', extra: 1 });
  assert.deepEqual(r.prefs, { v: 1, marked: { notes: 'done' }, lastTopic: null, hideFinished: false });
  assert.equal(r.problems.length, 5);
  const proto = G.normalizeGuidancePrefs(JSON.parse('{"v":1,"marked":{"__proto__":{"polluted":true},"notes":"skipped"}}'));
  assert.deepEqual(Object.keys(proto.prefs.marked), ['notes']);
  assert.equal({}.polluted, undefined);
  assert.equal(proto.problems.length, 1);
  assert.equal(G.normalizeGuidancePrefs({ v: 2 }).problems[0], 'Unsupported preference version.');
});

test('imports are size-limited, must be valid JSON and are refused whole on any problem', () => {
  assert.equal(G.parseGuidanceImport('').ok, false);
  assert.match(G.parseGuidanceImport('x'.repeat(G.MAX_IMPORT_CHARS + 1)).error, /too long/);
  assert.match(G.parseGuidanceImport('{oops').error, /not valid JSON/);
  assert.match(G.parseGuidanceImport('null').error, /JSON object/);
  const partial = G.parseGuidanceImport(JSON.stringify({ v: 1, marked: { notes: 'done', ghost: 'done' } }));
  assert.equal(partial.ok, false);
  assert.match(partial.error, /Unknown topic “ghost”/);
  const p = prefs({ marked: { privacy: 'done', motion: 'skipped' }, lastTopic: 'streaming', hideFinished: true });
  const text = G.exportGuidancePrefs(p);
  assert.deepEqual(JSON.parse(text), { v: 1, marked: { privacy: 'done', motion: 'skipped' }, lastTopic: 'streaming', hideFinished: true });
  assert.deepEqual(G.parseGuidanceImport(text), { ok: true, prefs: p });
});

test('tour position and list keys stay in bounds', () => {
  assert.equal(G.clampStep(-3, 4), 0);
  assert.equal(G.clampStep(9, 4), 3);
  assert.equal(G.clampStep(1.7, 4), 1);
  assert.equal(G.clampStep(Number.NaN, 4), 0);
  assert.equal(G.clampStep(2, 0), 0);
  for (const id of G.GUIDE_TOPIC_IDS) assert.ok(G.tourFor(id).length >= 3, id);
  assert.equal(G.listKeyTarget('ArrowDown', 7, 8), 0);
  assert.equal(G.listKeyTarget('ArrowUp', 0, 8), 7);
  assert.equal(G.listKeyTarget('Home', 5, 8), 0);
  assert.equal(G.listKeyTarget('End', 0, 8), 7);
  assert.equal(G.listKeyTarget('Enter', 0, 8), null);
  assert.equal(G.listKeyTarget('ArrowDown', 0, 0), null);
  assert.equal(G.describeAge(NOW - 30_000, NOW), 'just now');
  assert.equal(G.describeAge(NOW - 60_000, NOW), '1 minute ago');
  assert.equal(G.describeAge(NOW - 3 * 3600_000, NOW), '3 hours ago');
  assert.equal(G.describeAge(null, NOW), 'never');
});

/* ------------------------------------------------------------------ view: callbacks and labels ------------------------------------------------------------------ */

/**
 * Expands a React element tree by calling function components, so handlers can be invoked directly. A shared primitive
 * that needs a hook (Panel uses useId) is treated as a transparent wrapper: its children and element-valued props
 * (actions, action) are expanded in its place.
 */
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!node || typeof node !== 'object' || !('type' in node)) return node === null || node === undefined || node === false || node === true ? [] : [node];
  if (typeof node.type === 'function') {
    let rendered;
    try {
      rendered = node.type(node.props);
    } catch {
      const slots = Object.entries(node.props).filter(([k, v]) => k === 'children' || (v && typeof v === 'object' && '$$typeof' in v)).map(([, v]) => v);
      return expand(slots);
    }
    return expand(rendered);
  }
  if (typeof node.type === 'symbol') return expand(node.props.children);
  return [{ type: node.type, props: node.props, children: expand(node.props.children) }];
}
function walk(nodes, fn) {
  for (const n of nodes) {
    if (typeof n === 'object') {
      fn(n);
      walk(n.children, fn);
    }
  }
}
const text = (n) => (typeof n === 'object' ? n.children.map(text).join('') : String(n));
function buttons(tree) {
  const found = [];
  walk(tree, (n) => n.type === 'button' && found.push(n));
  return found;
}
const button = (tree, label) => {
  const b = buttons(tree).find((x) => text(x).trim() === label);
  assert.ok(b, `button “${label}”`);
  return b;
};

function viewProps(over = {}) {
  const calls = { navigate: [], action: [], select: [], step: [], event: [], importText: [], import: 0, dismiss: 0 };
  const list = over.items ?? items();
  const p = {
    items: list,
    visible: list,
    summary: G.summarizeGuide(list),
    selected: 'notes',
    step: 0,
    freshness: 'fresh',
    checkedLabel: 'just now',
    statusError: null,
    checking: false,
    reducedMotion: false,
    hideFinished: false,
    storedProblems: [],
    exportText: '{}',
    importText: '',
    importMessage: null,
    onSelect: (id) => calls.select.push(id),
    onStep: (n) => calls.step.push(n),
    onEvent: (e) => calls.event.push(e),
    onNavigate: (t) => calls.navigate.push(t),
    onAction: (a) => calls.action.push(a),
    onImportText: (t) => calls.importText.push(t),
    onImport: () => calls.import++,
    onDismissStoredProblems: () => calls.dismiss++,
    ...over,
  };
  return { p, calls };
}

test('callbacks fire only from explicit control activation, with the right payloads', () => {
  const { p, calls } = viewProps();
  const tree = expand(GuidedSetupView(p));
  assert.deepEqual(calls, { navigate: [], action: [], select: [], step: [], event: [], importText: [], import: 0, dismiss: 0 }, 'rendering invokes nothing');

  button(tree, 'Open Notes').props.onClick();
  assert.deepEqual(calls.navigate, [{ view: 'notes' }]);
  button(tree, 'Re-check statuses').props.onClick();
  button(tree, 'Run full setup again').props.onClick();
  button(tree, 'Keyboard shortcuts').props.onClick();
  assert.deepEqual(calls.action, [{ type: 'recheck' }, { type: 'open-onboarding' }, { type: 'open-shortcuts' }]);

  assert.equal(button(tree, 'Previous step').props.disabled, true);
  button(tree, 'Next step').props.onClick();
  assert.deepEqual(calls.step, [1]);

  button(tree, 'Mark done').props.onClick();
  assert.equal(calls.event[0].type, 'mark-done');
  assert.equal(calls.event[0].item.id, 'notes');
  button(tree, 'Skip for now').props.onClick();
  assert.deepEqual(calls.event[1], { type: 'skip', topic: 'notes' });

  const topic = buttons(tree).find((b) => b.props['data-guide-topic'] === 'streaming');
  topic.props.onClick();
  assert.deepEqual(calls.select, ['streaming']);
  assert.equal(buttons(tree).find((b) => b.props['data-guide-topic'] === 'notes').props['aria-current'], 'true');
  assert.equal(topic.props.tabIndex, -1);
});

test('unavailable topics render a disabled Mark done with the reason; last tour step disables Next', () => {
  const list = items(input({ capabilities: [{ id: 'stt', name: 'Speech', available: false, reason: 'No speech engine' }] }));
  const { p } = viewProps({ items: list, visible: list, selected: 'dictation', step: 99 });
  const tree = expand(GuidedSetupView(p));
  assert.equal(button(tree, 'Mark done').props.disabled, true);
  assert.equal(button(tree, 'Next step').props.disabled, true);
  const reasons = [];
  walk(tree, (n) => n.props && n.props['data-guide-reason'] !== undefined && reasons.push(text(n)));
  assert.deepEqual(reasons, ['No speech engine']);
  const html = renderToStaticMarkup(GuidedSetupView(p));
  assert.match(html, /Tour step 3 of 3/);
  assert.match(html, /Not available/);
});

test('arrow keys move focus through topics and select them; other keys are ignored', () => {
  const { p, calls } = viewProps();
  const tree = expand(GuidedSetupView(p));
  let ul;
  walk(tree, (n) => n.type === 'ul' && n.props['aria-label'] === 'Guide topics' && (ul = n));
  const focused = [];
  const fakeButtons = p.visible.map((i) => ({ id: i.id, focus() { focused.push(i.id); }, scrollIntoView(opts) { this.opts = opts; } }));
  let prevented = 0;
  const key = (k, target) => ul.props.onKeyDown({ key: k, target, preventDefault: () => prevented++, currentTarget: { querySelectorAll: () => fakeButtons } });
  key('ArrowDown', fakeButtons[0]);
  key('End', fakeButtons[0]);
  key('ArrowUp', fakeButtons[0]);
  key('a', fakeButtons[0]);
  assert.deepEqual(focused, ['tasks', 'motion', 'motion']);
  assert.deepEqual(calls.select, ['tasks', 'motion', 'motion']);
  assert.equal(prevented, 3);
  assert.equal(fakeButtons[1].opts.behavior, 'smooth');
  const reduced = viewProps({ reducedMotion: true });
  let ul2;
  walk(expand(GuidedSetupView(reduced.p)), (n) => n.type === 'ul' && n.props['aria-label'] === 'Guide topics' && (ul2 = n));
  ul2.props.onKeyDown({ key: 'ArrowDown', target: fakeButtons[0], preventDefault() {}, currentTarget: { querySelectorAll: () => fakeButtons } });
  assert.equal(fakeButtons[1].opts.behavior, 'auto');
});

test('empty, stale, error and stored-problem states render meaningful labels and actions', () => {
  const allDone = items(input({ counts: { notes: 1, tasks: 1, capsules: 1 } }), prefs({ marked: { dictation: 'done', streaming: 'skipped', privacy: 'done', motion: 'done' } }));
  const empty = viewProps({ items: allDone, visible: G.visibleItems(allDone, true), hideFinished: true, selected: null });
  const tree = expand(GuidedSetupView(empty.p));
  button(tree, 'Show all topics').props.onClick();
  assert.deepEqual(empty.calls.event, [{ type: 'set-hide-finished', value: false }]);
  assert.match(renderToStaticMarkup(GuidedSetupView(empty.p)), /Nothing left to show/);

  const stale = viewProps({ freshness: 'stale', checkedLabel: '2 hours ago' });
  const staleHtml = renderToStaticMarkup(GuidedSetupView(stale.p));
  assert.match(staleHtml, /Statuses are out of date/);
  assert.match(staleHtml, /Last checked 2 hours ago/);
  button(expand(GuidedSetupView(stale.p)), 'Re-check').props.onClick();
  assert.deepEqual(stale.calls.action, [{ type: 'recheck' }]);

  const err = renderToStaticMarkup(GuidedSetupView(viewProps({ freshness: 'error', statusError: 'Bridge offline.' }).p));
  assert.match(err, /Status check failed/);
  assert.match(err, /Bridge offline\./);
  assert.match(err, /role="alert"/);

  const problems = viewProps({ storedProblems: ['Unknown topic “x”.', 'Unsupported preference version.'] });
  assert.match(renderToStaticMarkup(GuidedSetupView(problems.p)), /partly invalid/);
  button(expand(GuidedSetupView(problems.p)), 'Save cleaned copy').props.onClick();
  assert.equal(problems.calls.dismiss, 1);

  const imp = viewProps({ importText: '{"v":1}', importMessage: { tone: 'danger', text: 'Not imported: bad.' } });
  const impTree = expand(GuidedSetupView(imp.p));
  button(impTree, 'Import checklist').props.onClick();
  assert.equal(imp.calls.import, 1);
  assert.match(renderToStaticMarkup(GuidedSetupView(imp.p)), /id="guide-import-message"[^>]*role="alert"/);
  assert.equal(button(expand(GuidedSetupView(viewProps().p)), 'Import checklist').props.disabled, true);
});

test('mounted component reads validated prefs from storage and renders real statuses', () => {
  const store = new Map();
  globalThis.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }, addEventListener() {}, removeEventListener() {} };
  try {
    const render = (status, extra = {}) =>
      renderToStaticMarkup(createElement(GuidedSetup, { status, reducedMotion: true, onNavigate: () => assert.fail('navigate during render'), onAction: () => assert.fail('action during render'), now: NOW, ...extra }));

    const unchecked = render(input({ capabilities: null, apiFeatures: null, checkedAt: null }));
    assert.match(unchecked, /Guided setup/);
    assert.match(unchecked, /Statuses not checked yet/);
    assert.match(unchecked, /data-reduced-motion="true"/);
    assert.match(unchecked, /never falls back silently/);
    assert.match(unchecked, /Local model \(offline mode\)/);
    assert.match(unchecked, /0 of 8 done · 3 not checked/);

    store.set('jarvis.ui.guidance.v1', JSON.stringify({ v: 1, marked: { privacy: 'done', ghost: 'done' }, lastTopic: 'privacy' }));
    const html = render(input());
    assert.match(html, /partly invalid/);
    assert.match(html, /Unknown topic “ghost”/);
    assert.match(html, /2 of 8 done/, 'privacy (marked) and local models (live check)');
    assert.match(html, /Tour step 1 of 4/, 'opens the stored last topic (privacy has four steps)');
    assert.match(html, /Offline: chat stays on this computer/);
    assert.equal(store.get('jarvis.ui.guidance.v1').includes('ghost'), true, 'rendering does not rewrite storage');

    store.set('jarvis.ui.guidance.v1', '{not json');
    assert.match(render(input(), { initialTopic: 'dictation' }), /Push to talk/);
  } finally {
    delete globalThis.window;
  }
});

test('guidance sources never reach the bridge, network, microphone or storage directly', () => {
  for (const [name, src] of [['GuidedSetup.tsx', componentSource], ['guidance.ts', guidanceSource]]) {
    for (const banned of [/window\.jarvis/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /getUserMedia|mediaDevices/, /localStorage/, /sendBeacon/, /\buseApi\b|\buseReady\b/]) {
      assert.doesNotMatch(src, banned, `${name} must not use ${banned}`);
    }
  }
  assert.match(componentSource, /usePref<unknown>\(GUIDANCE_PREF_KEY/);
});
