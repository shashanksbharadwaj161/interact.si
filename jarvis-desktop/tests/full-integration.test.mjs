// Full-handoff integration (captain): the renderer graph stays browser-safe (the class of failure where a screen imports a
// Node-only main-process module passes tsc and node tests but breaks `vite build`), the workspace and guidance screens are
// lazy routes reached through navigation, and the main-process download/redirect/key-protector policies stay wired.
// Static source checks and an in-memory esbuild bundle only: no Electron, network, dialogs or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFile(path.join(root, p), 'utf8');

test('the whole renderer graph bundles for the browser with no Node built-in imports', async () => {
  const r = await build({
    entryPoints: [path.join(root, 'src/main.tsx')], bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm',
    jsx: 'automatic', logLevel: 'silent', loader: {'.css': 'empty'}, outdir: path.join(root, '.integration-check-unused'), splitting: true,
  }).catch((e) => ({errors: e.errors ?? [{text: String(e)}]}));
  const problems = (r.errors ?? []).map((e) => `${e.location?.file ?? '?'}: ${e.text}`);
  assert.deepEqual(problems, [], 'renderer must not reach node:fs/path/crypto or other main-process-only code');
  const inputs = Object.keys(r.metafile.inputs);
  for (const f of ['src/components/MemoryWorkbench.tsx', 'src/components/WritingWorkbench.tsx', 'src/components/GuidedSetup.tsx']) {
    assert.ok(inputs.includes(f), `${f} is part of the renderer graph`);
  }
  const nodeOnly = inputs.filter((f) => /^electron\/services\/(store|paths|localFile|approvedDocuments|secrets|netGuard|sidecar)\.ts$/.test(f));
  assert.deepEqual(nodeOnly, [], 'main-process file services are never bundled into the renderer');
});

test('workspace and guidance screens are lazy routes with navigation entries and real headings', async () => {
  const app = await src('src/components/App.tsx');
  const nav = await src('src/ui/nav.tsx');
  for (const [view, comp, label] of [['memory', 'MemoryWorkbench', 'Memory'], ['writing', 'WritingWorkbench', 'Writing'], ['guide', 'GuidedSetup', 'Help & setup']]) {
    assert.match(app, new RegExp(`const ${comp} = lazy\\(\\(\\) => import\\('\\./${comp}'\\)`), `${comp} is code-split`);
    assert.doesNotMatch(app, new RegExp(`^import [^;]*from '\\./${comp}';`, 'm'), `${comp} is not statically imported`);
    assert.match(app, new RegExp(`case '${view}':\\s*\\n\\s*body = <(${comp}|GuideView)`), `${view} renders its screen`);
    assert.match(nav, new RegExp(`id: '${view}', label: '${label}'`), `${view} has a navigation entry`);
  }
  // Every earlier secondary screen stays lazy too, including the original 3D and Motion studios.
  for (const comp of ['MotionStudio', 'Scene3D', 'Assistant', 'Calendar', 'Clipboard']) assert.match(app, new RegExp(`const ${comp} = lazy\\(`), comp);
});

test('main process: app-page studio exports reach a native Save dialog; other downloads, tests and redirects are refused', async () => {
  const main = await src('electron/main.ts');
  const block = main.slice(main.indexOf("ses.on('will-download'"), main.indexOf("ses.webRequest.onBeforeRequest"));
  assert.match(block, /\^\(blob\|data\):/, 'only blob:/data: downloads');
  assert.match(block, /TEST_MODE \|\| !local \|\| !wc \|\| !appUrlOk\(wc\.getURL\(\)\)\) \{ e\.preventDefault\(\); return; \}/, 'everything else is cancelled');
  assert.match(block, /setSaveDialogOptions\(/, 'the user chooses the destination');
  assert.doesNotMatch(block, /setSavePath\(/, 'never a silent save path');
  const guard = main.slice(main.indexOf("app.on('web-contents-created'"));
  assert.match(guard, /will-redirect/, 'secondary web contents cancel redirects away from the app');
  assert.match(main, /safeStorage,\r?\n\s*\}\);/, 'Electron safeStorage is passed to the backend');
});

test('approved documents keep paths in the main process: no channel takes or returns a path', async () => {
  const contracts = await src('src/shared/contracts.ts');
  const preview = contracts.slice(contracts.indexOf('export type ApprovedDocumentPreview'), contracts.indexOf('export type CapsuleWindowChoice'));
  assert.doesNotMatch(preview, /path|dir|folder/i, 'the preview type has no path-like field');
  const preload = await src('electron/preload.ts');
  assert.match(preload, /documentsChoose: \(\) => call\('documentsChoose'\)/, 'choose takes no argument from the renderer');
  const service = await src('electron/services/approvedDocuments.ts');
  assert.ok(service.indexOf('chosenLocalPath(picked') < service.indexOf('this.fs.lstat(file)'), 'path validation runs before any filesystem call');
  assert.ok(service.indexOf("throw new ValidationError('Choose a .txt or .md document')") < service.indexOf('assertRealFolders('), 'extension check runs before I/O');
});
