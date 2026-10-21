// Native microphone policy, enforced in main for transcription: nothing is transcribed while the microphone is off;
// turning it off (from the island or from hub Settings) ends a transcription in progress and its text is discarded; a
// pending Allow that is answered after an Off never turns the microphone back on; the temporary audio file is removed
// whether the transcription finishes, fails or is cancelled. Fake native helpers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm, readdir, access} from 'node:fs/promises';
const exists = (f) => access(f).then(() => true, () => false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {resolveDir: root, sourcefile: 'voice-policy-entry.ts', loader: 'ts', contents: `export { createBackend } from './electron/backend.ts';`},
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

/** A short 16 kHz mono PCM WAV with audible samples, as the renderer sends it (array of bytes). */
function wav(ms = 1200) {
  const n = Math.round(16 * ms);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  return [...b];
}

async function backend() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-voicepolicy-'));
  const tmp = path.join(dir, 'tmp');
  await (await import('node:fs/promises')).mkdir(tmp);
  const log = {transcribe: [], release: null};
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: tmp, selfPids: () => [999],
    safeStorage: {isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no'); }, decryptString: () => { throw new Error('no'); }},
    native: {
      listWindows: async () => [], dpapi: async () => ({ok: true}),
      probeSpeech: async () => ({voices: ['Voice A'], recognizers: ['en-US']}),
      // The native helper cannot be aborted: it settles when the test releases it.
      transcribe: (file) => { log.transcribe.push(file); return new Promise((resolve) => { log.release = () => resolve({text: 'secret words'}); }); },
    },
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => true,
    fetchImpl: async () => { throw new Error('no network'); },
  });
  // On Linux the helper's Windows-style temp path resolves in the working directory: remove any such file too.
  return {b, tmp, log, close: async () => { await b.dispose(); await new Promise((r) => setTimeout(r, 30)); for (const f of log.transcribe) await rm(f, {force: true}); await rm(dir, {recursive: true, force: true}); }};
}
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('while the microphone is off nothing is transcribed and no audio file is written', async () => {
  const f = await backend();
  try {
    for (const r of [await f.b.transcribe(wav()), await f.b.companion.voice.transcribe(wav())]) assert.match(r.reason, /microphone is off/);
    assert.equal(f.log.transcribe.length, 0);
    assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.close(); }
});

test('turning the microphone off in the island ends a transcription in progress; its text is discarded; the file is removed', async () => {
  const f = await backend();
  try {
    await f.b.companion.voice.setInput(true, async () => true);
    const pending = f.b.companion.voice.transcribe(wav());
    await until(() => f.log.transcribe.length === 1);
    assert.equal(await exists(f.log.transcribe[0]), true, 'the audio exists only while the helper runs');
    await f.b.companion.voice.setInput(false, async () => { throw new Error('Off needs no confirmation'); });
    f.log.release();
    const r = await pending;
    assert.equal(r.text, '', 'revocation wins over a result that arrives later');
    assert.equal(r.cancelled, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await exists(f.log.transcribe[0]), false, 'temporary audio removed after the helper settled');
  } finally { await f.close(); }
});

test('turning it off in hub Settings ends the island transcription too', async () => {
  const f = await backend();
  try {
    await f.b.saveSettings({voiceInput: true});
    assert.equal(f.b.companion.voice.inputAllowed(), true);
    const pending = f.b.companion.voice.transcribe(wav());
    await until(() => f.log.transcribe.length === 1);
    await f.b.saveSettings({voiceInput: false});
    f.log.release();
    assert.deepEqual([(await pending).text, (await pending).cancelled], ['', true]);
  } finally { await f.close(); }
});

test('an Allow answered after an Off never turns the microphone back on, and a finished transcription cleans up', async () => {
  const f = await backend();
  try {
    let answer;
    const allow = f.b.companion.voice.setInput(true, () => new Promise((r) => { answer = r; }));
    await until(() => !!answer);
    await f.b.saveSettings({voiceInput: false});
    answer(true);
    assert.equal((await allow).allowed, false);
    assert.equal(f.b.companion.voice.inputAllowed(), false);
    await f.b.companion.voice.setInput(true, async () => true);
    const done = f.b.companion.voice.transcribe(wav());
    await until(() => f.log.transcribe.length === 1);
    f.log.release();
    assert.deepEqual(await done, {text: 'secret words'});
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await exists(f.log.transcribe[0]), false);
  } finally { await f.close(); }
});
