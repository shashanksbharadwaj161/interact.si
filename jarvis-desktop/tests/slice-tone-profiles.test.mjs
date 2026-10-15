import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/tone-profiles.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {TONE_PROFILES, TARGET_LANGUAGES, TONE_PROFILE_PREF_KEY, normalizeToneChoice, buildTonePrompt, extractProtectedTokens, checkRewrite} = mod;

const email = TONE_PROFILES.find((p) => p.id === 'email');

test('tone profiles: every profile has rules, maxChars and is frozen', () => {
  assert.ok(TONE_PROFILES.length >= 6);
  assert.ok(Object.isFrozen(TONE_PROFILES));
  const apps = new Set(TONE_PROFILES.map((p) => p.targetApp));
  for (const app of ['email','team-chat','issue-tracker','code-comment','documentation','social-post']) assert.ok(apps.has(app), app);
  for (const p of TONE_PROFILES) {
    assert.ok(Object.isFrozen(p), p.id);
    assert.ok(p.id && p.label);
    assert.ok(Array.isArray(p.rules) && p.rules.length > 0, p.id);
    for (const r of p.rules) assert.ok(typeof r === 'string' && r.trim().length > 0);
    assert.ok(Number.isInteger(p.maxChars) && p.maxChars > 0, p.id);
    assert.equal(typeof p.keepLineBreaks, 'boolean');
  }
  assert.equal(new Set(TONE_PROFILES.map((p) => p.id)).size, TONE_PROFILES.length);
  assert.ok(TARGET_LANGUAGES.length >= 12);
  assert.ok(TARGET_LANGUAGES.some((l) => l.code === 'keep'));
  for (const l of TARGET_LANGUAGES) assert.ok(l.code === 'keep' || /^[a-z]{2}$/.test(l.code), l.code);
  assert.equal(TONE_PROFILE_PREF_KEY, 'writing.toneProfile');
});

test('tone profiles: normalizeToneChoice falls back to safe defaults', () => {
  assert.deepEqual(normalizeToneChoice(null), {profileId:'email', language:'keep'});
  assert.deepEqual(normalizeToneChoice({profileId:'nope', language:'xx'}), {profileId:'email', language:'keep'});
  assert.deepEqual(normalizeToneChoice({profileId:'team-chat', language:'hi'}), {profileId:'team-chat', language:'hi'});
  assert.deepEqual(normalizeToneChoice('garbage'), {profileId:'email', language:'keep'});
});

test("tone prompt: 'keep' language has no translate wording; a real language does", () => {
  const keep = buildTonePrompt('Please review the doc by Friday.', {profileId:'team-chat', language:'keep'});
  assert.doesNotMatch(keep.prompt, /translat/i);
  assert.equal(keep.language.code, 'keep');
  const hi = buildTonePrompt('Please review the doc by Friday.', {profileId:'team-chat', language:'hi'});
  assert.match(hi.prompt, /Translate/);
  assert.match(hi.prompt, /Hindi \(hi\)/);
});

test('tone prompt: unknown profile, unknown language, empty and oversized text throw descriptive errors', () => {
  assert.throws(() => buildTonePrompt('hello', {profileId:'fax', language:'keep'}), /Unknown tone profile "fax"/);
  assert.throws(() => buildTonePrompt('hello', {profileId:'email', language:'klingon'}), /Unknown target language "klingon"/);
  assert.throws(() => buildTonePrompt('   \n ', {profileId:'email', language:'keep'}), /empty/);
  assert.throws(() => buildTonePrompt('x'.repeat(6001), {profileId:'email', language:'keep'}), /limit is 6000/);
  assert.throws(() => buildTonePrompt('ok', {profileId:'email', language:'keep', selection:'y'.repeat(2001)}), /selection.*limit is 2000/);
});

test('tone prompt: embeds the text verbatim, the exact rules and the selection when given', () => {
  const text = 'Hi team,\n  the build at https://ci.example.com/run/42 failed — see `npm test`.\nThanks';
  const t = buildTonePrompt(text, {profileId:'email', language:'keep'});
  assert.ok(t.prompt.includes(text));
  for (const r of email.rules) assert.ok(t.prompt.includes(r), r);
  assert.equal(t.chars, t.prompt.length);
  assert.equal(t.profile.id, 'email');
  assert.equal(t.source, 'text');
  assert.ok(t.prompt.includes('- https://ci.example.com/run/42'));
  const s = buildTonePrompt(text, {profileId:'code-comment', language:'de', selection:'the build failed'});
  assert.equal(s.source, 'selection');
  assert.equal(s.original, 'the build failed');
  assert.ok(s.prompt.includes('"""\nthe build failed\n"""'));
  assert.deepEqual(buildTonePrompt(text, {profileId:'email', language:'keep'}), t);
});

test('protected tokens: URL, email, code span, placeholder, format marker and number with unit', () => {
  const text = 'Mail ops@example.org or open https://example.com/status. Run `npm ci` for {{user_name}}; logs say %s and %2$d. Upload is 25 MB, took 300ms, cost $12.50 and 40% done.';
  const tokens = extractProtectedTokens(text);
  const values = tokens.map((t) => t.value);
  const kind = (v) => tokens.find((t) => t.value === v)?.kind;
  assert.equal(kind('https://example.com/status'), 'url');
  assert.equal(kind('ops@example.org'), 'email');
  assert.equal(kind('`npm ci`'), 'code');
  assert.equal(kind('{{user_name}}'), 'placeholder');
  assert.equal(kind('%s'), 'format');
  assert.equal(kind('%2$d'), 'format');
  assert.equal(kind('25 MB'), 'number');
  assert.equal(kind('300ms'), 'number');
  assert.equal(kind('$12.50'), 'number');
  assert.equal(kind('40%'), 'number');
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(extractProtectedTokens('Plain words with 3 apples only.'), []);
});

test('checkRewrite: flags a dropped URL and passes an equivalent rewrite', () => {
  const original = 'The report is at https://example.com/r/7 and is 2 MB.';
  const good = checkRewrite(original, 'You can find the 2 MB report at https://example.com/r/7.', email);
  assert.deepEqual(good, {ok:true, problems:[], missingTokens:[], lengthRatio:good.lengthRatio});
  assert.equal(good.ok, true);
  const bad = checkRewrite(original, 'The report is online and is 2 MB in size.', email);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missingTokens, ['https://example.com/r/7']);
  assert.ok(bad.problems.some((p) => p.includes('https://example.com/r/7')));
  const empty = checkRewrite(original, '   ', email);
  assert.equal(empty.ok, false);
  assert.match(empty.problems[0], /empty/);
});

test('checkRewrite: lengthRatio has 2 decimals and is bounded to 0.3..3.0; maxChars and line breaks are checked', () => {
  const original = 'abcdefghij';
  assert.equal(checkRewrite(original, 'abc', email).lengthRatio, 0.3);
  assert.equal(checkRewrite(original, 'abc', email).ok, true);
  const short = checkRewrite(original, 'ab', email);
  assert.equal(short.lengthRatio, 0.2);
  assert.ok(short.problems.some((p) => /Length ratio 0\.20/.test(p)));
  assert.equal(checkRewrite(original, 'x'.repeat(30), email).ok, true);
  const long = checkRewrite(original, 'x'.repeat(31), email);
  assert.equal(long.lengthRatio, 3.1);
  assert.equal(long.ok, false);
  assert.equal(checkRewrite('abc', 'abcd', email).lengthRatio, 1.33);
  const social = TONE_PROFILES.find((p) => p.id === 'social-post');
  const over = checkRewrite('y'.repeat(200), 'y'.repeat(300), social);
  assert.ok(over.problems.some((p) => /allows 280/.test(p)));
  const lines = checkRewrite('line one\nline two\nline three', 'line one line two line three', email);
  assert.ok(lines.problems.some((p) => /Line breaks were lost/.test(p)));
  const chat = TONE_PROFILES.find((p) => p.id === 'team-chat');
  assert.equal(checkRewrite('line one\nline two\nline three', 'line one line two line three', chat).ok, true);
});

test('tone profiles source: no network calls and the UI wires the existing send path', () => {
  const src = fs.readFileSync(path.join(root,'src/ui/tone-profiles.ts'),'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.|document\./);
  const ui = fs.readFileSync(path.join(root,'src/components/PromptTools.tsx'),'utf8');
  assert.match(ui, /Tone and translation/);
  assert.match(ui, /usePref<ToneChoice>\(TONE_PROFILE_PREF_KEY/);
  assert.match(ui, /buildTonePrompt\(/);
  assert.match(ui, /checkRewrite\(/);
  assert.match(ui, /createDraftSender\(api/);
  assert.match(ui, /Check found \$\{toneCheck\.problems\.length\} problem/);
  assert.doesNotMatch(ui, /\bfetch\s*\(|XMLHttpRequest/);
});
