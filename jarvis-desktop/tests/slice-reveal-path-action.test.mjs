import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const {ActionService, EXECUTABLE_REASON, LINK_ESCAPE_REASON} = await load('electron/services/actions.ts');
const {validatePathActionRequest} = await load('electron/services/validation.ts');
const {diagnoseErrorText, diagnosisActionToRequest} = await load('src/ui/error-diagnosis.ts');

// In-memory Windows file system: nothing touches the real disk or desktop.
const DIRS = new Set(['c:\\work', 'c:\\work\\src', 'c:\\secret']);
const FILES = new Set(['c:\\work\\notes.txt', 'c:\\work\\tool.exe', 'c:\\work\\run.bat', 'c:\\work\\src\\app.js', 'c:\\other\\x.txt']);
const LINKS = {'c:\\work\\link': 'C:\\Secret'};
const mockFs = {
  async realpath(p) {
    const k = p.toLowerCase();
    if (LINKS[k]) return LINKS[k];
    if (DIRS.has(k) || FILES.has(k)) return p;
    throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
  },
  async stat(p) {
    const k = p.toLowerCase();
    if (DIRS.has(k)) return {isDirectory: () => true, isFile: () => false};
    if (FILES.has(k)) return {isDirectory: () => false, isFile: () => true, size: 10, mtimeMs: 1000};
    throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
  },
};

function setup({reveal = true} = {}) {
  const calls = {openPath: [], showItemInFolder: [], openExternal: [], spawnApp: []};
  const activity = [];
  const shell = {
    async openPath(p) { calls.openPath.push(p); return ''; },
    async openExternal(u) { calls.openExternal.push(u); },
    async spawnApp(e) { calls.spawnApp.push(e); },
  };
  if (reveal) shell.showItemInFolder = (p) => { calls.showItemInFolder.push(p); };
  let n = 0;
  const svc = new ActionService({
    settings: () => ({onboarded: true, mode: 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'm', localEndpoint: 'http://127.0.0.1:11434', cloudModel: 'c', voice: '', allowedRoots: ['C:\\Work'], approvedApps: [], retainDays: 90}),
    activity: async (kind, summary, details) => { activity.push({kind, summary, details}); },
    native: {listWindows: async () => []},
    shell,
    fs: mockFs,
    selfPids: () => [],
    safeLaunch: () => false,
    newId: () => `p${++n}`,
    confirm: async () => true,
  });
  return {svc, calls, activity};
}
const noShellCalls = (calls) => Object.values(calls).every((list) => list.length === 0);

test('reveal/open path: preview inside an allowed folder is allowed and requires approval, without opening anything', async () => {
  const {svc, calls} = setup();
  const open = await svc.preview({type: 'open-path', target: 'C:\\Work\\notes.txt'});
  assert.equal(open.allowed, true);
  assert.equal(open.requiresApproval, true);
  assert.equal(open.reason, undefined);
  assert.match(open.summary, /C:\\Work\\notes\.txt/);
  const reveal = await svc.preview({type: 'reveal-folder', target: 'C:\\Work\\src'});
  assert.equal(reveal.allowed, true);
  assert.equal(reveal.requiresApproval, true);
  assert.match(reveal.summary, /File Explorer/);
  assert.ok(noShellCalls(calls), 'preview must never call the shell');
});

test('reveal/open path: outside root, missing, executable, link escape and UNC/device paths are refused with reasons', async () => {
  const {svc, calls} = setup();
  const outside = await svc.preview({type: 'open-path', target: 'C:\\Other\\x.txt'});
  assert.equal(outside.allowed, false);
  assert.equal(outside.requiresApproval, true);
  assert.equal(outside.reason, 'Target is outside the allowed folders');
  const missing = await svc.preview({type: 'reveal-folder', target: 'C:\\Work\\gone'});
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, 'Target does not exist');
  for (const target of ['C:\\Work\\tool.exe', 'C:\\Work\\run.bat', 'C:\\Work\\x.cmd', 'C:\\Work\\x.ps1', 'C:\\Work\\setup.msi', 'C:\\Work\\s.scr', 'C:\\Work\\short.lnk']) {
    const exe = await svc.preview({type: 'open-path', target});
    assert.equal(exe.allowed, false, target);
    assert.equal(exe.reason, EXECUTABLE_REASON, target);
  }
  const link = await svc.preview({type: 'open-path', target: 'C:\\Work\\link'});
  assert.equal(link.allowed, false);
  assert.equal(link.reason, LINK_ESCAPE_REASON);
  const unc = await svc.preview({type: 'reveal-folder', target: '\\\\server\\share\\x.txt'});
  assert.equal(unc.allowed, false);
  assert.match(unc.reason, /Network \(UNC and WebDAV\) paths are not allowed/);
  const dev = await svc.preview({type: 'open-path', target: '\\\\?\\C:\\Work\\notes.txt'});
  assert.equal(dev.allowed, false);
  assert.match(dev.reason, /Device paths are not allowed/);
  const posix = await svc.preview({type: 'open-path', target: '/home/me/app/config.json'});
  assert.equal(posix.allowed, false);
  assert.ok(posix.reason);
  assert.ok(noShellCalls(calls));
});

test('reveal/open path: execute without approval does nothing; a refused preview never opens even when approved', async () => {
  const {svc, calls, activity} = setup();
  const p = await svc.preview({type: 'open-path', target: 'C:\\Work\\notes.txt'});
  const declined = await svc.execute(p.id, false);
  assert.equal(declined.executed, false);
  assert.ok(activity.some((a) => a.summary.startsWith('Declined:')));
  // Single use: the declined preview cannot be approved afterwards.
  await assert.rejects(() => svc.execute(p.id, true), /unknown, expired or was already used/);
  const bad = await svc.preview({type: 'open-path', target: 'C:\\Work\\tool.exe'});
  const r = await svc.execute(bad.id, true);
  assert.equal(r.executed, false);
  assert.equal(r.reason, EXECUTABLE_REASON);
  assert.ok(noShellCalls(calls));
});

test('reveal/open path: execute after approval calls the injected shell and records Activity', async () => {
  const {svc, calls, activity} = setup();
  const open = await svc.preview({type: 'open-path', target: 'C:\\Work\\notes.txt'});
  const r1 = await svc.execute(open.id, true);
  assert.equal(r1.executed, true);
  assert.deepEqual(calls.openPath, ['C:\\Work\\notes.txt']);
  const reveal = await svc.preview({type: 'reveal-folder', target: 'C:\\Work\\src'});
  const r2 = await svc.execute(reveal.id, true);
  assert.equal(r2.executed, true);
  assert.deepEqual(calls.showItemInFolder, ['C:\\Work\\src']);
  assert.equal(calls.spawnApp.length, 0);
  assert.equal(calls.openExternal.length, 0);
  assert.equal(activity.filter((a) => a.summary.startsWith('Executed:')).length, 2);

  // Without an injected showItemInFolder, reveal opens the containing folder (never the file itself).
  const fb = setup({reveal: false});
  const p = await fb.svc.preview({type: 'reveal-folder', target: 'C:\\Work\\src\\app.js'});
  assert.equal(p.allowed, true);
  const r3 = await fb.svc.execute(p.id, true);
  assert.equal(r3.executed, true);
  assert.deepEqual(fb.calls.openPath, ['C:\\Work\\src']);
});

test('reveal/open path: unknown action types and malformed path requests are still rejected', async () => {
  const {svc} = setup();
  await assert.rejects(() => svc.preview({type: 'run-shell', target: 'C:\\Work\\notes.txt'}), /Unsupported action type/);
  await assert.rejects(() => svc.preview({type: 'open-settings', target: 'settings:allowed-folders'}), /Unsupported action type/);
  await assert.rejects(() => svc.preview({type: 'open-path', target: 'C:\\Work\\notes.txt', command: 'del'}), /Unknown action field/);
  await assert.rejects(() => svc.preview({type: 'open-path'}), /target path is required/);
  await assert.rejects(() => svc.preview({type: 'reveal-folder', target: 'C:\\Work\u0000x'}), /target is invalid/);
  assert.equal(validatePathActionRequest({type: 'launch', target: 'x'}), null);
  assert.deepEqual(validatePathActionRequest({type: 'reveal-folder', target: 'C:\\Work'}), {type: 'reveal-folder', target: 'C:\\Work'});
});

test('reveal/open path: diagnosis helper maps path actions to exact ActionRequests and keeps others renderer-only', () => {
  const d = diagnoseErrorText("Error: ENOENT: no such file or directory, open 'C:\\Work\\data\\settings.json'\nError: EPERM: operation not permitted");
  const open = d.proposedActions.find((a) => a.kind === 'open-path');
  const reveal = d.proposedActions.find((a) => a.kind === 'reveal-folder');
  assert.deepEqual(diagnosisActionToRequest(open), {type: 'open-path', target: 'C:\\Work\\data\\settings.json'});
  assert.deepEqual(diagnosisActionToRequest(reveal), {type: 'reveal-folder', target: 'C:\\Work\\data'});
  const settings = d.proposedActions.find((a) => a.kind === 'open-settings');
  assert.ok(settings);
  assert.equal(diagnosisActionToRequest(settings), null);
  const copyText = d.proposedActions.find((a) => a.kind === 'copy-text');
  assert.equal(diagnosisActionToRequest(copyText), null);
  assert.equal(diagnosisActionToRequest(null), null);
  assert.equal(diagnosisActionToRequest({kind: 'open-path', target: ''}), null);
});
