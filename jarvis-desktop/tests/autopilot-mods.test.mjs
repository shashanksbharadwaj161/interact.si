import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

const catalogSrc = await read('src/ui/mod-catalog.ts');
const componentSrc = await read('src/components/Customization.tsx');

// Bundle the pure module in memory. It must not need the DOM, storage or React.
const pure = await build({
  entryPoints: [path.join(root, 'src/ui/mod-catalog.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(pure.outputFiles[0].text).toString('base64')}`);

// Bundle the real component with a stubbed icon package, then render it to static markup in Node.
const ui = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'customization-test-entry.ts',
    loader: 'ts',
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { Customization } from './src/components/Customization.tsx';
      export const render = (props) => renderToStaticMarkup(createElement(Customization, props));
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  logLevel: 'silent',
  // React's server build requires Node built-ins; give the in-memory ESM bundle a real require.
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({
          contents: ['DownloadSimple', 'CircleNotch', 'Info', 'Warning', 'WarningCircle'].map((n) => `export const ${n} = () => null;`).join('\n'),
          loader: 'js',
        }));
      },
    },
  ],
});
const ui2 = await import(`data:text/javascript;base64,${Buffer.from(ui.outputFiles[0].text).toString('base64')}`);

const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const WIN_X64 = { platform: 'win32', arch: 'x64' };
const fixtureProfile = (over = {}) => ({
  id: 'fixture',
  name: 'Fixture',
  purpose: 'test',
  touches: ['taskbar'],
  risk: 'low',
  reversal: 'test',
  testedBuilds: { min: 22000, max: 26100 },
  testedArches: ['x64'],
  licence: 'unverified',
  homepage: null,
  verifiedVersion: '1.2.0',
  ...over,
});
const supportedEffect = { id: 'fixture.on', touches: 'taskbar', label: 'Fixture effect', supported: true, reason: '' };

test('pure module has no DOM, storage, Electron, registry, process or network code', () => {
  // Checked on the module's own source. The bundle also inlines roadmap labels that contain words like "window".
  assert.ok(!/\bdocument\.|\bwindow\.|localStorage|electron|child_process|winreg|regedit|reg\.exe|\bfetch\(|XMLHttpRequest|\bprocess\./i.test(catalogSrc));
  assert.ok(!/from ['"]react['"]/.test(catalogSrc));
  assert.ok(!/localStorage|child_process|XMLHttpRequest/.test(pure.outputFiles[0].text));
});

test('component performs no system or backend actions', () => {
  assert.ok(!/\bapi\.|ipcRenderer|invoke\(|child_process|execFile|spawn\(|reg add|regedit|\bshell\./i.test(componentSrc));
});

test('shipped catalog profiles are original, unverified and carry no project link or tested claims', () => {
  assert.equal(m.CATALOG.length, 4);
  assert.equal(new Set(m.CATALOG.map((p) => p.id)).size, m.CATALOG.length);
  const valid = new Set(['taskbar', 'start', 'explorer', 'notifications']);
  for (const p of m.CATALOG) {
    assert.equal(p.licence, 'unverified', p.id);
    assert.equal(p.homepage, null, p.id);
    assert.equal(p.verifiedVersion, null, p.id);
    assert.equal(p.testedBuilds, null, p.id);
    assert.equal(p.testedArches, null, p.id);
    assert.ok(p.reversal.length > 10, `${p.id} documents reversal`);
    assert.ok(p.touches.length > 0 && p.touches.every((t) => valid.has(t)), p.id);
    assert.equal(m.projectLink(p), null, `${p.id} offers no link`);
  }
  assert.ok(m.LISTING_RULES.length >= 4);
});

test('roadmap scopes 71-80 are present with the roadmap tiers and experimental status', () => {
  assert.deepEqual(
    m.CUSTOMIZATION_SCOPES.map((s) => s.id),
    [71, 72, 73, 74, 75, 76, 77, 78, 79, 80],
  );
  const tierOf = Object.fromEntries(m.CUSTOMIZATION_SCOPES.map((s) => [s.id, s.tier]));
  assert.equal(tierOf[71], 'First');
  assert.equal(tierOf[72], 'First');
  for (const id of [73, 74, 75]) assert.equal(tierOf[id], 'Expansion');
  for (const id of [76, 77, 78, 79, 80]) assert.equal(tierOf[id], 'Experimental');
  for (const s of m.CUSTOMIZATION_SCOPES.filter((x) => x.tier === 'Experimental')) assert.equal(s.status, 'research', `${s.id} stays research`);
});

test('projectLink passes only verified, permissive, https pages', () => {
  const verified = (homepage) => fixtureProfile({ licence: 'verified-permissive', homepage });
  assert.equal(m.projectLink(fixtureProfile({ licence: 'unverified', homepage: 'https://example.org/tool' })), null);
  assert.equal(m.projectLink(verified('https://example.org/tool')), 'https://example.org/tool');
  assert.equal(m.projectLink(verified('http://example.org/tool')), null);
  assert.equal(m.projectLink(verified('javascript:alert(1)')), null);
  assert.equal(m.projectLink(verified('not a url')), null);
  assert.equal(m.projectLink(verified(null)), null);
});

test('compatibility is unknown when nothing is loaded and incompatible off Windows', () => {
  assert.deepEqual(m.checkCompatibility(m.CATALOG[0], null).status, 'unknown');
  assert.match(m.checkCompatibility(m.CATALOG[0], undefined).reasons[0], /not loaded/);
  const linux = m.checkCompatibility(m.CATALOG[0], { platform: 'linux', arch: 'x64' });
  assert.equal(linux.status, 'incompatible');
  assert.match(linux.reasons[0], /Windows only/);
});

test('shipped profiles on Windows are never compatible because nothing has been tested', () => {
  for (const p of m.CATALOG) {
    const r = m.checkCompatibility(p, { ...WIN_X64, windowsBuild: 22631 });
    assert.notEqual(r.status, 'compatible', p.id);
    assert.equal(r.status, 'unknown', p.id);
    assert.ok(r.reasons.some((x) => /build range has been tested/.test(x)), p.id);
    assert.ok(r.reasons.some((x) => /CPU architecture has been tested/.test(x)), p.id);
    assert.ok(r.reasons.some((x) => /version has not been verified/.test(x)), p.id);
  }
});

test('compatibility is compatible only when every recorded constraint passes', () => {
  const r = m.checkCompatibility(fixtureProfile(), { ...WIN_X64, windowsBuild: 22631 });
  assert.deepEqual(r, { status: 'compatible', reasons: [] });
});

test('compatibility reports out-of-range builds and unlisted architectures as incompatible', () => {
  const old = m.checkCompatibility(fixtureProfile(), { ...WIN_X64, windowsBuild: 19045 });
  assert.equal(old.status, 'incompatible');
  assert.match(old.reasons[0], /outside the tested range 22000–26100/);
  const arm = m.checkCompatibility(fixtureProfile(), { platform: 'win32', arch: 'arm64', windowsBuild: 22631 });
  assert.equal(arm.status, 'incompatible');
  assert.match(arm.reasons[0], /arm64 is not in the tested list: x64/);
});

test('incompatible outranks unknown, and a missing build number is unknown rather than a pass', () => {
  const both = m.checkCompatibility(fixtureProfile({ verifiedVersion: null }), { platform: 'win32', arch: 'arm64', windowsBuild: 22631 });
  assert.equal(both.status, 'incompatible');
  assert.ok(both.reasons.some((x) => /version has not been verified/.test(x)));
  const noBuild = m.checkCompatibility(fixtureProfile(), { ...WIN_X64 });
  assert.equal(noBuild.status, 'unknown');
  assert.ok(noBuild.reasons.some((x) => /does not report the Windows build/.test(x)));
  const noArch = m.checkCompatibility(fixtureProfile(), { platform: 'win32', arch: '', windowsBuild: 22631 });
  assert.equal(noArch.status, 'unknown');
  assert.ok(noArch.reasons.some((x) => /architecture was not reported/.test(x)));
});

test('normalizePrefs falls back to defaults for untrusted input and keeps only literal true values', () => {
  const defaults = { schemaVersion: 1, presetId: 'none', effects: Object.fromEntries(m.EFFECTS.map((e) => [e.id, false])) };
  for (const raw of [null, 'x', [], {}, { schemaVersion: 2, presetId: 'taskbar-start-calm' }]) {
    assert.deepEqual(m.normalizePrefs(raw), defaults, JSON.stringify(raw));
  }
  const tampered = m.normalizePrefs({
    schemaVersion: 1,
    presetId: 'not-a-preset',
    effects: { 'taskbar.align-left': true, 'taskbar.hide-search': 'true', 'start.hide-recommended': 1, 'made.up': true },
  });
  assert.equal(tampered.presetId, 'none');
  assert.deepEqual(Object.keys(tampered.effects).sort(), m.EFFECTS.map((e) => e.id).sort());
  assert.ok(Object.values(tampered.effects).every((v) => v === false), 'unsupported effects stay off even when requested as true');
});

test('normalizePrefs keeps a requested effect once an adapter marks it supported', () => {
  const p = m.normalizePrefs({ schemaVersion: 1, presetId: 'none', effects: { 'fixture.on': true } }, [supportedEffect]);
  assert.deepEqual(p.effects, { 'fixture.on': true });
});

test('setEffect ignores unsupported and unknown effects and never mutates its input', () => {
  const prefs = m.normalizePrefs({});
  assert.equal(m.setEffect(prefs, 'taskbar.align-left', true), prefs);
  assert.equal(m.setEffect(prefs, 'made.up', true), prefs);
  const on = m.setEffect(prefs, 'fixture.on', true, [supportedEffect]);
  assert.equal(on.effects['fixture.on'], true);
  assert.equal(prefs.effects['fixture.on'], undefined, 'input untouched');
});

test('applyPreset selects a preset but every unsupported effect stays off in this build', () => {
  for (const preset of m.PRESETS) {
    const p = m.applyPreset(preset.id);
    assert.equal(p.presetId, preset.id);
    assert.ok(Object.values(p.effects).every((v) => v === false), preset.id);
  }
  assert.equal(m.applyPreset('missing').presetId, 'none');
});

test('applyPreset turns on exactly the preset effects that are supported', () => {
  const effects = [supportedEffect, { ...m.EFFECTS[0], id: 'fixture.other', supported: true }, m.EFFECTS[1]];
  const presets = [{ id: 'fixture', name: 'F', scope: null, blurb: '', effects: ['fixture.on', m.EFFECTS[1].id] }];
  const p = m.applyPreset('fixture', effects, presets);
  assert.deepEqual(p.effects, { 'fixture.on': true, 'fixture.other': false, [m.EFFECTS[1].id]: false });
});

test('preset effect ids all exist in the effect list', () => {
  const ids = new Set(m.EFFECTS.map((e) => e.id));
  for (const p of m.PRESETS) for (const id of p.effects) assert.ok(ids.has(id), `${p.id} -> ${id}`);
  assert.equal(new Set(m.EFFECTS.map((e) => e.id)).size, m.EFFECTS.length);
});

test('preview shows every effect as not built, changes nothing and says so', () => {
  const preview = m.previewPrefs(m.applyPreset('taskbar-start-calm'));
  assert.equal(preview.changesWindows, false);
  assert.equal(preview.previewCount, 0);
  assert.equal(preview.unsupportedCount, m.EFFECTS.length);
  assert.equal(preview.total, m.EFFECTS.length);
  for (const line of preview.lines) {
    assert.equal(line.state, 'unsupported');
    assert.match(line.text, /Not built/);
  }
  assert.match(preview.headline, /No setting in this build would change Windows/);
});

test('preview marks a supported, requested effect as preview-only and never as applied', () => {
  const prefs = m.normalizePrefs({ schemaVersion: 1, effects: { 'fixture.on': true } }, [supportedEffect]);
  const preview = m.previewPrefs(prefs, [supportedEffect]);
  assert.equal(preview.previewCount, 1);
  assert.equal(preview.lines[0].state, 'preview');
  assert.match(preview.lines[0].text, /does not change Windows/);
  assert.match(preview.headline, /previewed\. This screen does not apply them/);
  assert.equal(preview.changesWindows, false);
});

test('export writes only validated fields and marks the file as not applying to Windows', () => {
  const tampered = { schemaVersion: 1, presetId: 'taskbar-start-calm', effects: { 'taskbar.align-left': true } };
  const text = m.exportPrefs(tampered);
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj), ['format', 'schemaVersion', 'appliesToWindows', 'presetId', 'effects']);
  assert.equal(obj.format, m.EXPORT_FORMAT);
  assert.equal(obj.appliesToWindows, false);
  assert.equal(obj.presetId, 'taskbar-start-calm');
  assert.equal(obj.effects['taskbar.align-left'], false, 'unsupported effect exported as off');
});

test('export round-trips through parseExport and rejects anything else', () => {
  const prefs = m.applyPreset('explorer-notify-tidy');
  assert.deepEqual(m.parseExport(m.exportPrefs(prefs)), m.normalizePrefs(prefs));
  assert.equal(m.parseExport('not json'), null);
  assert.equal(m.parseExport(JSON.stringify({ format: 'other', schemaVersion: 1 })), null);
  assert.equal(m.parseExport(null), null);
  assert.equal(m.parseExport(42), null);
  assert.equal(m.parseExport('x'.repeat(m.MAX_EXPORT_CHARS + 1)), null);
  const forged = m.parseExport(JSON.stringify({ format: m.EXPORT_FORMAT, schemaVersion: 1, effects: { 'taskbar.align-left': true } }));
  assert.equal(forged.effects['taskbar.align-left'], false, 'imported unsupported effect is off');
});

const render = (system) => unescapeHtml(ui2.render({ system }));

test('component renders the catalog with honest compatibility and licence labels', () => {
  const html = render(WIN_X64);
  for (const p of m.CATALOG) assert.ok(html.includes(p.name), p.name);
  assert.equal((html.match(/Licence unverified/g) || []).length, m.CATALOG.length);
  assert.equal((html.match(/Needs check/g) || []).length, m.CATALOG.length);
  assert.ok(!html.includes('Compatible<'), 'no profile is labelled compatible');
  assert.ok(html.includes('No project link. The licence has not been verified.'));
  assert.ok(!/Project page: https?:/.test(html));
  assert.ok(html.includes('Not reported by this app'), 'Windows build is reported as unknown');
});

test('component states when system information has not loaded', () => {
  const html = render(null);
  assert.ok(html.includes('Not loaded yet'));
  assert.ok(html.includes('System information is not loaded yet.'));
});

test('every effect switch is disabled and each explains why it is off', () => {
  const html = render(WIN_X64);
  const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) || [];
  assert.equal(switches.length, m.EFFECTS.length);
  for (const s of switches) assert.match(s, /disabled=""/);
  for (const e of m.EFFECTS) assert.ok(html.includes(e.reason), 'reason shown');
  for (const e of m.EFFECTS) assert.ok(html.includes(e.label), e.label);
});

test('no enabled control claims to install, apply, inject or touch the registry', () => {
  const html = render(WIN_X64);
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.ok(buttons.length >= 2);
  for (const b of buttons) {
    if (/install|apply|inject|registry|turn on|enable/i.test(b.replace(/<[^>]+>/g, ' '))) assert.match(b, /disabled/, b);
  }
  assert.ok(html.includes('Download JSON'));
  const restore = buttons.find((b) => b.includes('Restore preferences'));
  assert.ok(restore && /disabled/.test(restore), 'restore is disabled with a reason');
});

test('export preview is validated JSON that never claims to apply to Windows', () => {
  const html = render(WIN_X64);
  assert.ok(html.includes('"appliesToWindows": false'));
  assert.ok(html.includes(`"format": "${m.EXPORT_FORMAT}"`));
});

test('experimental scopes 76-80 are listed as not built', () => {
  const html = render(WIN_X64);
  const experimental = m.CUSTOMIZATION_SCOPES.filter((x) => x.id >= 76);
  for (const s of experimental) assert.ok(html.includes(s.name), s.name);
  assert.equal((html.match(/Needs a feasibility and licence review/g) || []).length, experimental.length);
  // Experimental rows plus one "Not built" preview badge per unsupported effect.
  assert.equal((html.match(/>Not built</g) || []).length, experimental.length + m.EFFECTS.length);
});

test('component renders with the preset panel and roadmap eyebrows', () => {
  const html = render(WIN_X64);
  for (const eyebrow of ['Roadmap 71–72 · First', 'Roadmap 73–74 · Expansion', 'Roadmap 75 · Expansion', 'Roadmap 76–80 · Experimental']) assert.ok(html.includes(eyebrow), eyebrow);
  assert.ok(html.includes('Preview only'));
});

test('autopilot result file for the mods module lists its owned files and a boolean done flag', async () => {
  const r = JSON.parse(await read('docs/autopilot-result.mods.json'));
  assert.equal(r.role, 'mods');
  assert.deepEqual([...r.files].sort(), [
    'docs/autopilot-result.mods.json',
    'src/components/Customization.tsx',
    'src/ui/mod-catalog.ts',
    'tests/autopilot-mods.test.mjs',
  ]);
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0);
  assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0);
  assert.equal(typeof r.done, 'boolean');
});
