import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/compat-tiers.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const ct = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {SUPPORT_MATRIX, MINIMUM_HARDWARE, RECOMMENDED_HARDWARE, HARDWARE_NOTE, normalizeSystemInfo, classifyCompatibility, tierLabel, tierExplanation, buildCompatReport} = ct;

const good = (over = {}) => ({platform:'win32', arch:'x64', osRelease:'10.0.22631', totalMemGb:16, freeDiskGb:50, cpuCores:8, ...over});

test('compat: matrix has exactly one validated row (win32 x64) and documented hardware', () => {
  const validated = SUPPORT_MATRIX.filter((r) => r.tier === 'validated');
  assert.equal(validated.length, 1);
  assert.equal(validated[0].platform, 'win32');
  assert.equal(validated[0].arch, 'x64');
  assert.equal(validated[0].minBuild, 19045);
  assert.equal(SUPPORT_MATRIX.find((r) => r.platform === 'win32' && r.arch === 'arm64').tier, 'untested');
  assert.ok(Object.isFrozen(SUPPORT_MATRIX));
  assert.deepEqual({...MINIMUM_HARDWARE}, {ramGb:8, freeDiskGb:4, cpuCores:4});
  assert.deepEqual({...RECOMMENDED_HARDWARE}, {ramGb:16, freeDiskGb:20, cpuCores:8});
  assert.match(HARDWARE_NOTE, /planning values, not laptop-by-laptop promises/);
  const r = classifyCompatibility(good());
  assert.equal(r.tier, 'validated');
  assert.equal(r.meetsMinimum, true);
  assert.equal(r.meetsRecommended, true);
  assert.deepEqual(r.missing, []);
});

test('compat: arm64 is untested with exact ordered reasons and honest label', () => {
  const r = classifyCompatibility(good({arch:'aarch64'}));
  assert.equal(r.tier, 'untested');
  assert.equal(r.arch, 'arm64');
  assert.deepEqual(r.reasons, [
    'Platform win32 (Windows) is the platform the installer is built for.',
    'Architecture arm64 is untested: no ARM64 installer has been built or smoke-tested.',
    'Windows build 22631 is at or above the validated minimum build 19045.',
    'RAM 16 GB meets the 8 GB minimum.',
    'Free disk 50 GB meets the 4 GB minimum.',
    'CPU cores 8 cores meets the 4 cores minimum.',
  ]);
  assert.equal(tierLabel('untested'), 'Untested');
  assert.match(tierExplanation('untested'), /no evidence/);
  assert.match(tierExplanation('untested'), /not that it failed/);
});

test('compat: ia32, darwin and linux are unsupported', () => {
  assert.equal(classifyCompatibility(good({arch:'ia32'})).tier, 'unsupported');
  assert.equal(classifyCompatibility(good({arch:'i686'})).tier, 'unsupported');
  const mac = classifyCompatibility(good({platform:'darwin', arch:'arm64'}));
  assert.equal(mac.tier, 'unsupported');
  assert.equal(mac.reasons[0], 'Platform darwin is unsupported: the installer is built for Windows only.');
  assert.equal(classifyCompatibility(good({platform:'linux'})).tier, 'unsupported');
  assert.equal(mac.reasons.some((x) => x.startsWith('Windows build')), false, 'no OS build reason off Windows');
});

test('compat: old Windows builds get a build reason and lose validated tier', () => {
  const r = classifyCompatibility(good({osRelease:'10.0.17763'}));
  assert.equal(r.tier, 'untested');
  assert.equal(r.reasons[2], 'Windows build 17763 is older than the validated minimum build 19045.');
  const ancient = classifyCompatibility(good({osBuild:9600}));
  assert.equal(ancient.tier, 'unsupported');
  assert.equal(ancient.reasons[2], 'Windows build 9600 is older than Windows 10 (build 10240) and is unsupported.');
  assert.equal(classifyCompatibility(good({osBuild:19045})).tier, 'validated');
  assert.equal(classifyCompatibility(good({osBuild:19044}), {validatedBuilds:19000}).tier, 'validated');
  const noBuild = classifyCompatibility(good({osRelease:undefined}));
  assert.equal(noBuild.tier, 'expected');
  assert.deepEqual(noBuild.missing, ['osBuild']);
});

test('compat: hardware below minimum gives per-resource reasons and meetsMinimum false', () => {
  const r = classifyCompatibility(good({totalMemGb:4, freeDiskGb:2, cpuCores:2}));
  assert.equal(r.tier, 'validated', 'tier is about platform evidence, hardware is separate');
  assert.equal(r.meetsMinimum, false);
  assert.equal(r.meetsRecommended, false);
  assert.deepEqual(r.reasons.slice(3), [
    'RAM 4 GB is below the 8 GB minimum.',
    'Free disk 2 GB is below the 4 GB minimum.',
    'CPU cores 2 cores is below the 4 cores minimum.',
  ]);
  const mid = classifyCompatibility(good({totalMemGb:8, freeDiskGb:4, cpuCores:4}));
  assert.equal(mid.meetsMinimum, true);
  assert.equal(mid.meetsRecommended, false);
});

test('compat: missing values yield null, missing entries and never throw', () => {
  for (const input of [undefined, null, 42, 'x', [], {}]) {
    const r = classifyCompatibility(input);
    assert.equal(r.tier, 'untested');
    assert.equal(r.meetsMinimum, null);
    assert.equal(r.meetsRecommended, null);
    assert.deepEqual(r.missing, ['platform', 'arch', 'totalMemGb', 'freeDiskGb', 'cpuCores']);
    assert.equal(r.reasons.length, 5);
  }
  const partial = classifyCompatibility({platform:'win32', arch:'x64', osBuild:22000, totalMemGb:32});
  assert.deepEqual(partial.missing, ['freeDiskGb', 'cpuCores']);
  assert.equal(partial.meetsMinimum, null);
  assert.equal(partial.reasons[4], 'Free disk not reported (minimum 4 GB).');
  const hostile = new Proxy({}, {get() { throw new Error('boom'); }});
  assert.doesNotThrow(() => classifyCompatibility(hostile));
  assert.doesNotThrow(() => buildCompatReport(hostile));
});

test('compat: normalizeSystemInfo coerces garbage input', () => {
  assert.deepEqual(normalizeSystemInfo({platform:42, arch:{}, osRelease:'banana', totalMemGb:-3, freeDiskGb:NaN, cpuCores:2.5, gpu:7}),
    {platform:null, arch:'unknown', osBuild:null, totalMemGb:null, freeDiskGb:null, cpuCores:null, gpu:null});
  assert.deepEqual(normalizeSystemInfo({platform:' Win32 ', arch:'AMD64', osRelease:'10.0.19045.3803', ramGB:'15.9', freeDiskGb:'0', cpuCores:'12', gpu:' Intel Iris\n'}),
    {platform:'win32', arch:'x64', osBuild:19045, totalMemGb:15.9, freeDiskGb:0, cpuCores:12, gpu:'Intel Iris'});
  assert.equal(normalizeSystemInfo({arch:'mips'}).arch, 'unknown');
  assert.equal(normalizeSystemInfo({totalMemGb:Infinity}).totalMemGb, null);
});

test('compat: buildCompatReport is deterministic plain text', () => {
  const a = buildCompatReport(good({arch:'arm64', freeDiskGb:undefined}));
  const b = buildCompatReport(good({arch:'arm64', freeDiskGb:undefined}));
  assert.equal(a, b);
  const lines = a.split('\n');
  assert.equal(lines[0], 'Compatibility report');
  assert.equal(lines[1], 'Tier: Untested (untested)');
  assert.ok(lines.includes('- Free disk: not reported | min 4 GB: not reported | rec 20 GB: not reported'));
  assert.ok(lines.includes('- RAM: 16 GB | min 8 GB: met | rec 16 GB: met'));
  assert.ok(lines.includes('Missing: freeDiskGb'));
  assert.ok(lines.includes('Meets minimum: not reported'));
  assert.ok(lines.includes('2. Architecture arm64 is untested: no ARM64 installer has been built or smoke-tested.'));
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/);
});

test('compat: source has no network, os module or host process probing; Status wires the panel', () => {
  const src = readFileSync(path.join(root, 'src/ui/compat-tiers.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\b/);
  assert.doesNotMatch(src, /require\(\s*['"](node:)?os['"]\s*\)/);
  assert.doesNotMatch(src, /from\s+['"](node:)?os['"]/);
  assert.doesNotMatch(src, /process\.(arch|platform|env)/);
  assert.doesNotMatch(src, /\bimport\b/);
  const status = readFileSync(path.join(root, 'src/components/Status.tsx'), 'utf8');
  assert.match(status, /Compatibility tier/);
  assert.match(status, /navigator\.clipboard\.writeText\(buildCompatReport\(/);
  assert.match(status, /not reported/);
});
