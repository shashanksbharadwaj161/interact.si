// Avatar studio usability: bounded undo/redo over real pack edits, validated pose naming, keyboard
// transport and keyframe navigation, truthful import-file classification, import/export previews,
// and the rendered component. Bundles the real modules in memory. No window, storage, microphone,
// Electron or desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

async function load(rel) {
  const out = await build({ entryPoints: [path.join(root, rel)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const av = await load('src/ui/avatar-editor.ts');

const N = av.NEUTRAL_EXPRESSION;
const pack = (over = {}) => ({ version: 1, name: 'Base', geometry: { ...av.DEFAULT_GEOMETRY }, expressions: [], timelines: [], ...over });
const expr = (id, name, over = {}) => ({ id, name, expression: { ...N, ...over } });
const kf = (at, expressionId, ease = 'ease') => ({ at, expressionId, ease });
const timeline = (keyframes, extra = {}) => ({ id: 't1', name: 'T', duration: 1000, loop: false, keyframes, ...extra });

/* ------------------------------ undo and redo over real edits ------------------------------ */

test('undo and redo walk back and forward through real pack edits, and a new edit drops the redo stack', () => {
  let h = av.EMPTY_HISTORY;
  let p = pack();
  const commit = (label, next) => {
    h = av.pushHistory(h, { label, pack: p });
    p = next;
  };
  commit('save pose "Wink"', { ...p, expressions: av.upsertExpression(p.expressions, expr('ex-1', 'Wink', { eyeOpen: 0.3 })).list });
  commit('rename to "Robo"', { ...p, name: 'Robo' });
  const m = av.mergeAvatarPacks(p, pack({ expressions: [expr('ex-9', 'Grin', { mouthCurve: 1 })], timelines: [timeline([kf(0, 'ex-9')], { id: 'tl-9' })] }));
  commit('merge', m.pack);
  assert.equal(p.expressions.length, 2);
  assert.equal(p.timelines.length, 1);
  assert.deepEqual([av.peekUndo(h).label, av.peekRedo(h)], ['merge', null]);

  let s = av.undoHistory(h, p);
  h = s.history;
  p = s.pack;
  assert.equal(s.label, 'merge');
  assert.deepEqual([p.name, p.expressions.length, p.timelines.length], ['Robo', 1, 0]);
  s = av.undoHistory(h, p);
  h = s.history;
  p = s.pack;
  assert.equal(p.name, 'Base');
  assert.equal(av.peekRedo(h).label, 'rename to "Robo"');

  s = av.redoHistory(h, p);
  h = s.history;
  p = s.pack;
  assert.equal(p.name, 'Robo');
  assert.equal(av.peekRedo(h).label, 'merge');
  assert.equal(av.peekUndo(h).label, 'rename to "Robo"');

  // A fresh edit after an undo discards what could have been redone.
  commit('delete pose "Wink"', { ...p, expressions: [] });
  assert.equal(av.peekRedo(h), null);
  assert.equal(av.redoHistory(h, p), null);
  s = av.undoHistory(h, p);
  assert.equal(s.pack.expressions[0].name, 'Wink');

  // Undo is pure: the original history object was never mutated.
  assert.equal(av.undoHistory(av.EMPTY_HISTORY, p), null);
  assert.deepEqual(av.EMPTY_HISTORY, { past: [], future: [] });
});

test('history is bounded and slider drags on one control coalesce into a single step', () => {
  let h = av.EMPTY_HISTORY;
  for (let i = 0; i < av.HISTORY_LIMIT + 7; i++) h = av.pushHistory(h, { label: `step ${i}`, pack: pack({ name: `p${i}` }) });
  assert.equal(h.past.length, av.HISTORY_LIMIT);
  assert.equal(h.past[0].label, 'step 7', 'the oldest steps fall off first');

  let c = av.EMPTY_HISTORY;
  for (let v of [50, 51, 52, 53]) c = av.pushHistory(c, { label: 'geometry headWidth', pack: pack({ geometry: { ...av.DEFAULT_GEOMETRY, headWidth: v } }), coalesce: 'geometry:headWidth' });
  assert.equal(c.past.length, 1, 'one drag is one step');
  assert.equal(c.past[0].pack.geometry.headWidth, 50, 'the step restores the value before the drag started');
  c = av.pushHistory(c, { label: 'geometry eyeSize', pack: pack(), coalesce: 'geometry:eyeSize' });
  c = av.pushHistory(c, { label: 'geometry headWidth', pack: pack(), coalesce: 'geometry:headWidth' });
  assert.equal(c.past.length, 3, 'a different control starts a new step, and returning starts another');
  // Coalescing after an undo still clears the redo stack.
  const u = av.undoHistory(c, pack());
  const again = av.pushHistory(u.history, { label: 'geometry eyeSize', pack: pack(), coalesce: 'geometry:eyeSize' });
  assert.equal(again.future.length, 0);
});

/* ------------------------------ validated pose naming ------------------------------ */

test('pose names are validated before saving: empty, long, reserved, replacing and full-pack cases', () => {
  const saved = [expr('ex-1', 'Wink'), expr('ex-2', 'Grin')];
  assert.equal(av.checkExpressionName('', saved).ok, false);
  assert.equal(av.checkExpressionName('   ', saved).ok, false);
  assert.equal(av.checkExpressionName(42, saved).ok, false);
  const long = av.checkExpressionName('x'.repeat(av.AVATAR_LIMITS.nameLength + 1), saved);
  assert.equal(long.ok, false);
  assert.match(long.reason, new RegExp(String(av.AVATAR_LIMITS.nameLength)));
  for (const b of av.BUILT_IN_EXPRESSIONS) {
    const r = av.checkExpressionName(b.name.toUpperCase(), saved);
    assert.equal(r.ok, false, b.name);
    assert.match(r.reason, /built-in/);
  }
  const fresh = av.checkExpressionName('  Smirk\u0007 ', saved);
  assert.deepEqual([fresh.ok, fresh.name, fresh.replaces, fresh.note], [true, 'Smirk', null, null]);
  const rep = av.checkExpressionName('wink', saved);
  assert.equal(rep.ok, true);
  assert.equal(rep.replaces.id, 'ex-1');
  assert.match(rep.note, /replace your pose "Wink"/);
  const full = Array.from({ length: av.AVATAR_LIMITS.expressions }, (_, i) => expr(`ex-${i}`, `Pose ${i}`));
  const noSlot = av.checkExpressionName('Another', full);
  assert.equal(noSlot.ok, false);
  assert.match(noSlot.reason, /slots/);
  assert.equal(av.checkExpressionName('Pose 3', full).ok, true, 'replacing still works when the pack is full');
});

/* ------------------------------ keyboard transport and keyframe navigation ------------------------------ */

test('key presses map to studio actions only away from text fields and buttons', () => {
  const k = (key, o = {}) => av.studioKeyAction({ key, ...o });
  assert.equal(k(' '), 'play');
  assert.equal(k('Home'), 'home');
  assert.equal(k('End'), 'end');
  assert.equal(k('['), 'prevKey');
  assert.equal(k(']'), 'nextKey');
  assert.equal(k(','), 'back');
  assert.equal(k('.'), 'fwd');
  assert.equal(k('<', { shift: true }), 'backBig');
  assert.equal(k('>', { shift: true }), 'fwdBig');
  assert.equal(k('z', { ctrl: true }), 'undo');
  assert.equal(k('Z', { ctrl: true, shift: true }), 'redo');
  assert.equal(k('y', { ctrl: true }), 'redo');
  assert.equal(k('ArrowRight'), null, 'arrows are left to sliders');
  assert.equal(k('a'), null);
  assert.equal(k(' ', { alt: true }), null);
  // Typing in a field keeps every key, including the browser's own undo.
  assert.equal(k(' ', { editing: true }), null);
  assert.equal(k('z', { ctrl: true, editing: true }), null);
  // A focused button keeps Space (it activates the button) but Ctrl+Z still reaches the studio.
  assert.equal(k(' ', { interactive: true }), null);
  assert.equal(k('[', { interactive: true }), null);
  assert.equal(k('z', { ctrl: true, interactive: true }), 'undo');
  const listed = new Set(av.STUDIO_SHORTCUTS.map((s) => s.action));
  for (const a of ['play', 'home', 'prevKey', 'back', 'undo', 'redo']) assert.ok(listed.has(a), `${a} is documented in the help`);
});

test('keyframe neighbours and transport steps clamp to the timeline and land exactly on keyframes', () => {
  const tl = timeline([kf(0, 'builtin:neutral'), kf(400, 'builtin:happy'), kf(400, 'builtin:blink'), kf(1000, 'builtin:neutral')]);
  assert.deepEqual(av.keyframeNeighbors(tl, 0), { prev: null, next: 1, at: 0 });
  assert.deepEqual(av.keyframeNeighbors(tl, 400), { prev: 0, next: 3, at: 1 });
  assert.deepEqual(av.keyframeNeighbors(tl, 650), { prev: 2, next: 3, at: null });
  assert.deepEqual(av.keyframeNeighbors(tl, 1000), { prev: 2, next: null, at: 3 });
  assert.equal(av.stepTime(tl, 650, 'prevKey'), 400);
  assert.equal(av.stepTime(tl, 650, 'nextKey'), 1000);
  assert.equal(av.stepTime(tl, 0, 'prevKey'), 0, 'no earlier keyframe: stay');
  assert.equal(av.stepTime(tl, 1000, 'nextKey'), 1000, 'no later keyframe: stay');
  assert.equal(av.stepTime(tl, 5, 'back'), 0);
  assert.equal(av.stepTime(tl, 995, 'fwd'), 1000);
  assert.equal(av.stepTime(tl, 500, 'backBig'), 400);
  assert.equal(av.stepTime(tl, 950, 'fwdBig'), 1000);
  assert.equal(av.stepTime(tl, 123.4, 'home'), 0);
  assert.equal(av.stepTime(tl, 1, 'end'), 1000);
  assert.equal(av.stepTime(tl, 2222, 'play'), 1000, 'unknown moves still clamp');
  // Stepping never leaves the timeline and the sampled pose stays valid at every stop.
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t = av.stepTime(tl, t, i % 3 ? 'fwdBig' : 'back');
    assert.ok(t >= 0 && t <= tl.duration);
    const e = av.sampleTimeline(tl, [], t);
    assert.ok(Number.isFinite(e.mouthOpen) && e.eyeOpen >= 0 && e.eyeOpen <= 1);
  }
});

/* ------------------------------ truthful import-file classification ------------------------------ */

test('dropped files are named by format and only pack JSON inside the size bound is read', () => {
  const c = (name, size = 100, type = '') => av.classifyImportFile({ name, size, type });
  const cases = [
    ['face.vrm', 'VRM'],
    ['walk.vrma', 'VRM'],
    ['robot.glb', '3D model'],
    ['robot.gltf', '3D model'],
    ['scene.fbx', '3D model'],
    ['Mesh.OBJ', '3D model'],
    ['clip.bvh', 'Skeletal animation'],
    ['photo.png', 'Image'],
    ['photo.JPG', 'Image'],
    ['pose.svg', 'SVG image'],
    ['layers.psd', 'Layered design file'],
    ['bundle.zip', 'Archive'],
    ['clip.mp4', 'Video'],
    ['voice.wav', 'Audio'],
    ['hiyori.model3.json', 'Live2D'],
    ['notes.txt', 'Text document'],
    ['pack.yaml', 'Text document'],
    ['thing.xyz', 'Unknown format (.xyz)'],
    ['noext', 'Unknown format'],
  ];
  for (const [name, format] of cases) {
    const r = c(name);
    assert.equal(r.kind, 'unsupported', name);
    assert.ok(r.format.startsWith(format), `${name}: ${r.format}`);
    assert.ok(r.reason.length > 20, `${name} has a real reason`);
  }
  assert.deepEqual(c('robo.avatar.json').kind, 'pack');
  assert.equal(c('ROBO.JSON').kind, 'pack');
  assert.equal(c('blob', 100, 'application/json').kind, 'pack', 'a JSON MIME type without an extension still counts');
  const big = c('huge.json', av.AVATAR_LIMITS.packBytes + 1);
  assert.equal(big.kind, 'unsupported');
  assert.match(big.format, /too large/);
  assert.match(big.reason, /was not read/);
  assert.equal(c('edge.json', av.AVATAR_LIMITS.packBytes).kind, 'pack');
  assert.equal(c('photo.png', Number.NaN).kind, 'unsupported');
  // No label claims a conversion that does not exist.
  for (const [name] of cases) assert.doesNotMatch(c(name).reason, /will be (converted|read|imported)|imported as|is converted/i);
  assert.match(c('clip.mp4').reason, /contact sheet SVG is the only timeline export/);
});

/* ------------------------------ import and export previews ------------------------------ */

test('the import preview says what Replace and Add would each do without saving anything', () => {
  const current = pack({
    name: 'Mine',
    geometry: { ...av.DEFAULT_GEOMETRY, headWidth: av.DEFAULT_GEOMETRY.headWidth + 10, cheeks: !av.DEFAULT_GEOMETRY.cheeks },
    expressions: [expr('ex-1', 'Wink', { eyeOpen: 0.3 })],
    timelines: [timeline([kf(0, 'ex-1')], { id: 'tl-1' })],
  });
  const incoming = pack({
    name: 'Theirs',
    expressions: [expr('ex-1', 'Wink', { eyeOpen: 0.3 }), expr('ex-2', 'Grin', { mouthCurve: 1 })],
    timelines: [timeline([kf(0, 'ex-2'), kf(500, 'ex-1')], { id: 'tl-1' })],
  });
  const before = JSON.stringify([current, incoming]);
  const p = av.previewImport(current, incoming);
  assert.deepEqual(p.replace.geometryChanges, ['Head width', 'Cheeks']);
  assert.equal(p.replace.renames, true);
  assert.deepEqual([p.replace.removedExpressions, p.replace.removedTimelines, p.replace.incomingExpressions, p.replace.incomingTimelines], [1, 1, 2, 1]);
  assert.deepEqual([p.merge.addedExpressions, p.merge.addedTimelines, p.merge.skipped], [1, 1, 1], 'the identical Wink is reused, not duplicated');
  assert.deepEqual(p.merge.warnings, []);
  assert.equal(JSON.stringify([current, incoming]), before, 'preview mutates nothing');
  const same = av.previewImport(current, current);
  assert.deepEqual(same.replace.geometryChanges, []);
  assert.equal(same.replace.renames, false);
  const full = pack({ expressions: Array.from({ length: av.AVATAR_LIMITS.expressions }, (_, i) => expr(`ex-${i}`, `Pose ${i}`)) });
  const over = av.previewImport(full, pack({ expressions: [expr('new-1', 'Extra', { glow: 1 })] }));
  assert.equal(over.merge.addedExpressions, 0);
  assert.equal(over.merge.skipped, 1);
  assert.match(over.merge.warnings[0], /not added/);
});

test('export preview lists real file names and byte sizes and keeps unavailable formats honest', () => {
  const p = pack({ name: 'My Robo: v2' });
  const none = av.exportPreviews(p, N, null, null);
  const byId = Object.fromEntries(none.map((x) => [x.id, x]));
  assert.equal(byId.json.fileName, 'my-robo-v2.avatar.json');
  assert.equal(byId.json.bytes, new TextEncoder().encode(av.serializeAvatarPack(p)).length);
  assert.equal(byId['svg-pose'].fileName, 'my-robo-v2.svg');
  assert.ok(byId['svg-pose'].bytes > 200);
  assert.equal(byId['svg-sheet'].fileName, null, 'no timeline open: no sheet');
  assert.match(byId['svg-sheet'].reason, /Open a timeline/);
  assert.equal(byId.video.status, 'unavailable');
  assert.equal(byId.video.bytes, null);
  assert.match(byId.video.reason, /No encoder is bundled/);
  const tl = timeline([kf(0, 'builtin:neutral'), kf(1000, 'builtin:happy')], { name: 'Nod / twice' });
  const sheet = av.renderContactSheetSvg(p.geometry, tl, [], { frames: 8, columns: 4, cell: 120 });
  const withTl = Object.fromEntries(av.exportPreviews(p, N, tl, sheet).map((x) => [x.id, x]));
  assert.equal(withTl['svg-sheet'].fileName, 'my-robo-v2-nod-twice-sheet.svg');
  assert.equal(withTl['svg-sheet'].bytes, new TextEncoder().encode(sheet).length);
  assert.equal(av.formatKb(512), '512 B');
  assert.equal(av.formatKb(1536), '1.5 KB');
  assert.equal(av.formatKb(av.AVATAR_LIMITS.packBytes), '64 KB');
});

/* ------------------------------ the real component, rendered on the server ------------------------------ */

const studio = await (async () => {
  try {
    const out = await build({
      stdin: {
        contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { AvatarStudio } from './src/components/AvatarStudio.tsx'; export const render = (props) => renderToStaticMarkup(createElement(AvatarStudio, props));`,
        resolveDir: root,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(root + '/')});` },
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    return await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  } catch (error) {
    throw error;
  }
})();

test('component renders the history controls, export preview, drop zone and keyboard help in every mode', () => {
  for (const props of [{ reducedMotion: false, voiceLevel: null }, { reducedMotion: false, voiceLevel: 0.4 }, { reducedMotion: true }]) {
    const html = studio.render(props);
    assert.match(html, /aria-label="Edit history"/);
    assert.match(html, /title="Nothing to undo"[^>]*disabled=""|disabled=""[^>]*title="Nothing to undo"/, 'undo starts disabled');
    assert.match(html, /title="Nothing to redo"[^>]*disabled=""|disabled=""[^>]*title="Nothing to redo"/, 'redo starts disabled');
    assert.match(html, /0 steps back, 0 forward/);
    assert.match(html, /aria-label="Export preview"/);
    assert.match(html, /\.avatar\.json, [0-9.]+ (B|KB)/, 'the JSON export shows its real size');
    assert.match(html, /Open a timeline with at least one keyframe/, 'the sheet export says why it is not ready');
    assert.match(html, /No encoder is bundled/);
    assert.match(html, /Drop a pack JSON file here/);
    assert.match(html, /never read/);
    assert.match(html, /Keyboard shortcuts/);
    for (const s of ['Space', 'Home / End', '[ / ]', 'Ctrl+Z']) assert.ok(html.includes(`<kbd>${s}</kbd>`), `${s} listed`);
    assert.match(html, /multiple=""/, 'several files can be chosen and each is classified');
    assert.doesNotMatch(html, /aria-label="Keyframe navigation"/, 'no timeline is open yet');
    assert.match(html, /Built-in names are reserved/);
    assert.doesNotMatch(html, /undefined|NaN|\[object/);
    assert.doesNotMatch(html, /[–—]/);
  }
  const reduced = studio.render({ reducedMotion: true });
  assert.match(reduced, /Reduced motion is on/);
});

test('component source routes every pack change through the history and keeps the import path bounded', async () => {
  const src = await read('src/components/AvatarStudio.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import '\.\.\/styles\/parallel-avatar\.css'/);
  assert.match(code, /<div className=\{cx\('avatar-studio', className\)\} onKeyDown=\{onKeyDown\}>/, 'shortcuts are scoped to the studio, not the document');
  assert.doesNotMatch(code, /document\.addEventListener\('keydown'/, 'no global key listener');
  assert.match(code, /studioKeyAction\(\{ key: e\.key, ctrl: e\.ctrlKey \|\| e\.metaKey/);
  // Only the commit helper, the history restore, reset and the reviewed import may write the pack directly.
  const body = code.slice(code.indexOf('export function AvatarStudio'));
  const direct = (body.match(/savePack\(/g) ?? []).length;
  assert.equal(direct, 6, `savePack is called ${direct} times: commit, restore, replace, merge, reset and the helper definition itself`);
  assert.match(body, /commit\(`geometry /, 'geometry sliders are undoable');
  assert.match(body, /commit\(`save timeline/);
  assert.match(body, /commit\(`delete pose/);
  assert.match(body, /commit\(`rename to/);
  assert.match(body, /setUndo\(\{ label: 'reset', pack \}\)/);
  assert.match(body, /undoHistory\(history, pack\)/);
  assert.match(body, /redoHistory\(history, pack\)/);
  assert.match(body, /normalizeTimeline\(draftTl, step\.pack\.expressions/, 'an open timeline is re-validated after undo or redo');
  // Files: classified first, one pack read, size check before text().
  const files = body.slice(body.indexOf('const importFiles'), body.indexOf('const importFile ='));
  assert.ok(files.indexOf('classifyImportFile(') < files.indexOf('.text()'));
  assert.ok(files.indexOf('file.size > AVATAR_LIMITS.packBytes') < files.indexOf('.text()'));
  assert.equal((files.match(/\.text\(\)/g) ?? []).length, 1, 'exactly one file is read');
  assert.match(body, /onDrop=\{onDrop\} onDragOver=\{onDragOver\}/);
  // Render cleanup on unmount and reduced motion gating of transport.
  assert.match(body, /window\.cancelAnimationFrame\(rafRef\.current\);\s*const canvas = canvasRef\.current;\s*if \(canvas\) \{\s*canvas\.width = 0;/);
  assert.match(body, /if \(canPlay\) setPlaying/);
  assert.match(body, /const canPlay = !!draftTl && draftTl\.keyframes\.length > 0 && !reducedMotion/);
  assert.equal(/getUserMedia|AudioContext|MediaRecorder|desktopCapturer|ipcRenderer|window\.(api|desktop)|\bfetch\(|https?:\/\//.test(code), false);
  assert.equal(/photorealistic|lifelike|hyper-?realistic|deepfake/i.test(src), false);
});

test('the usability stylesheet honours reduced motion and transitions only cheap properties', async () => {
  const css = await read('src/styles/parallel-avatar.css');
  assert.equal(/@keyframes|animation\s*:|!important|100vh/.test(css), false);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:root\[data-motion="reduced"\]/);
  for (const sel of ['.avs-transport', '.avs-exports', '.avs-drop.over', '.avs-keys kbd', '.avs-history']) assert.ok(css.includes(sel), sel);
  for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
    if (m[1].trim() === 'none') continue;
    for (const prop of m[1].split(',').map((x) => x.trim().split(/\s+/)[0])) assert.match(prop, /^(transform|opacity|border-color|background|color)$/, prop);
  }
});
