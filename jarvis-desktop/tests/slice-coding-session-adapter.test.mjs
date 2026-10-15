import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'src/ui/coding-session-adapter.ts');
const bundle = await build({entryPoints:[modPath], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {ADAPTER_LIMITS, parseGitLog, groupSessions, groupSessionsDetailed, buildCheckpointDrafts, toCheckpointOp, parseGitDate} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const DEFAULT_LOG = [
  'commit 3333333333333333333333333333333333333333 (HEAD -> main)',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Wed Oct 14 11:30:00 2026 +0000',
  '',
  '    Add parser tests',
  '',
  '    Covers three layouts.',
  '',
  'commit 2222222222222222222222222222222222222222',
  'Merge: aaaaaaa bbbbbbb',
  'Author: Ada Lovelace <ada@example.com>',
  'Date:   Wed Oct 14 12:00:00 2026 +0200',
  '',
  '    Wire parser',
  '',
  'garbage line here',
  'commit 1111111111111111111111111111111111111111',
  'Author: Bob <bob@example.com>',
  'Date:   Wed Oct 14 07:00:00 2026 +0000',
  '',
  '    Start parser',
  '',
].join('\n');

test('limits are exported with the agreed values', () => {
  assert.equal(ADAPTER_LIMITS.inputChars, 200000);
  assert.equal(ADAPTER_LIMITS.commits, 2000);
  assert.equal(ADAPTER_LIMITS.sessions, 200);
  assert.equal(ADAPTER_LIMITS.gapMinutes, 120);
});

test('default git log layout: headers, timezone-aware dates, subject/body, skipped garbage', () => {
  const p = parseGitLog(DEFAULT_LOG);
  assert.equal(p.layout, 'default');
  assert.equal(p.truncated, false);
  assert.equal(p.skippedLines, 1);
  assert.deepEqual(p.commits.map((c) => c.sha.slice(0, 4)), ['3333', '2222', '1111']);
  assert.deepEqual(p.commits[0], {sha:'3333333333333333333333333333333333333333', author:'Ada Lovelace', at:'2026-10-14T11:30:00.000Z', subject:'Add parser tests', body:'Covers three layouts.'});
  assert.equal(p.commits[1].at, '2026-10-14T10:00:00.000Z');
  assert.equal(p.commits[1].subject, 'Wire parser');
  assert.equal(p.commits[1].body, undefined);
  assert.equal(p.commits[2].author, 'Bob');
  assert.ok(!JSON.stringify(p).includes('example.com'), 'emails are not kept');
});

test('oneline layout is auto-detected; decorations stripped; commits undated', () => {
  const p = parseGitLog('abc1234 (HEAD -> main, origin/main) Fix bug\ndef5678 Add feature\n\nnot a commit line\n');
  assert.equal(p.layout, 'oneline');
  assert.equal(p.skippedLines, 1);
  assert.deepEqual(p.commits, [{sha:'abc1234', subject:'Fix bug'}, {sha:'def5678', subject:'Add feature'}]);
});

test('tab-separated %H %an %aI %s layout is auto-detected over oneline', () => {
  const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tAda\t2026-10-14T10:00:00+02:00\tFirst\tthing\r\nbbbbbbb\tBob\tnot-a-date\tSecond\nzzz junk\n';
  const p = parseGitLog(text);
  assert.equal(p.layout, 'tsv');
  assert.equal(p.skippedLines, 1);
  assert.deepEqual(p.commits[0], {sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author:'Ada', at:'2026-10-14T08:00:00.000Z', subject:'First thing'});
  assert.deepEqual(p.commits[1], {sha:'bbbbbbb', author:'Bob', subject:'Second'});
  assert.equal(parseGitDate('2026-10-14 10:00:00 +0200'), '2026-10-14T08:00:00.000Z');
  assert.equal(parseGitDate('yesterday'), undefined);
});

test('empty, oversize and unrecognizable input throw descriptive errors', () => {
  assert.throws(() => parseGitLog(''), /empty/);
  assert.throws(() => parseGitLog('   \n  '), /empty/);
  assert.throws(() => parseGitLog(undefined), /empty/);
  assert.throws(() => parseGitLog('x'.repeat(200001)), /too long.*200000/);
  assert.throws(() => parseGitLog('hello world\nthis is not git\n'), /No recognizable commit lines/);
});

test('commit count is truncated honestly at the limit', () => {
  const lines = [];
  for (let i = 0; i < 2005; i++) lines.push(`${(0x1000000 + i).toString(16)} c${i}`);
  const p = parseGitLog(lines.join('\n'));
  assert.equal(p.commits.length, 2000);
  assert.equal(p.truncated, true);
  const q = parseGitLog(lines.slice(0, 2000).join('\n'));
  assert.equal(q.truncated, false);
});

test('gap splitting: exact boundary stays together, one minute more splits; ascending order and s-<index> ids', () => {
  const c = (sha, at) => ({sha, at, subject:`subj ${sha}`});
  const commits = [
    c('d000004', '2026-10-14T13:01:00.000Z'), // 121 min after c3 -> new session
    c('d000003', '2026-10-14T11:00:00.000Z'), // exactly 120 min after c2 -> same session
    c('d000002', '2026-10-14T09:00:00.000Z'),
    c('d000001', '2026-10-14T08:30:00.000Z'),
  ];
  const s = groupSessions(commits, {gapMinutes:120});
  assert.deepEqual(s.map((x) => x.id), ['s-0', 's-1']);
  assert.deepEqual(s[0].commits.map((x) => x.sha), ['d000001', 'd000002', 'd000003']);
  assert.equal(s[0].startedAt, '2026-10-14T08:30:00.000Z');
  assert.equal(s[0].endedAt, '2026-10-14T11:00:00.000Z');
  assert.equal(s[0].commitCount, 3);
  assert.equal(s[0].title, 'subj d000001');
  assert.equal(s[0].summary, '- subj d000001 (d000001)\n- subj d000002 (d000002)\n- subj d000003 (d000003)');
  assert.deepEqual(s[1].commits.map((x) => x.sha), ['d000004']);
  // default gap is 120; a larger gap merges everything
  assert.deepEqual(groupSessions(commits).map((x) => x.commitCount), [3, 1]);
  assert.deepEqual(groupSessions(commits, {gapMinutes:121}).map((x) => x.commitCount), [4]);
  // deterministic regardless of input order
  assert.deepEqual(groupSessions([...commits].reverse(), {gapMinutes:120}), s);
  for (const bad of [0, -5, NaN, Infinity, '120', 99999]) assert.throws(() => groupSessions(commits, {gapMinutes:bad}), /gapMinutes/);
});

test('undated commits form one final undated session; caps on title and summary', () => {
  const long = 'x'.repeat(300);
  const commits = [{sha:'e000001', subject:long}, {sha:'e000002', at:'2026-10-14T08:00:00.000Z', subject:'dated'}];
  for (let i = 0; i < 100; i++) commits.push({sha:`f${String(i).padStart(6, '0')}`, subject:`undated ${'y'.repeat(30)} ${i}`});
  const s = groupSessions(commits);
  assert.equal(s.length, 2);
  assert.equal(s[0].undated, false);
  assert.equal(s[1].id, 's-1');
  assert.equal(s[1].undated, true);
  assert.equal(s[1].startedAt, undefined);
  assert.equal(s[1].commitCount, 101);
  assert.ok(s[1].title.length <= 120);
  assert.ok(s[1].summary.length <= 2000);
  assert.match(s[1].summary, /- … and \d+ more$/);
  const many = Array.from({length:250}, (_, i) => ({sha:`a${String(i).padStart(6, '0')}`, at:new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(), subject:`d${i}`}));
  const g = groupSessionsDetailed(many);
  assert.equal(g.sessions.length, 200);
  assert.equal(g.totalSessions, 250);
  assert.equal(g.truncated, true);
});

test('drafts match store Checkpoint field names, carry git:<sha> evidence and become checkpoint.add ops', () => {
  const sessions = groupSessions(parseGitLog(DEFAULT_LOG).commits);
  assert.equal(sessions.length, 2);
  const drafts = buildCheckpointDrafts(sessions, {capsuleId:'proj-a', repoLabel:'webapp', now:'2026-10-14T11:00:00.000Z'});
  const checkpointKeys = ['title', 'note', 'createdAt', 'capsuleId', 'refs'];
  for (const d of drafts) {
    for (const k of checkpointKeys) assert.ok(k in d, `draft has ${k}`);
    assert.equal(typeof d.title, 'string');
    assert.ok(d.title.length <= 120);
    assert.ok(d.note.length <= 4000);
    assert.deepEqual(d.refs, [{kind:'capsule', id:'proj-a'}]);
    for (const r of d.gitRefs) { assert.match(r, /^git:[0-9a-f]{7,64}$/); assert.ok(d.note.includes(r)); }
  }
  assert.equal(drafts[0].title, 'webapp: Start parser');
  assert.equal(drafts[0].createdAt, '2026-10-14T07:00:00.000Z');
  assert.deepEqual(drafts[1].gitRefs, ['git:2222222222222222222222222222222222222222', 'git:3333333333333333333333333333333333333333']);
  assert.equal(drafts[1].createdAt, '2026-10-14T11:00:00.000Z', 'future end clamped to now');
  const op = toCheckpointOp(drafts[1]);
  assert.deepEqual(Object.keys(op).sort(), ['capsuleId', 'createdAt', 'note', 'op', 'refs', 'title']);
  assert.equal(op.op, 'checkpoint.add');
  assert.ok(!('gitRefs' in op) && !('sessionId' in op));
  const plain = buildCheckpointDrafts(groupSessions([{sha:'abc1234', subject:'x'}]));
  assert.deepEqual(plain[0].refs, []);
  assert.equal(plain[0].createdAt, undefined);
  assert.deepEqual(Object.keys(toCheckpointOp(plain[0])).sort(), ['note', 'op', 'refs', 'title']);
  assert.throws(() => buildCheckpointDrafts(sessions, {capsuleId:42}), /capsuleId/);
  assert.throws(() => buildCheckpointDrafts(sessions, {capsuleId:'../x'}), /capsuleId/);
  assert.throws(() => buildCheckpointDrafts(sessions, {repoLabel:{}}), /repoLabel/);
  assert.deepEqual(buildCheckpointDrafts(sessions, {capsuleId:'proj-a'}), buildCheckpointDrafts(sessions, {capsuleId:'proj-a'}));
});

test('module source never runs git, reads files or touches the network; UI states the offline note', () => {
  const src = readFileSync(modPath, 'utf8');
  for (const bad of [/child_process/, /\bfetch\s*\(/, /XMLHttpRequest/, /from\s+['"](node:)?fs['"]/, /require\s*\(/, /\bimport\s*\(/, /WebSocket/, /\bdocument\./, /\bwindow\./]) assert.doesNotMatch(src, bad);
  const ui = readFileSync(path.join(root, 'src/components/MemoryWorkbench.tsx'), 'utf8');
  assert.ok(ui.includes('Import coding sessions (git log, offline)'));
  assert.ok(ui.includes('Parsed from pasted text only; this build does not run git or read repositories.'));
  assert.ok(ui.includes('toCheckpointOp(d)'));
});
