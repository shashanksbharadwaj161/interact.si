// Clipboard history tests: opt-in capture, duplicate handling, retention, bounds, secret filtering, persistence.
// Bundles the real TypeScript service. The reader and storage are in-memory fakes; the real system clipboard is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'electron', 'services', 'clipboard.ts');
const out = await build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { ClipboardHistory, looksSensitive, CLIPBOARD_LIMITS, CLIPBOARD_SCHEMA_VERSION } = mod;

// ---------- helpers ----------

/** Fake reader: `set()` changes what the "clipboard" holds; `reads` counts how often the service looked. */
function fakeReader(initial = '') {
  const r = {
    text: initial,
    concealed: false,
    reads: 0,
    fail: null,
    set(t, concealed = false) { r.text = t; r.concealed = concealed; },
    readText: async () => { r.reads++; if (r.fail) throw new Error(r.fail); return r.text; },
    isConcealed: async () => r.concealed,
  };
  return r;
}

/** Fake clock whose time the test controls. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

/** In-memory storage with a write counter and optional failure injection. */
function memStorage(initial = null) {
  const s = {
    doc: initial,
    writes: 0,
    failWrite: false,
    failRead: false,
    read: async () => { if (s.failRead) throw new Error('read denied'); return s.doc; },
    write: async (d) => { if (s.failWrite) throw new Error('disk full'); s.writes++; s.doc = d; },
  };
  return s;
}

let idSeq = 0;
const newId = () => `id-${++idSeq}`;

function make(opts = {}) {
  const clock = opts.clock ?? fakeClock();
  const reader = opts.reader ?? fakeReader();
  const storage = opts.storage;
  const svc = new ClipboardHistory({
    reader,
    storage,
    now: clock.now,
    newId,
    maxEntries: opts.maxEntries,
    retentionMs: opts.retentionMs,
    maxChars: opts.maxChars,
  });
  return { svc, clock, reader, storage };
}

// ---------- defaults and opt-in ----------

test('history is off by default and never reads the clipboard', async () => {
  const { svc, reader } = make();
  reader.set('hello world');
  assert.equal(await svc.capture(), 'disabled');
  assert.equal(reader.reads, 0, 'reader must not be called while disabled');
  assert.equal(svc.status().enabled, false);
  assert.equal(svc.status().count, 0);
});

test('enabling starts capture; disabling purges stored entries', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set('first copy');
  assert.equal(await svc.capture(), 'added');
  assert.equal(svc.status().count, 1);

  const st = await svc.setEnabled(false);
  assert.equal(st.enabled, false);
  assert.equal(st.count, 0, 'turning history off must purge entries');
  assert.deepEqual(svc.list(), []);
});

test('re-enabling after disable records the same text again (fingerprint was reset)', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set('repeat me');
  assert.equal(await svc.capture(), 'added');
  await svc.setEnabled(false);
  await svc.setEnabled(true);
  assert.equal(await svc.capture(), 'added');
  assert.equal(svc.status().count, 1);
});

// ---------- capture and duplicate handling ----------

test('polling the same unchanged clipboard does not add duplicates or re-store', async () => {
  const storage = memStorage();
  const { svc, reader } = make({ storage });
  await svc.setEnabled(true);
  reader.set('steady text');
  assert.equal(await svc.capture(), 'added');
  assert.equal(await svc.capture(), 'unchanged');
  assert.equal(await svc.capture(), 'unchanged');
  assert.equal(svc.status().count, 1);
  assert.equal(svc.list()[0].copies, 1);
});

test('copying an older text again merges it, bumps copies, and moves it to the top', async () => {
  const { svc, reader, clock } = make();
  await svc.setEnabled(true);
  reader.set('alpha'); await svc.capture();
  clock.advance(1000);
  reader.set('beta'); await svc.capture();
  clock.advance(1000);
  reader.set('alpha'); assert.equal(await svc.capture(), 'merged');
  const list = svc.list();
  assert.equal(list.length, 2, 'no duplicate row');
  assert.equal(list[0].preview, 'alpha', 'merged text moves to the top');
  assert.equal(list[0].copies, 2);
  assert.equal(list[0].capturedAt, clock.now());
  assert.equal(list[1].preview, 'beta');
});

test('empty and whitespace-only clipboard content is skipped', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set(''); assert.equal(await svc.capture(), 'empty');
  reader.set('   \n\t '); assert.equal(await svc.capture(), 'empty');
  assert.equal(svc.status().count, 0);
});

test('a failing reader reports lastError and does not throw or store anything', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.fail = 'clipboard busy';
  assert.equal(await svc.capture(), 'empty');
  assert.match(svc.status().lastError, /clipboard busy/);
  assert.equal(svc.status().count, 0);
});

// ---------- secret and concealed filtering ----------

test('credential-shaped text is never stored', async () => {
  const samples = [
    'password = hunter2-long',
    'api_key: abcdef1234567890',
    'ACCESS_TOKEN=xyz123',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_' + 'a'.repeat(36),
    'sk-ant-api03-' + 'b'.repeat(30),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij_klm',
    'Authorization: Bearer ' + 'c'.repeat(32),
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
    'xoxb-1234567890-abcdefghij',
  ];
  for (const s of samples) {
    assert.equal(looksSensitive(s), true, `expected sensitive: ${s.slice(0, 30)}`);
  }
  const { svc, reader } = make();
  await svc.setEnabled(true);
  for (const s of samples) {
    reader.set(s);
    assert.equal(await svc.capture(), 'sensitive');
  }
  assert.equal(svc.status().count, 0);
});

test('ordinary text that mentions passwords without a value is kept', async () => {
  const ok = [
    'Remember to reset your password tomorrow',
    'The secret ingredient is butter',
    'Meeting notes: discuss API keys rotation policy',
    'https://example.com/docs/tokens',
  ];
  for (const s of ok) assert.equal(looksSensitive(s), false, `expected not sensitive: ${s}`);
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set(ok[0]);
  assert.equal(await svc.capture(), 'added');
});

test('text flagged as concealed by the source is never stored, even when it looks harmless', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set('just a phrase', true);
  assert.equal(await svc.capture(), 'concealed');
  assert.equal(svc.status().count, 0);
});

test('stored entries that look sensitive are dropped when history loads', async () => {
  const doc = JSON.stringify({
    schemaVersion: CLIPBOARD_SCHEMA_VERSION,
    enabled: true,
    entries: [
      { id: 'a', text: 'password=supersecretvalue', capturedAt: 5, copies: 1 },
      { id: 'b', text: 'safe note', capturedAt: 6, copies: 1 },
    ],
  });
  const storage = memStorage(doc);
  const { svc } = make({ storage });
  await svc.init();
  assert.deepEqual(svc.list().map((e) => e.preview), ['safe note']);
  assert.match(svc.status().warning, /dropped/);
});

// ---------- size bounds ----------

test('text longer than maxChars is skipped, not truncated', async () => {
  const { svc, reader } = make({ maxChars: 10 });
  await svc.setEnabled(true);
  reader.set('x'.repeat(11));
  assert.equal(await svc.capture(), 'too-large');
  assert.equal(svc.status().count, 0);
  reader.set('x'.repeat(10));
  assert.equal(await svc.capture(), 'added');
});

test('preview collapses whitespace and is capped at previewChars', async () => {
  const { svc, reader } = make();
  await svc.setEnabled(true);
  reader.set('line one\n\n   line two  ' + 'z'.repeat(300));
  await svc.capture();
  const [entry] = svc.list();
  assert.ok(entry.preview.startsWith('line one line two'));
  assert.equal(entry.preview.length, CLIPBOARD_LIMITS.previewChars);
  assert.equal(svc.get(entry.id), 'line one\n\n   line two  ' + 'z'.repeat(300), 'get() returns full text');
});

test('maxEntries bounds history and drops the oldest entries first', async () => {
  const { svc, reader, clock } = make({ maxEntries: 3 });
  await svc.setEnabled(true);
  for (const t of ['one', 'two', 'three', 'four']) {
    reader.set(t); await svc.capture(); clock.advance(10);
  }
  assert.deepEqual(svc.list().map((e) => e.preview), ['four', 'three', 'two']);
  assert.equal(svc.status().count, 3);
});

test('limits are clamped into their allowed ranges', () => {
  const low = make({ maxEntries: 0, retentionMs: 1, maxChars: -5 }).svc.status();
  assert.equal(low.maxEntries, CLIPBOARD_LIMITS.maxEntries.min);
  assert.equal(low.retentionMs, CLIPBOARD_LIMITS.retentionMs.min);
  assert.equal(low.maxChars, CLIPBOARD_LIMITS.maxChars.min);
  const high = make({ maxEntries: 1e9, retentionMs: 1e15, maxChars: 1e9 }).svc.status();
  assert.equal(high.maxEntries, CLIPBOARD_LIMITS.maxEntries.max);
  assert.equal(high.retentionMs, CLIPBOARD_LIMITS.retentionMs.max);
  assert.equal(high.maxChars, CLIPBOARD_LIMITS.maxChars.max);
  const dflt = make().svc.status();
  assert.equal(dflt.maxEntries, CLIPBOARD_LIMITS.maxEntries.default);
  assert.equal(dflt.retentionMs, CLIPBOARD_LIMITS.retentionMs.default);
  assert.equal(dflt.maxChars, CLIPBOARD_LIMITS.maxChars.default);
});

// ---------- retention and purge ----------

test('entries older than the retention window are pruned on list and capture', async () => {
  const { svc, reader, clock } = make({ retentionMs: 60_000 });
  await svc.setEnabled(true);
  reader.set('old'); await svc.capture();
  clock.advance(59_000);
  reader.set('newer'); await svc.capture();
  clock.advance(2_000); // "old" is now 61s old, "newer" is 2s old
  assert.deepEqual(svc.list().map((e) => e.preview), ['newer']);
  assert.equal(svc.status().count, 1);
});

test('purge removes every entry, keeps history enabled, and allows the same text again', async () => {
  const storage = memStorage();
  const { svc, reader } = make({ storage });
  await svc.setEnabled(true);
  reader.set('keep?'); await svc.capture();
  await svc.purge();
  assert.equal(svc.status().count, 0);
  assert.equal(svc.status().enabled, true);
  assert.equal(await svc.capture(), 'added', 'purge forgets the last fingerprint');
});

test('remove deletes one entry and reports whether it existed', async () => {
  const { svc, reader, clock } = make();
  await svc.setEnabled(true);
  reader.set('a'); await svc.capture(); clock.advance(1);
  reader.set('b'); await svc.capture();
  const [bEntry, aEntry] = svc.list().map((e) => e.id);
  assert.equal(await svc.remove(aEntry), true);
  assert.equal(await svc.remove('no-such-id'), false);
  assert.deepEqual(svc.list().map((e) => e.preview), ['b']);
  assert.equal(svc.get(aEntry), null);
  assert.equal(svc.get(bEntry), 'b');
});

// ---------- persistence ----------

test('without storage, nothing is persisted and status says so', async () => {
  const { svc } = make();
  assert.equal(svc.status().persisted, false);
});

test('state round-trips through storage: enabled flag and entries survive a restart', async () => {
  const storage = memStorage();
  const first = make({ storage });
  await first.svc.setEnabled(true);
  first.reader.set('persist me'); await first.svc.capture();
  assert.ok(storage.writes >= 2, 'each mutation is written');

  const second = make({ storage });
  await second.svc.init();
  assert.equal(second.svc.status().enabled, true);
  assert.deepEqual(second.svc.list().map((e) => e.preview), ['persist me']);
  assert.equal(second.svc.status().persisted, true);
});

test('a corrupt or foreign stored document is ignored, starts disabled, and warns', async () => {
  for (const bad of ['not json', '[]', JSON.stringify({ schemaVersion: 99, enabled: true, entries: [] })]) {
    const storage = memStorage(bad);
    const { svc } = make({ storage });
    await svc.init();
    assert.equal(svc.status().enabled, false, `bad doc: ${bad}`);
    assert.equal(svc.status().count, 0);
    assert.ok(svc.status().warning, `warning for: ${bad}`);
  }
});

test('invalid entries in storage are dropped individually', async () => {
  const doc = JSON.stringify({
    schemaVersion: CLIPBOARD_SCHEMA_VERSION,
    enabled: true,
    entries: [
      { id: 'ok', text: 'valid', capturedAt: 1, copies: 1 },
      { id: 'no-text', capturedAt: 1, copies: 1 },
      { id: 'zero-copies', text: 'x', capturedAt: 1, copies: 0 },
      { id: 'bad-time', text: 'y', capturedAt: 'soon', copies: 1 },
    ],
  });
  const { svc } = make({ storage: memStorage(doc) });
  await svc.init();
  assert.deepEqual(svc.list().map((e) => e.id), ['ok']);
  assert.match(svc.status().warning, /3 stored/);
});

test('load applies retention to restored entries', async () => {
  const now = 10_000_000;
  const doc = JSON.stringify({
    schemaVersion: CLIPBOARD_SCHEMA_VERSION,
    enabled: true,
    entries: [{ id: 'stale', text: 'ancient', capturedAt: now - 10 * 24 * 60 * 60 * 1000, copies: 1 }],
  });
  const { svc } = make({ storage: memStorage(doc), clock: fakeClock(now) });
  await svc.init();
  assert.equal(svc.status().count, 0);
});

test('a failed write keeps working in memory and surfaces lastError', async () => {
  const storage = memStorage();
  const { svc, reader } = make({ storage });
  storage.failWrite = true;
  await svc.setEnabled(true);
  reader.set('still captured'); assert.equal(await svc.capture(), 'added');
  assert.equal(svc.list()[0].preview, 'still captured');
  assert.match(svc.status().lastError, /disk full/);
  storage.failWrite = false;
  reader.set('recovered'); await svc.capture();
  assert.equal(svc.status().lastError, undefined, 'a later successful write clears the error');
});

test('a failed load starts empty and reports the error instead of throwing', async () => {
  const storage = memStorage('{}');
  storage.failRead = true;
  const { svc } = make({ storage });
  await svc.init();
  assert.equal(svc.status().enabled, false);
  assert.match(svc.status().lastError, /read denied/);
});

test('concurrent captures are serialized and none are lost', async () => {
  const storage = memStorage();
  const { svc, clock } = make({ storage });
  await svc.setEnabled(true);
  // Each readText() call returns the next value, so every capture sees a distinct clipboard state.
  const texts = ['c1', 'c2', 'c3', 'c4'];
  let next = 0;
  const reader = { readText: async () => { await Promise.resolve(); return texts[next++]; } };
  const concurrent = new ClipboardHistory({ reader, storage, now: clock.now, newId });
  await concurrent.setEnabled(true);
  const outcomes = await Promise.all(texts.map(() => concurrent.capture()));
  assert.deepEqual(outcomes, ['added', 'added', 'added', 'added']);
  assert.deepEqual(concurrent.list().map((e) => e.preview), ['c4', 'c3', 'c2', 'c1']);
  const saved = JSON.parse(storage.doc);
  assert.equal(saved.entries.length, 4, 'every mutation reached storage');
});

// ---------- boundary and wiring ----------

test('the service module never imports Electron or touches a real clipboard API', () => {
  const src = fs.readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(src, /from ['"]electron['"]/);
  assert.doesNotMatch(src, /clipboard\.(readText|writeText|read|write)\b/);
  assert.doesNotMatch(src, /child_process|powershell/i);
});

test('the module exports the interface native and API owners need', () => {
  assert.equal(typeof ClipboardHistory, 'function');
  assert.equal(typeof looksSensitive, 'function');
  assert.equal(CLIPBOARD_SCHEMA_VERSION, 1);
  const svc = make().svc;
  for (const m of ['init', 'status', 'setEnabled', 'capture', 'list', 'get', 'remove', 'purge']) {
    assert.equal(typeof svc[m], 'function', `method ${m}`);
  }
});
