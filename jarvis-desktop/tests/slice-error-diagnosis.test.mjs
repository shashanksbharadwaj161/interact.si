import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/error-diagnosis.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {diagnoseErrorText, extractPaths, DIAGNOSIS_LIMITS, NO_PATTERN_TEXT} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const codes = (d) => d.matches.map((m) => m.code);
const SAFE_KINDS = new Set(['open-path','reveal-folder','copy-text','open-settings']);
function assertSafeActions(d) {
  for (const a of d.proposedActions) {
    assert.equal(a.requiresConfirmation, true, `action ${a.id} must require confirmation`);
    assert.ok(SAFE_KINDS.has(a.kind), `unexpected kind ${a.kind}`);
    assert.doesNotMatch(a.kind, /shell|exec|run|command|spawn|kill/i);
    assert.equal(typeof a.target, 'string');
    assert.ok(a.target.length > 0);
    assert.equal(typeof a.label, 'string');
  }
  assert.equal(new Set(d.proposedActions.map((a) => a.id)).size, d.proposedActions.length);
}

test('error diagnosis: Node errno codes are recognized', () => {
  const cases = {
    ENOENT: "Error: ENOENT: no such file or directory, open '/home/me/app/config.json'",
    EACCES: 'Error: EACCES: permission denied, mkdir /var/lib/thing',
    EADDRINUSE: 'Error: listen EADDRINUSE: address already in use :::3000',
    EPERM: "Error: EPERM: operation not permitted, unlink 'C:\\work\\out\\bundle.js'",
    ECONNREFUSED: 'Error: connect ECONNREFUSED 127.0.0.1:11434',
  };
  for (const [code, text] of Object.entries(cases)) {
    const d = diagnoseErrorText(text);
    assert.ok(codes(d).includes(code), `${code} in ${codes(d)}`);
    const m = d.matches.find((x) => x.code === code);
    assert.equal(m.confidence, 'high');
    assert.ok(m.title && m.explanation);
    assertSafeActions(d);
  }
  const port = diagnoseErrorText(cases.EADDRINUSE);
  assert.ok(port.proposedActions.some((a) => a.kind === 'copy-text' && a.target === '3000'));
  assert.match(port.matches[0].explanation, /port 3000/);
  const refused = diagnoseErrorText(cases.ECONNREFUSED);
  assert.ok(refused.proposedActions.some((a) => a.kind === 'copy-text' && a.target === '127.0.0.1:11434'));
  const enoent = diagnoseErrorText(cases.ENOENT);
  assert.deepEqual(enoent.paths, ['/home/me/app/config.json']);
  assert.ok(enoent.proposedActions.some((a) => a.kind === 'open-path' && a.target === '/home/me/app/config.json'));
  assert.ok(enoent.proposedActions.some((a) => a.kind === 'reveal-folder' && a.target === '/home/me/app'));
  const eperm = diagnoseErrorText(cases.EPERM);
  assert.ok(eperm.proposedActions.some((a) => a.kind === 'open-settings'));
});

test('error diagnosis: module, memory, Windows and Python families are recognized', () => {
  const mod = diagnoseErrorText("Error: Cannot find module 'left-pad'\nRequire stack:\n- /srv/app/index.js");
  assert.ok(codes(mod).includes('CANNOT_FIND_MODULE'));
  assert.ok(mod.proposedActions.some((a) => a.kind === 'copy-text' && a.target === 'left-pad'));

  const oom = diagnoseErrorText('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
  assert.deepEqual(codes(oom), ['HEAP_OUT_OF_MEMORY']);

  const hr = diagnoseErrorText('Install failed with HRESULT 0x80070005 and later 0x8BADF00D');
  assert.ok(codes(hr).includes('HRESULT_0x80070005'));
  assert.equal(hr.matches.find((m) => m.code === 'HRESULT_0x80070005').confidence, 'high');
  assert.equal(hr.matches.find((m) => m.code === 'HRESULT_0x8badf00d').confidence, 'low');

  const denied = diagnoseErrorText('System.UnauthorizedAccessException: Access is denied.');
  assert.ok(codes(denied).includes('ACCESS_DENIED'));

  const py = diagnoseErrorText('Traceback (most recent call last):\n  File "C:\\Users\\Ana Lee\\proj\\main.py", line 3, in <module>\n    import requests\nModuleNotFoundError: No module named \'requests\'');
  assert.ok(codes(py).includes('PY_TRACEBACK'));
  assert.ok(codes(py).includes('PY_MODULE_NOT_FOUND'));
  assert.equal(py.matches.find((m) => m.code === 'PY_TRACEBACK').confidence, 'medium');
  assert.deepEqual(py.locations, [{path:'C:\\Users\\Ana Lee\\proj\\main.py', line:3, column:null}]);
  assert.ok(py.proposedActions.some((a) => a.kind === 'copy-text' && a.target === 'requests'));

  const port = diagnoseErrorText('Something went wrong: port 8080 is already in use');
  assert.deepEqual(codes(port), ['PORT_IN_USE']);
  assert.ok(port.proposedActions.some((a) => a.kind === 'copy-text' && a.target === '8080'));
  for (const d of [mod, oom, hr, denied, py, port]) assertSafeActions(d);
});

test('error diagnosis: Windows stack trace paths and line:col references are extracted without following them', () => {
  const trace = [
    "Error: ENOENT: no such file or directory, open 'C:\\Program Files\\App\\data\\settings.json'",
    '    at Object.openSync (node:fs:601:3)',
    '    at readConfig (C:\\Users\\dev\\project\\src\\config.js:42:17)',
    '    at main (C:\\Users\\dev\\project\\src\\index.js:7:3)',
    '    at C:\\Users\\dev\\project\\node_modules\\lib\\run.js:10:1',
  ].join('\n');
  const d = diagnoseErrorText(trace);
  assert.deepEqual(d.paths, [
    'C:\\Users\\dev\\project\\src\\config.js',
    'C:\\Users\\dev\\project\\src\\index.js',
    'C:\\Program Files\\App\\data\\settings.json',
    'C:\\Users\\dev\\project\\node_modules\\lib\\run.js',
  ]);
  assert.deepEqual(d.locations, [
    {path:'C:\\Users\\dev\\project\\src\\config.js', line:42, column:17},
    {path:'C:\\Users\\dev\\project\\src\\index.js', line:7, column:3},
    {path:'C:\\Users\\dev\\project\\node_modules\\lib\\run.js', line:10, column:1},
  ]);
  assert.ok(!d.paths.some((p) => p.startsWith('node:')));
  const open = d.proposedActions.filter((a) => a.kind === 'open-path');
  assert.equal(open.length, DIAGNOSIS_LIMITS.pathActions);
  assert.ok(d.proposedActions.some((a) => a.kind === 'reveal-folder' && a.target === 'C:\\Users\\dev\\project\\src'));
  assertSafeActions(d);
  const posix = extractPaths('at handler (/srv/app/lib/server.js:12:5)\nsee /etc/hosts and/or http://example.com/a/b');
  assert.deepEqual(posix.paths, ['/srv/app/lib/server.js', '/etc/hosts']);
  assert.deepEqual(posix.locations, [{path:'/srv/app/lib/server.js', line:12, column:5}]);
});

test('error diagnosis: input is capped and the truncated flag is set', () => {
  const small = diagnoseErrorText('ENOENT');
  assert.equal(small.truncated, false);
  const big = diagnoseErrorText('x'.repeat(DIAGNOSIS_LIMITS.inputChars) + ' ENOENT');
  assert.equal(big.truncated, true);
  assert.deepEqual(big.matches, []);
  const early = diagnoseErrorText('EACCES ' + 'y'.repeat(30000));
  assert.equal(early.truncated, true);
  assert.ok(codes(early).includes('EACCES'));
  for (const a of early.proposedActions) assert.ok(a.target.length <= DIAGNOSIS_LIMITS.copyChars);
});

test('error diagnosis: unknown input is reported honestly with a single copy-text action', () => {
  const d = diagnoseErrorText('The widget wobbled unexpectedly near /opt/thing/file.txt');
  assert.deepEqual(d.matches, []);
  assert.equal(d.proposedActions.length, 1);
  assert.equal(d.proposedActions[0].kind, 'copy-text');
  assert.equal(d.proposedActions[0].requiresConfirmation, true);
  assert.match(d.summary, /No known pattern recognized/);
  assert.equal(d.summary, NO_PATTERN_TEXT);
  const empty = diagnoseErrorText('   ');
  assert.deepEqual(empty.matches, []);
  assert.deepEqual(empty.proposedActions, []);
  assert.equal(diagnoseErrorText(undefined).matches.length, 0);
});

test('error diagnosis: no action target is a shell command and every action needs confirmation', () => {
  const samples = [
    'Error: listen EADDRINUSE: address already in use :::3000\n    at Server.listen (/srv/app/index.js:5:9)',
    "rm -rf / && Error: Cannot find module 'evil; rm -rf ~'",
    'Access is denied. 0x80070005 at C:\\Windows\\System32\\x.dll',
    'just text',
  ];
  for (const s of samples) {
    const d = diagnoseErrorText(s);
    assertSafeActions(d);
    for (const a of d.proposedActions) {
      if (a.kind !== 'copy-text') assert.doesNotMatch(a.target, /\b(?:rm|del|kill|taskkill|npm|pip|netstat|powershell|cmd)\b/);
    }
  }
});
