import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src/ui/context-policy.ts');
const bundle = await build({entryPoints:[entry], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {DEFAULT_CONTEXT_POLICY, CONTEXT_POLICY_PREF_KEY, normalizeContextPolicy, decideContextShare, buildContextPreview, parseAppList} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const pol = (o = {}) => normalizeContextPolicy({...DEFAULT_CONTEXT_POLICY, ...o});

test('context policy: defaults are all off with empty lists and the prefs key', () => {
  assert.deepEqual({...DEFAULT_CONTEXT_POLICY}, {screen:'off', activeApp:'off', clipboard:'off', allowedApps:[], deniedApps:[]});
  assert.equal(CONTEXT_POLICY_PREF_KEY, 'assistant.contextPolicy');
  for (const source of ['screen','activeApp','clipboard']) {
    const d = decideContextShare(DEFAULT_CONTEXT_POLICY, {source});
    assert.equal(d.allowed, false);
    assert.equal(d.requiresPrompt, false);
  }
});

test('context policy: module source has no network, storage or capture code', () => {
  const src = readFileSync(entry, 'utf8');
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket|localStorage|navigator|document|window|getDisplayMedia|clipboard\.read|require\()\b/);
  assert.doesNotMatch(src, /^import /m);
});

test('context policy: normalization coerces bad and legacy input', () => {
  for (const bad of [null, undefined, 42, 'on', [], [1, 2]]) assert.deepEqual(normalizeContextPolicy(bad), {screen:'off', activeApp:'off', clipboard:'off', allowedApps:[], deniedApps:[]});
  const n = normalizeContextPolicy({screen:' ON ', activeApp:true, clipboard:'always', allowedApps:'Code, notepad ,, ', deniedApps:[7, null, ' Bank  App ']});
  assert.equal(n.screen, 'on');
  assert.equal(n.activeApp, 'ask', 'legacy true needs a prompt, never silent sharing');
  assert.equal(n.clipboard, 'off');
  assert.deepEqual(n.allowedApps, ['Code', 'notepad']);
  assert.deepEqual(n.deniedApps, ['Bank App']);
  assert.equal(normalizeContextPolicy({screen:false}).screen, 'off');
});

test('context policy: app lists are trimmed, deduped case-insensitively, capped at 50, and deny wins', () => {
  const n = normalizeContextPolicy({allowedApps:[' Code ', 'code', 'CODE', 'Slack', 'Bank'], deniedApps:['bank', 'BANK', 'Mail']});
  assert.deepEqual(n.allowedApps, ['Code', 'Slack']);
  assert.deepEqual(n.deniedApps, ['bank', 'Mail']);
  const many = Array.from({length:80}, (_, i) => `App${i}`);
  const c = normalizeContextPolicy({allowedApps:many, deniedApps:many.map((a) => `x${a}`)});
  assert.equal(c.allowedApps.length, 50);
  assert.equal(c.deniedApps.length, 50);
  assert.equal(c.allowedApps[0], 'App0');
  assert.deepEqual(parseAppList('a, A ,b'), ['a', 'b']);
  assert.ok(normalizeContextPolicy({allowedApps:['y'.repeat(500)]}).allowedApps[0].length <= 120);
});

test('context policy: every decideContextShare branch', () => {
  assert.deepEqual(decideContextShare(pol(), {source:'screen'}), {allowed:false, requiresPrompt:false, reason:'screen context is off'});
  assert.deepEqual(decideContextShare(pol(), {source:'activeApp'}), {allowed:false, requiresPrompt:false, reason:'active app context is off'});
  assert.deepEqual(decideContextShare(pol(), {source:'clipboard'}), {allowed:false, requiresPrompt:false, reason:'clipboard context is off'});
  assert.deepEqual(decideContextShare(pol({screen:'on'}), {source:'screen'}), {allowed:true, requiresPrompt:false, reason:'screen context is on'});
  assert.deepEqual(decideContextShare(pol({clipboard:'ask'}), {source:'clipboard'}), {allowed:false, requiresPrompt:true, reason:'ask before sharing'});
  // Denied while on.
  assert.deepEqual(decideContextShare(pol({activeApp:'on', deniedApps:['Bank']}), {source:'activeApp', appName:'bank'}), {allowed:false, requiresPrompt:false, reason:'app "bank" is denied'});
  // Denied while ask: blocked, no prompt offered.
  assert.equal(decideContextShare(pol({screen:'ask', deniedApps:['Bank']}), {source:'screen', appName:'Bank'}).requiresPrompt, false);
  // Allowed list.
  const allow = pol({screen:'on', allowedApps:['Code']});
  assert.deepEqual(decideContextShare(allow, {source:'screen', appName:'Slack'}), {allowed:false, requiresPrompt:false, reason:'app "Slack" is not in the allowed list'});
  assert.deepEqual(decideContextShare(allow, {source:'screen'}), {allowed:false, requiresPrompt:false, reason:'no app name to check against the allowed list'});
  assert.equal(decideContextShare(allow, {source:'screen', appName:'code'}).allowed, true);
  // Deny wins even if the raw policy lists the app in both.
  assert.equal(decideContextShare({screen:'on', activeApp:'off', clipboard:'off', allowedApps:['Code'], deniedApps:['code']}, {source:'screen', appName:'Code'}).allowed, false);
  assert.deepEqual(decideContextShare(pol({screen:'on'}), {source:'microphone'}), {allowed:false, requiresPrompt:false, reason:'unknown context source'});
});

test('context policy: preview includes only allowed items and excludes blocked/ask sources', () => {
  const policy = pol({screen:'on', activeApp:'ask', clipboard:'on', deniedApps:['Bank']});
  const p = buildContextPreview([
    {source:'screen', appName:'Code', text:'hello world'},
    {source:'activeApp', appName:'Code', text:'title'},
    {source:'clipboard', appName:'Bank', text:'secret'},
    {source:'clipboard', text:''},
  ], policy);
  assert.deepEqual(p.included, [{source:'screen', appName:'Code', chars:11, excerpt:'hello world'}]);
  assert.deepEqual(p.excluded, [
    {source:'activeApp', appName:'Code', reason:'ask before sharing'},
    {source:'clipboard', appName:'Bank', reason:'app "Bank" is denied'},
    {source:'clipboard', reason:'empty'},
  ]);
  assert.equal(p.totalChars, 11);
  assert.equal(p.truncated, false);
  const none = buildContextPreview([{source:'screen', text:'x'}], DEFAULT_CONTEXT_POLICY);
  assert.deepEqual(none.included, []);
  assert.deepEqual(none.excluded, [{source:'screen', reason:'screen context is off'}]);
  assert.deepEqual(buildContextPreview([], policy), {included:[], excluded:[], totalChars:0, truncated:false});
});

test('context policy: preview caps excerpts at 200 and total at 8000 by default, and honors maxChars', () => {
  const policy = pol({screen:'on', clipboard:'on'});
  const p = buildContextPreview([{source:'screen', text:'a'.repeat(5000)}, {source:'clipboard', text:'b'.repeat(5000)}, {source:'clipboard', text:'c'}], policy);
  assert.equal(p.included[0].excerpt.length, 200);
  assert.equal(p.included[0].chars, 5000);
  assert.equal(p.included[1].chars, 3000);
  assert.equal(p.totalChars, 8000);
  assert.equal(p.truncated, true);
  assert.deepEqual(p.excluded, [{source:'clipboard', reason:'total context limit reached'}]);
  const small = buildContextPreview([{source:'screen', text:'abcdefghij'}], policy, {maxChars:4});
  assert.deepEqual(small.included, [{source:'screen', chars:4, excerpt:'abcd'}]);
  assert.equal(small.truncated, true);
});
