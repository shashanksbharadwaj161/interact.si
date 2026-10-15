// Goal 113: state.json, backups and pre-import backups encrypted at rest. Bundles the real store + atRest modules; the
// filesystem is in memory and the cipher is the test-only memoryCipher (no Electron import).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'at-rest-entry.ts',
    loader: 'ts',
    contents: `
      export * as atRest from './electron/services/atRest.ts';
      export * as store from './electron/services/store.ts';
      export * as validation from './electron/services/validation.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const {atRest, store: storeMod, validation} = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

function memFs() {
  const files = new Map();
  return {
    files,
    mkdir: async () => {},
    readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    readdir: async (p) => [...files.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k)),
    unlink: async (p) => { files.delete(p); },
  };
}

const DIR = path.join('C:\\', 'appdata', 'dc');
const STATE = path.join(DIR, 'state.json');
const BACKUPS = path.join(DIR, 'backups');
const SECRET_NOTE = 'my private diary entry 4711';
let clock = Date.parse('2026-10-14T10:00:00Z');
function newStore(fs, cipher) {
  let n = 0;
  return new storeMod.Store({dir: DIR, fs, cipher, now: () => new Date(clock), newId: () => `id${++n}`});
}
function legacyFile() {
  const state = validation.defaultState();
  state.notes.push({id: 'n1', title: 'Diary', body: SECRET_NOTE, tags: [], updatedAt: '2026-10-01T00:00:00.000Z'});
  return JSON.stringify({schemaVersion: 1, savedAt: '2026-10-01T00:00:00.000Z', state});
}

test('wrap/unwrap round trip and descriptive rejection of truncated, non-base64 and wrong-version blobs', () => {
  const c = atRest.memoryCipher();
  const plain = JSON.stringify({hello: 'café 東京 🚀'});
  const blob = atRest.wrapEncrypted(plain, c);
  assert.ok(blob.startsWith('desktop-companion-encrypted-state v1\n'));
  assert.equal(atRest.isEncryptedBlob(blob), true);
  assert.equal(atRest.isEncryptedBlob(plain), false);
  assert.ok(!blob.includes('hello'));
  assert.equal(atRest.unwrapEncrypted(blob, c), plain);
  const err = (raw, kind, re) => assert.throws(() => atRest.unwrapEncrypted(raw, c), (e) => e instanceof atRest.AtRestError && e.kind === kind && re.test(e.message));
  err('desktop-companion-encrypted-state v1\n', 'format', /truncated/);
  err('desktop-companion-encrypted-state v1', 'format', /header/);
  err('desktop-companion-encrypted-state v1\n' + blob.split('\n')[1].slice(0, -3), 'format', /truncated|base64/);
  err('desktop-companion-encrypted-state v1\n%%%not base64%%%', 'format', /base64/);
  err(blob.replace(' v1\n', ' v2\n'), 'version', /version 2/);
  err('{"schemaVersion":1}', 'format', /not an encrypted/);
  // A different key (another profile) is a key error with a user-safe message, not the raw library error.
  assert.throws(() => atRest.unwrapEncrypted(blob, atRest.memoryCipher({key: 7})), (e) => e.kind === 'key' && !/memory cipher/.test(e.message));
  assert.throws(() => atRest.unwrapEncrypted(blob, atRest.memoryCipher({available: false})), (e) => e.kind === 'unavailable');
  assert.throws(() => atRest.wrapEncrypted('x'.repeat(atRest.AT_REST_LIMITS.plaintextChars + 1), c), (e) => e.kind === 'size');
});

test('createSafeStorageCipher wraps a safeStorage-like object and reports unavailability without throwing', () => {
  const ss = {isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('X' + s), decryptString: (b) => b.toString().slice(1)};
  const c = atRest.createSafeStorageCipher(ss);
  assert.equal(c.available(), true);
  assert.equal(atRest.unwrapEncrypted(atRest.wrapEncrypted('abc', c), c), 'abc');
  assert.equal(atRest.createSafeStorageCipher({...ss, isEncryptionAvailable: () => { throw new Error('not ready'); }}).available(), false);
  assert.equal(atRest.createSafeStorageCipher(undefined).available(), false);
});

test('plaintext legacy file migrates to encrypted on first persist, once, and reloads intact', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  const c = atRest.memoryCipher();
  const s = newStore(fs, c);
  const r = await s.load();
  assert.deepEqual(r, {recovered: false, readOnly: false});
  const disk = fs.files.get(STATE);
  assert.ok(atRest.isEncryptedBlob(disk));
  assert.ok(!disk.includes(SECRET_NOTE) && !disk.includes('Diary'));
  const migrated = s.snapshot().activity.filter((a) => a.summary === 'Local data is now encrypted at rest with an operating-system protected key');
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].kind, 'recovery');

  const again = newStore(fs, c);
  assert.deepEqual(await again.load(), {recovered: false, readOnly: false});
  const st = again.snapshot();
  assert.equal(st.notes[0].body, SECRET_NOTE);
  assert.equal(st.activity.filter((a) => /encrypted at rest/.test(a.summary)).length, 1, 'migration line is pushed exactly once');
  await again.mutate((d) => { d.notes[0].title = 'Changed'; });
  assert.ok(!fs.files.get(STATE).includes('Changed'));
  const third = newStore(fs, c);
  await third.load();
  assert.equal(third.snapshot().notes[0].title, 'Changed');
});

test('cipher unavailable on an encrypted file: read-only, exact warning, file bytes untouched, nothing written', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  await newStore(fs, atRest.memoryCipher()).load();
  const before = new Map(fs.files);
  for (const cipher of [atRest.memoryCipher({available: false}), undefined, atRest.memoryCipher({key: 9})]) {
    const s = newStore(fs, cipher);
    const r = await s.load();
    assert.deepEqual(r, {recovered: false, readOnly: true, warning: 'Local data is encrypted for another user profile or the protection key is unavailable; nothing was changed'});
    assert.equal(s.isReadOnly, true);
    await assert.rejects(s.mutate((d) => { d.notes = []; }), /read-only/);
    await assert.rejects(s.backup('auto'), /read-only/);
    assert.equal(await s.addActivity('x', 'y'), null);
    assert.deepEqual([...fs.files.entries()], [...before.entries()], 'no file written, renamed or recovered');
  }
});

test('corrupted encrypted file recovers from an encrypted backup; backups and pre-import backups are encrypted', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  const c = atRest.memoryCipher();
  const s = newStore(fs, c);
  await s.load();
  clock += 11 * 60 * 1000;
  await s.mutate((d) => { d.tasks.push({id: 't1', title: 'Backed up task', done: false, createdAt: '2026-10-14T10:00:00.000Z'}); });
  const exported = s.exportDocument();
  clock += 1000;
  await s.importDocument(exported);
  const names = await fs.readdir(BACKUPS);
  assert.ok(names.some((n) => n.startsWith('state-')) && names.some((n) => n.startsWith('pre-import-')), names.join(','));
  for (const n of names) {
    const raw = fs.files.get(path.join(BACKUPS, n));
    assert.ok(atRest.isEncryptedBlob(raw), `${n} is encrypted`);
    assert.ok(!raw.includes(SECRET_NOTE) && !raw.includes('Backed up task'));
  }
  // Damage the main file: truncated ciphertext.
  const blob = fs.files.get(STATE);
  fs.files.set(STATE, blob.slice(0, Math.floor(blob.length / 2)) + '!!');
  clock += 1000;
  const r = await newStore(fs, c).load();
  assert.equal(r.recovered, true);
  assert.match(r.warning, /restored from a backup/);
  const restored = newStore(fs, c);
  await restored.load();
  assert.equal(restored.snapshot().notes[0].body, SECRET_NOTE);
  assert.ok(restored.snapshot().tasks.some((t) => t.title === 'Backed up task'));
  assert.ok(atRest.isEncryptedBlob(fs.files.get(STATE)));
  const corrupt = [...fs.files.keys()].find((k) => path.basename(k).startsWith('state.corrupt-'));
  assert.ok(corrupt, 'damaged file kept aside');
  // Undecryptable (well-formed) main file with a decryptable backup -> recover, not lock.
  const wrongKeyBlob = atRest.wrapEncrypted(legacyFile(), atRest.memoryCipher({key: 3}));
  fs.files.set(STATE, wrongKeyBlob);
  clock += 1000;
  const r2 = await newStore(fs, c).load();
  assert.equal(r2.recovered, true);
  assert.equal(r2.readOnly, false);
});

test('export documents stay plaintext and import accepts them unchanged', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  const s = newStore(fs, atRest.memoryCipher());
  await s.load();
  const doc = s.exportDocument();
  assert.equal(atRest.isEncryptedBlob(doc), false);
  const parsed = JSON.parse(doc);
  assert.equal(parsed.format, 'jarvis-export');
  assert.equal(parsed.state.notes[0].body, SECRET_NOTE);
  const state = await s.importDocument(doc);
  assert.equal(state.notes[0].body, SECRET_NOTE);
});

test('without a cipher the store keeps writing plaintext as before; a newer encrypted format is opened read-only', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  const s = newStore(fs, undefined);
  await s.load();
  assert.ok(fs.files.get(STATE).includes(SECRET_NOTE));
  assert.ok(!s.snapshot().activity.some((a) => /encrypted at rest/.test(a.summary)));

  const fs2 = memFs();
  const c = atRest.memoryCipher();
  const future = atRest.wrapEncrypted(legacyFile(), c).replace(' v1\n', ' v2\n');
  fs2.files.set(STATE, future);
  const s2 = newStore(fs2, c);
  const r = await s2.load();
  assert.equal(r.readOnly, true);
  assert.equal(fs2.files.get(STATE), future);
  assert.equal(fs2.files.size, 1);
});

test('legacy plaintext backups are re-encrypted during migration', async () => {
  const fs = memFs();
  fs.files.set(STATE, legacyFile());
  fs.files.set(path.join(BACKUPS, 'state-20261013-090000.json'), legacyFile());
  fs.files.set(path.join(BACKUPS, 'pre-import-20261012-090000.json'), legacyFile());
  await newStore(fs, atRest.memoryCipher()).load();
  for (const n of await fs.readdir(BACKUPS)) assert.ok(atRest.isEncryptedBlob(fs.files.get(path.join(BACKUPS, n))), n);
  assert.ok(![...fs.files.keys()].some((k) => k.endsWith('.tmp')));
});
