# Voice: listening, transcribing and reading aloud (17 Oct 2026)

This covers branch `claude/compassionate-hawking-m9x36g` in the Linux cloud session.

- **Run here:** unit tests, a browser journey with Chromium's fake microphone, and the Electron smoke under Xvfb.
- **Not run:** nothing has run on Windows. No real speech was recognized or spoken.

## Audit: what existed and what was broken

### The supported path

This was already present and stays the only one.

- **Recording:** the renderer records with `MediaRecorder` and encodes 16 kHz mono PCM16 WAV (`src/ui/audio.ts` `ClipRecorder`).
- **Recognition:** `transcribe` sends the WAV to the main process. Windows System.Speech recognizes it with the native PowerShell helper (`electron/services/speech.ts`, `native/transcribe.ps1`).
- **Read-aloud:** `speak` uses Windows SAPI through `native/speak.ps1`.
- **Locality:** `cloud: false`. No online speech provider exists.
- **Permission:** the session permission handler allows only audio, and only for the app page.

### What was missing or wrong

1. **No way to stop read-aloud or cancel a transcription from the UI.**
   - `Speech.cancel()` and `Speech.cancelTranscribe()` existed, but no IPC reached them.
   - The UI said "There is no stop control for playback yet."
2. **Voice state lived inside the 1600-line `Assistant.tsx`.**
   - Nothing could be reused by the companion island.
   - A cancelled transcription still kept the Windows helper busy, so the next recording was refused with "Another transcription is already running."
   - Leaving the page did not stop read-aloud.
   - Hiding the window kept a recording going that nobody could see.
3. **Read-aloud spoke raw Markdown.** Asterisks, link targets and code were read out, and long replies were cut mid-word at 2000 characters.
4. **No live state for transcribing or speaking.** Only a small meter showed while recording. The level re-rendered the whole Assistant page on every change.

### Providers

- Claude stays the text and vision provider.
- **Raw audio is never sent to Claude.** The Messages API has no audio input, and no transcription is invented.
- **No online speech provider was added**, so there is nothing to opt into and no silent fallback.
- An optional local Whisper-style engine exists in `speech.ts` with its own tests. It is **not wired** in `backend.ts`, which constructs `Speech` without engines. Production uses Windows speech only.

## What is built (slice 1: hub Assistant)

### Hub IPC

- `speechStop()` calls `Speech.cancel()` and returns whether something was playing.
- `transcribeCancel()` calls `Speech.cancelTranscribe()`.
- Both take no arguments. Each is listed in all six required places:
  - METHODS
  - ARITY 0
  - ARG_SPECS `[]`
  - the preload
  - optional fields in `JarvisAPI`
  - the backend

  The browser preview bridge returns `false` for both.

### `src/voice/session.ts`: `VoiceSession`

A framework-free controller for one surface. It owns:

- an explicit start;
- listening, with the real level on its own feed;
- local transcription, which only calls the surface's `transcribe`;
- read-aloud of speakable text, cut at a sentence;
- stop and cancel;
- releasing everything on unmount.

How it behaves:

- **Cancel during transcription** tells the backend and discards the text. The next clip waits for the engine to be free instead of being refused.
- **Pressing Talk while reading aloud** stops the voice first, so the microphone does not record it.
- **Hiding the window** cancels a recording.
- **Turning the consent switch off** cancels at once.

### Supporting modules

- `src/voice/useVoiceSession.ts` is the React hook. Unmounting releases the session; it also handles `visibilitychange` and `pagehide`.
- `src/voice/VoiceMeter.tsx` draws real level bars written directly from the feed, with no page re-render.
- `src/voice/backends.ts` holds `hubVoiceBackend(api)`.

### Assistant (`src/components/Assistant.tsx`, `src/styles/voice.css`)

- **The voice bar** above the composer shows each state with its way out:

  | State | Bar shows |
  |---|---|
  | Opening the microphone | Cancel |
  | Listening | real meter, time used / 0:30, Cancel |
  | Transcribing | Cancel, or "waiting for Windows speech to finish the cancelled recording" |
  | Reading aloud | voice name, Stop reading, and whether the text was shortened |

- **Read-aloud controls:**
  - A reply's read-aloud button turns into Stop while that reply is read.
  - The Read aloud drawer has Stop.
  - Esc stops or cancels from the message box.
- **Unchanged contracts:**
  - consent is off by default and separate from the Windows permission;
  - the transcript goes into the message box for review and is never sent automatically;
  - the dictation cleanup step stays.
- **Styles** are scoped to `.vx-*` and do not touch the companion bubble.
  - The perimeter light is red while listening, an energy sweep while transcribing, and violet while reading.
  - Under reduced motion it is a steady ring.
  - Forced colours are handled.

## Evidence

- **`tests/voice-session.test.mjs`:** 17 tests, all passing. One drives the real `createBackend`: `speechStop` ends the speech in flight and reports it.
- **`scripts/voice-journey.mjs`:** 13 of 13 steps pass (`voice/voice-journey.json` and screenshots). It drives the real Assistant in Chromium with the **fake** microphone (a generated tone) and the fixture bridge in `speech: 'scripted'` mode, which returns labelled text and runs no recognizer. It checks:
  - consent before any stream;
  - a real level;
  - a real WAV reaching the bridge;
  - the microphone track ending on stop, cancel, Esc and navigation;
  - cancel reaching the backend and the text being discarded;
  - Stop reaching the backend;
  - Talk interrupting read-aloud;
  - navigation stopping read-aloud;
  - reduced motion;
  - the honest reason when no recognizer exists.
- **Full suite:** 1697 of 1717 tests pass. The 15 failures are the same Windows-path, junction and DPAPI baseline as before.
- **Electron smoke** (Linux, Xvfb): 23 routes, 0 renderer errors, 0 external requests. Speech is honestly unavailable on Linux: "Windows speech could not be queried: Native helper probe-speech.ps1 could not be read".

## Windows checks (add to the QA checklist)

1. **Talk and transcribe.** In Assistant, the microphone panel → turn Allow on. Tap Talk and speak for about 3 seconds. Check:
   - the bar shows Listening with a moving meter;
   - tap again: Transcribing, then the text is in the message box and nothing is sent;
   - the Windows microphone indicator turns off when listening ends.
2. **Cancel and recover.** Repeat, and press Cancel while Transcribing.
   - The text never appears.
   - Talk again at once: the bar may say it is waiting for Windows speech, then the new clip transcribes.
3. **Read aloud and stop.** Send a message and press the reply's speaker button.
   - The voice reads without Markdown symbols.
   - Stop ends the audio within about a second.
   - Talk during reading also stops it.
4. **Navigation and hiding.**
   - Start reading, then switch to Today: the audio stops.
   - Start listening, then minimise to the tray: the recording is cancelled with a note.
5. **No recognizer.** Remove the speech recognizer language, or try a machine without one. Talk is off and the microphone panel names the reason.

## Interface for the companion (Codex)

See the "Voice for the companion" section in `COMPANION-STATUS.md`.
