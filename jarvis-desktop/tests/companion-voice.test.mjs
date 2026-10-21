// Voice for the companion island: its own island-only IPC over the same local Windows speech as the hub, owner-tagged so
// each surface stops only its own audio, an audio-only microphone permission for the island page (never the selection
// overlay or another page), and the renderer adapters Codex wires into CompanionApp. No Electron, no microphone, no
// PowerShell: the speech helper and the desktop are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'companion-voice-entry.ts',
    loader: 'ts',
    contents: `
      export * as core from './electron/companionCore.ts';
      export { ARG_SPECS } from './electron/ipcCore.ts';
      export { LIMITS } from './electron/services/validation.ts';
      export { Speech } from './electron/services/speech.ts';
      export { createBackend } from './electron/backend.ts';
      export { companionVoiceBackend } from './src/voice/backends.ts';
      export { capsFromStatus } from './src/voice/companion.ts';
      export { VoiceSession } from './src/voice/session.ts';
      export { createMicConsent } from './src/ui/audio.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', external: ['electron'],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise((r) => setImmediate(r));
const VOICE = ['companionVoiceStatus', 'companionTranscribe', 'companionTranscribeCancel', 'companionSpeak', 'companionSpeechStop'];

test('the island has its own voice methods, island only, bounded exactly like the hub', () => {
  for (const v of VOICE) {
    assert.ok(m.core.COMPANION_METHODS.includes(v), v);
    assert.ok(!m.core.OVERLAY_METHODS.includes(v), `${v} is not callable from the selection overlay`);
  }
  assert.equal(m.core.COMPANION_ARG_SPECS.companionTranscribe[0].max, m.ARG_SPECS.transcribe[0].max, 'same WAV bound as the hub');
  assert.equal(m.core.COMPANION_SPEAK_MAX, m.LIMITS.speakChars, 'same read-aloud bound as the hub');
  assert.equal(m.core.COMPANION_WAV_MAX, 44 + m.LIMITS.audioSamples * 2 + 1024);
  const v = (method, args) => m.core.COMPANION_ARG_SPECS[method].length >= args.length && args.every((a, i) => {
    const s = m.core.COMPANION_ARG_SPECS[method][i];
    return s.kind === 'string' ? typeof a === 'string' && a.length >= (s.min ?? 0) && a.length <= s.max : s.kind === 'numbers' ? Array.isArray(a) && a.length <= s.max : false;
  });
  assert.equal(v('companionSpeak', ['']), false, 'empty text is refused at the edge');
  assert.equal(v('companionSpeak', ['x'.repeat(4001)]), false);
  assert.equal(v('companionTranscribe', [new Array(m.core.COMPANION_WAV_MAX + 1).fill(0)]), false);
  assert.deepEqual(m.core.COMPANION_ARG_SPECS.companionSpeechStop, []);
});

test('microphone permission: audio only, for the hub page or the island itself; nothing else', () => {
  const allow = (o) => m.core.mediaPermissionAllowed({ permission: 'media', mediaTypes: ['audio'], hubPage: false, islandPage: false, voiceInput: true, ...o });
  assert.equal(allow({ hubPage: true }), true);
  assert.equal(allow({ islandPage: true }), true);
  assert.equal(allow({ islandPage: true, voiceInput: false }), false, 'native policy overrides a trusted page');
  assert.equal(allow({ hubPage: true, voiceInput: undefined }), false, 'missing policy fails closed');
  assert.equal(allow({}), false, 'another page, or the selection overlay (not the island webContents)');
  assert.equal(allow({ islandPage: true, mediaTypes: ['video'] }), false, 'no camera');
  assert.equal(allow({ islandPage: true, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allow({ islandPage: true, mediaTypes: [] }), false);
  assert.equal(allow({ islandPage: true, permission: 'display-capture' }), false, 'no screen capture through this path');
  assert.equal(allow({ hubPage: true, permission: 'geolocation' }), false);
  const main = readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  assert.match(main, /mediaPermissionAllowed\(\{permission, mediaTypes: d\.mediaTypes, hubPage: appUrlOk\(url\), islandPage: companion\?\.isIsland\(wc, url\) === true, voiceInput: voiceAllowed\(\)\}\)/);
  const win = readFileSync(path.join(root, 'electron/companionWindow.ts'), 'utf8');
  assert.match(win, /isIsland: \(wc: Electron\.WebContents \| null \| undefined, url: string\) => !!wc && !!island && !island\.isDestroyed\(\) && wc\.id === island\.webContents\.id && trusted\(url\)/);
});

test('owner tags: each surface stops only its own speech and transcription; an untagged stop (dispose) stops all', async () => {
  const pending = [];
  const sp = new m.Speech({
    native: {
      probeSpeech: async () => ({ voices: ['V'], recognizers: ['en-US'] }),
      speak: (text, voice, signal) => new Promise((resolve) => { pending.push(text); signal.addEventListener('abort', () => resolve({ ok: true }), { once: true }); }),
      transcribe: () => new Promise(() => {}),
    },
    settings: () => ({ voice: '' }), tmpDir: 'C:\\tmp', newId: () => 'x', writeFile: async () => undefined, removeFile: async () => undefined,
  });
  const island = sp.speak('from the island', { owner: 'companion' });
  await tick();
  assert.equal(sp.cancel('hub'), false, 'the hub cannot stop the island voice');
  assert.equal(sp.cancel('companion'), true);
  assert.deepEqual(await island, { ok: false, reason: 'Speech was stopped' });
  const hub = sp.speak('from the hub', { owner: 'hub' });
  await tick();
  assert.equal(sp.cancel('companion'), false);
  assert.equal(sp.cancel(), true, 'dispose stops whatever plays');
  await hub;
  const wav = [82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, ...new Array(32).fill(0)];
  wav[20] = 1;
  void sp.transcribe(wav, { owner: 'hub' }).catch(() => undefined);
  await tick(); await tick();
  assert.equal(sp.cancelTranscribe('companion'), false, 'the island cannot cancel the hub transcription');
  assert.equal(sp.cancelTranscribe('hub'), true);
});

test('the real backend: the island voice reports local engines, and hub and island stops stay separate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-cvoice-'));
  const spoken = [];
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no'); }, decryptString: () => { throw new Error('no'); } },
    native: {
      listWindows: async () => [], dpapi: async () => ({ ok: true }),
      probeSpeech: async () => ({ voices: ['Voice A'], recognizers: [] }),
      speak: (text, voice, signal) => new Promise((resolve) => { spoken.push(text); signal?.addEventListener('abort', () => resolve({ ok: true }), { once: true }); }),
    },
    shell: { spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {} },
    dialogs: { openImport: async () => null, pick: async () => null, saveExport: async () => null },
    confirm: async () => false,
    fetchImpl: async () => { throw new Error('no network in this test'); },
  });
  try {
    const st = await b.companion.voice.status();
    assert.deepEqual(st, { stt: { available: false, reason: 'No Windows speech recognizer is installed' }, tts: { available: true }, voice: null, speaking: false, transcribing: false, cloud: false, inputAllowed: false });
    const island = b.companion.voice.speak('island reply');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await b.companion.voice.status()).speaking, true);
    assert.equal(await b.speechStop(), false, "the hub's Stop does not end the island's speech");
    assert.equal(b.companion.voice.stop(), true);
    assert.deepEqual(await island, { ok: false, reason: 'Speech was stopped' });
    assert.deepEqual(spoken, ['island reply']);
    assert.match((await b.companion.voice.transcribe([1, 2, 3])).reason, /microphone is off/, 'policy off: nothing is transcribed');
    await b.companion.voice.setInput(true, async () => true);
    assert.match((await b.companion.voice.transcribe([1, 2, 3])).reason, /No Windows speech recognizer/, 'no recognizer: an honest reason, no text');
  } finally {
    await b.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('island wiring: handlers reach only the backend voice, and closing the bubble or the island stops it', () => {
  const win = readFileSync(path.join(root, 'electron/companionWindow.ts'), 'utf8');
  for (const [method, call] of [['companionVoiceStatus', 'status()'], ['companionTranscribe', 'transcribe(audio)'], ['companionTranscribeCancel', 'cancelTranscribe()'], ['companionSpeak', 'speak(text)'], ['companionSpeechStop', 'stop()']]) {
    assert.ok(win.includes(`${method}: `) && win.includes(`deps.backend.companion.voice.${call}`), method);
  }
  assert.match(win, /const stopVoice = \(\) => \{ deps\.backend\.companion\.voice\.stop\(\); deps\.backend\.companion\.voice\.cancelTranscribe\(\); \};/);
  assert.equal((win.match(/stopVoice\(\);/g) ?? []).length, 4, 'bubble closed, island closed, OS lock event, dispose');
  const pre = readFileSync(path.join(root, 'electron/companionPreload.ts'), 'utf8');
  for (const [k, ch] of [['voiceStatus', 'companionVoiceStatus'], ['transcribe', 'companionTranscribe'], ['transcribeCancel', 'companionTranscribeCancel'], ['speak', 'companionSpeak'], ['speechStop', 'companionSpeechStop']]) {
    assert.match(pre, new RegExp(`\\b${k}: \\([^)]*\\) => call\\('${ch}'`), k);
  }
});

test('renderer adapters: companionVoiceBackend maps window.companion, capsFromStatus never reports an unchecked engine as ready', async () => {
  assert.equal(m.companionVoiceBackend(null), null);
  assert.equal(m.companionVoiceBackend({}), null);
  const calls = [];
  const api = { transcribe: async (w) => (calls.push(['transcribe', w.length]), { text: 'hello' }), transcribeCancel: async () => (calls.push(['transcribeCancel']), true), speak: async (t) => (calls.push(['speak', t]), { ok: true }), speechStop: async () => (calls.push(['speechStop']), true) };
  const be = m.companionVoiceBackend(api);
  await be.transcribe([1, 2]); await be.cancelTranscribe(); await be.speak('x'); await be.stopSpeaking();
  assert.deepEqual(calls, [['transcribe', 2], ['transcribeCancel'], ['speak', 'x'], ['speechStop']]);
  assert.deepEqual(m.capsFromStatus(null), { stt: null, tts: null });
  assert.deepEqual(m.capsFromStatus(null, 'Speech could not be checked.'), { stt: { available: false, reason: 'Speech could not be checked.' }, tts: { available: false, reason: 'Speech could not be checked.' } });
  const caps = m.capsFromStatus({ stt: { available: true }, tts: { available: false, reason: 'No Windows voices are installed' }, voice: null, speaking: false, transcribing: false, cloud: false });
  assert.deepEqual(caps, { stt: { available: true, reason: undefined }, tts: { available: false, reason: 'No Windows voices are installed' } });
  // The same session class drives the island: unchecked engines block listening with a reason.
  const c = m.createMicConsent(null);
  c.grant();
  const s = new m.VoiceSession({ backend: be, consent: c, support: { supported: true }, caps: () => m.capsFromStatus(null) });
  assert.equal(s.blocks().listen.code, 'engine');
  assert.match(s.blocks().listen.reason, /not been checked/);
});
