import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'src/ui/profiles.ts');
const bundle = await build({entryPoints:[srcPath], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const pf = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {PROFILES_PREF_KEY, PROFILE_LIMITS, PROFILE_FIELDS, normalizeProfiles, captureProfile, upsertProfile, renameProfile, removeProfile, setActiveProfile, updateProfileSettings, applyProfile, diffProfile, validateProfileName} = pf;

const settings = (over = {}) => ({onboarded:true, mode:'online', theme:'nebula', reduceMotion:true, startInTray:false, localModel:'llama3.2:3b', localEndpoint:'http://127.0.0.1:11434', cloudModel:'cloud-x', voice:'Zira', allowedRoots:['C:\\Users\\a\\Docs'], approvedApps:['C:\\Apps\\x.exe'], retainDays:45, ...over});
const NOW = '2026-02-01T10:00:00.000Z';
const ALLOWED = ['localModel', 'reduceMotion', 'retainDays', 'startInTray', 'theme', 'voice'];

test('profiles: constants', () => {
  assert.equal(PROFILES_PREF_KEY, 'profiles.v1');
  assert.equal(PROFILE_LIMITS.maxProfiles, 12);
  assert.equal(PROFILE_LIMITS.nameMin, 1);
  assert.equal(PROFILE_LIMITS.nameMax, 40);
  assert.deepEqual([...PROFILE_FIELDS].sort(), ALLOWED);
});

test('profiles: capture holds only allowed fields, never mode/allowedRoots/approvedApps/cloudModel/endpoint', () => {
  const p = captureProfile('  Work   desk ', settings(), NOW, 'p1');
  assert.equal(p.id, 'p1');
  assert.equal(p.name, 'Work desk');
  assert.equal(p.createdAt, NOW);
  assert.equal(p.updatedAt, NOW);
  assert.deepEqual(Object.keys(p.settings).sort(), ALLOWED);
  assert.deepEqual(p.settings, {theme:'nebula', reduceMotion:true, voice:'Zira', localModel:'llama3.2:3b', startInTray:false, retainDays:45});
  const json = JSON.stringify(p);
  for (const banned of ['mode', 'allowedRoots', 'approvedApps', 'cloudModel', 'localEndpoint', 'online', 'Docs', 'x.exe', 'cloud-x', 'onboarded']) assert.ok(!json.includes(banned), banned);
  const auto = captureProfile('Auto', settings(), new Date(NOW));
  assert.match(auto.id, /^profile-/);
  assert.notEqual(captureProfile('Auto', settings(), NOW).id, auto.id);
  assert.throws(() => captureProfile('X', settings(), 'not a date'), /valid Date/);
  assert.throws(() => captureProfile('X', settings({theme:'neon'}), NOW), /malformed/);
});

test('profiles: name validation, duplicate and limit errors are descriptive', () => {
  assert.throws(() => validateProfileName('   '), /cannot be empty/);
  assert.throws(() => validateProfileName(5), /must be text/);
  assert.throws(() => captureProfile('x'.repeat(41), settings(), NOW), /at most 40 characters/);
  assert.equal(validateProfileName('x'.repeat(40)).length, 40);
  let s = upsertProfile({profiles:[], activeProfileId:null}, captureProfile('Work', settings(), NOW, 'a'));
  assert.throws(() => upsertProfile(s, captureProfile('  WORK ', settings(), NOW, 'b')), /A profile named "Work" already exists/);
  s = upsertProfile(s, captureProfile('Home', settings(), NOW, 'b'));
  assert.throws(() => renameProfile(s, 'b', 'work', NOW), /already exists/);
  assert.equal(renameProfile(s, 'a', 'WORK', NOW).profiles[0].name, 'WORK', 'renaming to own name in a new case is allowed');
  assert.throws(() => renameProfile(s, 'missing', 'Z', NOW), /no longer exists/);
  let full = {profiles:[], activeProfileId:null};
  for (let i = 0; i < 12; i++) full = upsertProfile(full, captureProfile(`P${i}`, settings(), NOW, `id${i}`));
  assert.equal(full.profiles.length, 12);
  assert.throws(() => upsertProfile(full, captureProfile('P12', settings(), NOW, 'id12')), /at most 12 profiles/);
  // Replacing an existing id is still allowed at the limit.
  assert.equal(upsertProfile(full, {...full.profiles[0], name:'Renamed'}).profiles[0].name, 'Renamed');
});

test('profiles: apply patch is frozen and exactly the captured fields', () => {
  const p = captureProfile('Night', settings({theme:'paper', voice:'David', retainDays:7}), NOW, 'n');
  const patch = applyProfile(p);
  assert.ok(Object.isFrozen(patch));
  assert.deepEqual({...patch}, {theme:'paper', reduceMotion:true, voice:'David', localModel:'llama3.2:3b', startInTray:false, retainDays:7});
  assert.deepEqual(Object.keys(patch).sort(), ALLOWED);
  assert.throws(() => { 'use strict'; patch.mode = 'online'; });
  // Extra keys smuggled into a stored profile never reach the patch.
  const tampered = {...p, settings:{...p.settings, mode:'online', allowedRoots:['C:\\'], cloudModel:'x'}};
  assert.deepEqual(Object.keys(applyProfile(tampered)).sort(), ALLOWED);
});

test('profiles: remove clears active id only when the active profile is removed', () => {
  let s = upsertProfile({profiles:[], activeProfileId:null}, captureProfile('A', settings(), NOW, 'a'));
  s = upsertProfile(s, captureProfile('B', settings(), NOW, 'b'));
  s = setActiveProfile(s, 'a');
  assert.equal(s.activeProfileId, 'a');
  const kept = removeProfile(s, 'b');
  assert.equal(kept.activeProfileId, 'a');
  assert.deepEqual(kept.profiles.map((p) => p.id), ['a']);
  const cleared = removeProfile(s, 'a');
  assert.equal(cleared.activeProfileId, null);
  assert.deepEqual(cleared.profiles.map((p) => p.id), ['b']);
  assert.throws(() => setActiveProfile(s, 'zzz'), /no longer exists/);
});

test('profiles: normalize drops malformed entries, clamps and dedupes', () => {
  const good = captureProfile('Good', settings(), NOW, 'g');
  const raw = {
    activeProfileId:'gone',
    profiles:[
      good,
      null, 'x', 42, [],
      {...good, id:'g'},
      {...good, id:'dup-name', name:'GOOD'},
      {...good, id:'', name:'Empty id'},
      {...good, id:'noname', name:'   '},
      {...good, id:'baddate', name:'Bad date', createdAt:'yesterday'},
      {...good, id:'badtheme', name:'Bad theme', settings:{...good.settings, theme:'neon'}},
      {...good, id:'nosettings', name:'No settings', settings:null},
      {...good, id:'clamp', name:'  ' + 'L'.repeat(60), settings:{...good.settings, retainDays:99999, mode:'online', approvedApps:['x.exe']}},
      {...good, id:'low', name:'Low', settings:{...good.settings, retainDays:-5}},
    ],
  };
  const n = normalizeProfiles(raw);
  assert.deepEqual(n.profiles.map((p) => p.id), ['g', 'clamp', 'low']);
  assert.equal(n.activeProfileId, null, 'unknown active id is dropped');
  assert.equal(n.profiles[1].name.length, 40);
  assert.equal(n.profiles[1].settings.retainDays, 3650);
  assert.equal(n.profiles[2].settings.retainDays, 1);
  assert.deepEqual(Object.keys(n.profiles[1].settings).sort(), ALLOWED);
  assert.deepEqual(normalizeProfiles(null), {profiles:[], activeProfileId:null});
  assert.deepEqual(normalizeProfiles('garbage'), {profiles:[], activeProfileId:null});
  assert.deepEqual(normalizeProfiles([good]).profiles.map((p) => p.id), ['g'], 'a bare array is accepted');
  assert.equal(normalizeProfiles({profiles:[good], activeProfileId:'g'}).activeProfileId, 'g');
  const many = Array.from({length:20}, (_, i) => ({...good, id:`m${i}`, name:`M${i}`}));
  assert.equal(normalizeProfiles(many).profiles.length, 12);
});

test('profiles: diff reports exactly the changed captured fields; update refreshes them', () => {
  const p = captureProfile('Focus', settings(), NOW, 'f');
  assert.deepEqual(diffProfile(p, settings()), []);
  assert.deepEqual(diffProfile(p, settings({mode:'offline', allowedRoots:[], cloudModel:'other'})), [], 'non-profile fields never count');
  assert.deepEqual(diffProfile(p, settings({theme:'paper', retainDays:10})), ['theme', 'retainDays']);
  assert.deepEqual(diffProfile(p, settings({reduceMotion:false, voice:'', localModel:'m', startInTray:true})), ['reduceMotion', 'voice', 'localModel', 'startInTray']);
  const s = updateProfileSettings({profiles:[p], activeProfileId:'f'}, 'f', settings({theme:'paper'}), '2026-03-01T00:00:00.000Z');
  assert.equal(s.profiles[0].settings.theme, 'paper');
  assert.equal(s.profiles[0].createdAt, NOW);
  assert.equal(s.profiles[0].updatedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(s.activeProfileId, 'f');
});

test('profiles: source is pure, offline and DOM-free', () => {
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|document\.|window\.|electron|node:/);
  assert.doesNotMatch(src, /^import\s+(?!type\s)/m, 'only type imports');
});

test('profiles: Settings wires the Personal profiles section, search entry, saveSettings switch and confirm removal', () => {
  const s = readFileSync(path.join(root, 'src/components/Settings.tsx'), 'utf8');
  assert.match(s, /from '\.\.\/ui\/profiles'/);
  assert.match(s, /id: 'personal-profiles', tab: 'general', title: 'Personal profiles', keywords: \['profile'/);
  assert.match(s, /usePref<unknown>\(PROFILES_PREF_KEY, null\)/);
  assert.match(s, /<SettingsSection ctx=\{sectionCtx\} id="personal-profiles"[^>]*title="Personal profiles"/);
  assert.match(s, /<PersonalProfilesPanel settings=\{settings\} applyPatch=\{applyProfilePatch\}/);
  assert.match(s, /api\.saveSettings\(patch\)/);
  assert.match(s, /applyPatch\(\{ \.\.\.applyProfile\(p\) \}\)/);
  assert.match(s, /Save current as profile/);
  assert.match(s, /Update from current/);
  assert.match(s, /Differs from current settings/);
  assert.match(s, /title=\{removing \? `Remove profile/);
  assert.match(s, /<ConfirmDialog open=\{!!removing\}/);
  // The active marker only moves after a successful save.
  const sw = s.slice(s.indexOf('const switchTo'), s.indexOf('const doRename'));
  assert.ok(sw.indexOf('if (failure)') < sw.indexOf('setActiveProfile'));
  assert.match(sw, /return;\r?\n\s*\}\r?\n\s*commit\(\(s\) => setActiveProfile/);
});
