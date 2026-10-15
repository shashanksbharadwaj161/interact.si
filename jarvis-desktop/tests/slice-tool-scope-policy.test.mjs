import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(rel) {
  const bundle = await build({entryPoints:[path.join(root, rel)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const sp = await load('src/ui/tool-scope-policy.ts');
const {DEFAULT_SCOPE_POLICY, SCOPE_POLICY_PREF_KEY, ACTION_SCOPES, normalizeScopePolicy, policyFromRole, requiredScopeFor, evaluateActionScope, describePolicy, effectivePolicy, normalizeScopePref} = sp;
const ALL = ['windows.read', 'windows.control', 'apps.launch', 'web.open', 'input.inject'];
const pol = (p = {}) => normalizeScopePolicy({scopes: ALL, allowedRoots: [], approvedApps: [], allowedHosts: [], maxTextChars: 2000, ...p});

test('tool scope policy: deny-all defaults and pref key', () => {
  assert.equal(SCOPE_POLICY_PREF_KEY, 'computer.scopePolicy');
  assert.deepEqual({...DEFAULT_SCOPE_POLICY}, {scopes: [], allowedRoots: [], approvedApps: [], allowedHosts: [], maxTextChars: 2000});
  assert.deepEqual([...ACTION_SCOPES], ALL);
  for (const req of [{type:'list-windows'}, {type:'open-url', target:'https://example.com'}, {type:'launch', target:'notepad.exe'}]) {
    const d = evaluateActionScope(req, DEFAULT_SCOPE_POLICY);
    assert.equal(d.allowed, false);
    assert.equal(d.reasons[0], `Missing scope ${requiredScopeFor(req)}.`);
  }
  assert.ok(describePolicy(DEFAULT_SCOPE_POLICY).some((l) => /none \(every computer action is denied\)/.test(l)));
});

test('tool scope policy: normalization trims, dedupes, caps at 50 and clamps maxTextChars', () => {
  for (const bad of [null, undefined, 3, 'x', [], [1]]) assert.deepEqual(normalizeScopePolicy(bad), {...DEFAULT_SCOPE_POLICY});
  const many = Array.from({length: 80}, (_, i) => `C:\\root${i}`);
  const n = normalizeScopePolicy({scopes: [' web.open ', 'web.open', 'bogus', 7], allowedRoots: [...many, ' C:\\root0 '], approvedApps: ['  notepad.exe', 'notepad.exe', ''], allowedHosts: [' Example.COM ', 'example.com', '.Docs.Example.com', 'bad host!'], maxTextChars: 999999});
  assert.deepEqual(n.scopes, ['web.open']);
  assert.equal(n.allowedRoots.length, 50);
  assert.equal(n.allowedRoots[0], 'C:\\root0');
  assert.deepEqual(n.approvedApps, ['notepad.exe']);
  assert.deepEqual(n.allowedHosts, ['example.com', '.docs.example.com']);
  assert.equal(n.maxTextChars, 20000);
  assert.equal(normalizeScopePolicy({maxTextChars: 0}).maxTextChars, 1);
  assert.equal(normalizeScopePolicy({maxTextChars: -5}).maxTextChars, 1);
  assert.equal(normalizeScopePolicy({maxTextChars: 'abc'}).maxTextChars, 2000);
  assert.equal(normalizeScopePolicy({maxTextChars: 12.9}).maxTextChars, 12);
});

test('tool scope policy: requiredScopeFor maps every ActionRequest type', () => {
  const expected = {'list-windows':'windows.read', focus:'windows.control', 'move-window':'windows.control', launch:'apps.launch', 'open-url':'web.open', 'type-text':'input.inject', click:'input.inject'};
  for (const [type, scope] of Object.entries(expected)) assert.equal(requiredScopeFor({type}), scope, type);
  assert.equal(requiredScopeFor({type:'shell'}), '');
  assert.equal(requiredScopeFor({type:'toString'}), '');
  const d = evaluateActionScope({type:'shell'}, pol());
  assert.deepEqual(d, {allowed:false, scope:'', reasons:['Unknown action type.']});
});

test('tool scope policy: denies when the required scope is missing, allows when present', () => {
  const p = pol({scopes: ['windows.read']});
  assert.deepEqual(evaluateActionScope({type:'list-windows'}, p), {allowed:true, scope:'windows.read', reasons:[]});
  const d = evaluateActionScope({type:'focus', target:'Notepad'}, p);
  assert.equal(d.allowed, false);
  assert.deepEqual(d.reasons, ['Missing scope windows.control.']);
  assert.equal(evaluateActionScope({type:'focus', target:'Notepad'}, pol({scopes:['windows.control']})).allowed, true);
});

test('tool scope policy: launch via approvedApps or allowedRoots; denies ".." and outside roots', () => {
  const p = pol({approvedApps: ['C:\\Windows\\System32\\notepad.exe', 'code'], allowedRoots: ['C:\\Tools\\', '/opt/apps']});
  assert.equal(evaluateActionScope({type:'launch', target:'NOTEPAD.EXE'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'launch', target:'code'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'launch', target:'c:/windows/system32/notepad.exe'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'launch', target:'c:/tools/sub/app.exe'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'launch', target:'C:\\Tools'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'launch', target:'/opt/apps/bin/run'}, p).allowed, true);
  // POSIX paths stay case-sensitive.
  assert.equal(evaluateActionScope({type:'launch', target:'/OPT/apps/bin/run'}, p).allowed, false);
  const dot = evaluateActionScope({type:'launch', target:'C:\\Tools\\..\\Windows\\cmd.exe'}, p);
  assert.equal(dot.allowed, false);
  assert.deepEqual(dot.reasons, ['Launch target contains a ".." path segment.']);
  assert.equal(evaluateActionScope({type:'launch', target:'/opt/apps/../etc/x'}, p).allowed, false);
  const out = evaluateActionScope({type:'launch', target:'C:\\Toolsevil\\x.exe'}, p);
  assert.equal(out.allowed, false);
  assert.match(out.reasons[0], /not an approved app and is not under an allowed root/);
  // A path whose basename matches an approved bare name is not enough.
  assert.equal(evaluateActionScope({type:'launch', target:'D:\\evil\\code'}, p).allowed, false);
  assert.equal(evaluateActionScope({type:'launch', target:'calc.exe'}, p).allowed, false);
  assert.deepEqual(evaluateActionScope({type:'launch', target:'  '}, p).reasons, ['Launch needs an app name or path.']);
});

test('tool scope policy: open-url host allow-list, subdomains, scheme and credential rejection', () => {
  const p = pol({allowedHosts: ['example.org', '.example.com']});
  assert.equal(evaluateActionScope({type:'open-url', target:'https://example.org/a'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'open-url', target:'http://docs.example.com/'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'open-url', target:'https://a.b.example.com/'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'open-url', target:'https://example.com/'}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'open-url', target:'https://sub.example.org/'}, p).allowed, false);
  assert.equal(evaluateActionScope({type:'open-url', target:'https://evilexample.com/'}, p).allowed, false);
  assert.deepEqual(evaluateActionScope({type:'open-url', target:'https://other.net/'}, p).reasons, ['Host "other.net" is not in the allowed hosts.']);
  assert.deepEqual(evaluateActionScope({type:'open-url', target:'https://user:pw@example.org/'}, p).reasons, ['Addresses with embedded credentials are not allowed.']);
  assert.equal(evaluateActionScope({type:'open-url', target:'https://user@example.org/'}, p).allowed, false);
  assert.match(evaluateActionScope({type:'open-url', target:'file:///C:/x'}, p).reasons[0], /only http and https/);
  assert.match(evaluateActionScope({type:'open-url', target:'javascript:alert(1)'}, p).reasons[0], /only http and https/);
  assert.match(evaluateActionScope({type:'open-url', target:'not a url'}, p).reasons[0], /full http/);
});

test('tool scope policy: type-text target, length and control-character checks', () => {
  const p = pol({maxTextChars: 10});
  assert.equal(evaluateActionScope({type:'type-text', target:'hwnd:1', text:'a\tb\nc'}, p).allowed, true);
  assert.deepEqual(evaluateActionScope({type:'type-text', text:'hi'}, p).reasons, ['Type text needs a target window.']);
  assert.deepEqual(evaluateActionScope({type:'type-text', target:'hwnd:1', text:'x'.repeat(11)}, p).reasons, ['Text is 11 characters; the policy allows at most 10.']);
  assert.equal(evaluateActionScope({type:'type-text', target:'hwnd:1', text:'x'.repeat(10)}, p).allowed, true);
  for (const bad of ['a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 'a\u0085b']) {
    assert.deepEqual(evaluateActionScope({type:'type-text', target:'hwnd:1', text:bad}, p).reasons, ['Text contains control characters other than newline or tab.'], JSON.stringify(bad));
  }
  const noScope = evaluateActionScope({type:'type-text', target:'hwnd:1', text:'ok'}, pol({scopes:['web.open']}));
  assert.deepEqual(noScope.reasons, ['Missing scope input.inject.']);
});

test('tool scope policy: click and move-window need a target and finite integer coordinates', () => {
  const p = pol();
  assert.equal(evaluateActionScope({type:'click', target:'hwnd:1', x:10, y:-20}, p).allowed, true);
  assert.equal(evaluateActionScope({type:'move-window', target:'hwnd:1', x:0, y:0, width:800, height:600}, p).allowed, true);
  assert.deepEqual(evaluateActionScope({type:'click', x:1, y:1}, p).reasons, ['Click needs a target window.']);
  assert.deepEqual(evaluateActionScope({type:'move-window', x:1, y:1}, p).reasons, ['Move window needs a target window.']);
  for (const [x, y] of [[1.5, 2], [NaN, 2], [Infinity, 0], [undefined, 1], ['3', 4]]) {
    assert.deepEqual(evaluateActionScope({type:'click', target:'hwnd:1', x, y}, p).reasons, ['Coordinates x and y must be finite whole numbers.']);
    assert.equal(evaluateActionScope({type:'move-window', target:'hwnd:1', x, y}, p).allowed, false);
  }
  assert.deepEqual(evaluateActionScope({type:'move-window', target:'hwnd:1', x:0, y:0, width:0, height:600}, p).reasons, ['Width and height must be positive whole numbers.']);
});

test('tool scope policy: policyFromRole and effective pref policy', () => {
  const settings = {allowedRoots: ['C:\\Work'], approvedApps: ['notepad.exe']};
  const impl = policyFromRole('implementer', settings);
  assert.deepEqual(impl.scopes, ['read-files', 'edit-files', 'run-tests']);
  assert.deepEqual(impl.allowedRoots, ['C:\\Work']);
  assert.deepEqual(impl.approvedApps, ['notepad.exe']);
  assert.deepEqual(impl.allowedHosts, []);
  assert.equal(impl.maxTextChars, 2000);
  // Worker roles grant no computer-action scope, so every action stays denied.
  assert.equal(evaluateActionScope({type:'launch', target:'notepad.exe'}, impl).allowed, false);
  const unknown = policyFromRole('ghost', settings);
  assert.deepEqual(unknown.scopes, []);
  assert.deepEqual(policyFromRole('reviewer', null).allowedRoots, []);
  assert.equal(normalizeScopePref({roleId:'ghost'}).roleId, 'manual');
  const manual = effectivePolicy({roleId:'manual', scopes:['apps.launch'], allowedHosts:['example.com'], maxTextChars: 50}, settings);
  assert.deepEqual(manual.scopes, ['apps.launch']);
  assert.equal(evaluateActionScope({type:'launch', target:'Notepad.exe'}, manual).allowed, true);
  const role = effectivePolicy({roleId:'tester', scopes:['apps.launch']}, settings);
  assert.deepEqual(role.scopes, ['read-files', 'run-tests']);
});

test('tool scope policy: module is pure (no network, fs, process or Electron) and Computer wires the gate', () => {
  const src = readFileSync(path.join(root, 'src/ui/tool-scope-policy.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|child_process|from\s+['"](node:)?fs['"]|require\(|electron|WebSocket|\b(document|window|process)\.[a-zA-Z]/);
  assert.match(src, /from '\.\/worker-roles'/);
  const comp = readFileSync(path.join(root, 'src/components/Computer.tsx'), 'utf8');
  assert.ok(comp.includes('Action scope (renderer pre-check)'));
  assert.ok(comp.includes('This is a renderer-side pre-check. The main process still previews, requires approval and enforces its own limits.'));
  assert.ok(comp.includes('usePref<unknown>(SCOPE_POLICY_PREF_KEY'));
  assert.match(comp, /disabled=\{needsDesktop&&!desktopReady \|\| executing !== null \|\| scopeDenied\}/);
  assert.match(comp, /: within policy/);
  assert.match(comp, /const scopeDenied = scopeOn && scopeCheck !== null && !scopeCheck\.allowed;/);
  assert.match(comp, /if \(scopeOn && !evaluateActionScope\(built\.action, policy\)\.allowed\) return;/);
});
