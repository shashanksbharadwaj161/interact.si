# Voice acceptance checklist — Desktop Companion

Companion to `docs/acceptance.md` section F (F1–F6) and the speech rows of the test table in `docs/resume-integration-plan.md` §4 (`F2`, `F3`). It covers the Windows speech path: detection, recognizer (`transcribe`), read-aloud (`speak`), and push-to-talk (PTT) capture in the renderer.

Item IDs `F1`–`F6` match `docs/acceptance.md`. The other IDs (`V-…`) are added here for detail.

Status column: **Not run** means no one has executed the check. **Static pass** means the code was read and the check holds. **Gap** means a problem was found while writing this list. Nothing on this page has been run on hardware yet.

## 0. Safety rules for every run

- **No automated test opens a microphone.** The `[I]` and `[U]` checks use the probe, a fixture WAV file, or a synthetic WAV. Only the `[M]` checks in section E involve a live microphone, and a human tester runs those.
- **Speakers are audible during section D.** Lower the volume first.
- **Use temporary user data** (the same setup as `scripts/smoke.cjs`). Do not use a real profile.
- **Do not change Windows privacy, sound, or speech settings on the build machine.** Where a check needs a denied or missing microphone, the tester uses a separate test machine or restores the original setting afterwards.
- **Fixtures are original recordings.** `tests/fixtures/clear-english-16k.wav` is recorded by the test owner, 16 kHz mono 16-bit PCM, a short scripted English sentence. No third-party or copyrighted speech.
- **Clean up.** Afterwards, `%TEMP%` must contain no `jarvis-*.wav` files that the run created (see C3).
- Run the `[I]` checks with `JARVIS_NATIVE_TESTS=1`, as in `docs/acceptance.md`.

## A. Prerequisites (record on the sign-off table in section I)

- Windows 11 x64, Windows PowerShell 5.1 (`native/*.ps1` targets it).
- At least one installed, enabled voice (`probe-speech` → `voices`).
- At least one installed recognizer. Record its culture (en-US is the expected one).
- A default output device and a default input device. Only needed for D and E.
- Display scale recorded (100% and 150%) if any UI check is run.

## B. Capability detection (no audio)

| ID | Check | How | Status |
|---|---|---|---|
| V-B1 | `[I]` With ≥1 voice, `tts` is available and has no reason. | Call `probe-speech` through the adapter. Check the capability report. | Not run |
| V-B2 | `[U]` No voices → `tts` unavailable, reason `No Windows voices are installed`. | Fake `probeSpeech` returning `voices: []`. Planned in `tests/speech.test.mjs` (file not yet written). | Not run |
| V-B3 | `[U]` No recognizer → `stt` unavailable, reason `No Windows speech recognizer is installed`. | Fake `probeSpeech` returning `recognizers: []`. | Not run |
| V-B4 | `[U]` Probe throws → both `tts` and `stt` unavailable, reason starts `Windows speech could not be queried:`. | Fake adapter that rejects. | Not run |
| V-B5 | `[I]` `stt` reason lists the recognizer culture(s) and says `Dictation quality is basic.` | Read the capability report on the build machine. | Not run |
| V-B6 | `[M]` A voice installed or removed in Windows shows up after the probe cache expires (30 s) or after restart. Record which one applies. | Change the voice list on the test machine, then reload capabilities. | Gap: the cache has no refresh control (see section H). |
| V-B7 | `[M]` The PTT panel and Settings name recognition "Basic (Windows Speech)". | Open the Assistant PTT panel. | **Gap:** no `Basic (Windows Speech)` string exists in `src/`. The capability is named `Speech recognition (Windows, basic)` (`electron/services/speech.ts`). |

## C. Recognizer (`transcribe`) — F3, F6

Path: `src/ui/audio.ts` encodes WAV → `Assistant.tsx` → `preload` → `speech.transcribe` (`validateAudio`) → writes `jarvis-<randomUUID>.wav` to `os.tmpdir()` → `native/transcribe.ps1` → temp file deleted in `finally`.

| ID | Check | How | Status |
|---|---|---|---|
| F3a | `[I]` `transcribe` on `tests/fixtures/clear-english-16k.wav` returns non-empty text. | Call the backend `transcribe` with the fixture bytes as `number[]`. | Not run — fixture not yet committed (`tests/fixtures/` does not exist). |
| F3b | `[I]` A 1 s silent WAV returns `{text:'', reason:'No speech was recognized'}`. | Generate the silent WAV in the test (no fixture needed). | Not run |
| V-C3 | `[I]` The `jarvis-*.wav` temp file is gone after: success, silence, and an adapter failure. | Count `jarvis-*.wav` in `%TEMP%` before and after each case. | Static pass: `speech.ts` deletes in `finally` (the `finally` covers the adapter throwing). Not run. |
| V-C4 | `[I]` The native helper rejects other file names. | Copy the fixture to `%TEMP%\other-name.wav`, call `native/transcribe.ps1` directly with that path. Expect `Unexpected audio file name`. Delete the copy afterwards. | Not run |
| V-C5 | `[I]` A missing file returns `Audio file not found`. | Call the helper with a non-existent `jarvis-<uuid>.wav` path. | Not run |
| V-C6 | `[U]` No recognizer → `{text:'', reason}` and no temp file written. | Fake `probeSpeech` returning no recognizers; assert the write function is never called. Planned in `speech.test.mjs`. | Static pass (code read); test not written. |
| V-C7 | `[U]` `validateAudio`: RIFF with format tag 1 accepted; non-PCM (format tag ≠ 1) rejected with `Only uncompressed PCM WAV audio is supported`; Int16 samples out of range rejected; 480,000 Int16 samples accepted, 480,001 rejected. | `tests/validation.test.mjs` (planned in the resume plan; file not yet written). | Not run |
| V-C8 | `[I]` The UI's own format (16 kHz, mono, 16-bit) is recognized. | Use the fixture from F3a. | Not run |
| V-C8b | `[I]` **Open question:** a WAV with a different sample rate, channel count, or bit depth. | `validateAudio` checks only the format tag, not rate, channels, or bit depth. Record what `System.Speech` returns for 44.1 kHz stereo 16-bit PCM and 8 kHz mono. The UI never sends these, so this is a boundary check. | Gap: validation is looser than the comment on `validateAudio` implies. Decide whether to tighten it or document it. |
| V-C9 | `[I]` A 30 s clip: the transcript covers the whole clip, including the last phrase. | Use a 30 s original fixture. The loop in `transcribe.ps1` stops after 100 recognition results. | Not run. Risk: a long clip could be cut short. |
| V-C10 | `[I]` Recognizer choice: current UI culture, else en-US, else the first installed. | Read the `recognizer` value the native helper returns. Repeat on a machine with only one recognizer if one is available. | Not run |
| V-C11 | `[I]` A hung recognizer ends with `Native helper timed out` after 60 s, and no `powershell.exe` child stays behind. | Hard to trigger on purpose. Record the result if it happens during other tests; check with `tasklist /FI "IMAGENAME eq powershell.exe"`. | Not run |
| F6 | `[M]` The UI labels recognition "Basic (Windows Speech)" and makes no accuracy claim. | Same as V-B7. | **Gap** (see V-B7). |

## D. Read-aloud (`speak`) — F1, F2

Path: `Assistant.tsx` (UI slices text to 2,000 characters) → `speech.speak` (rejects > 4,000) → `native/speak.ps1` (text on stdin) → `SetOutputToDefaultAudioDevice`.

| ID | Check | How | Status |
|---|---|---|---|
| F1a | `[I]` `speak('test')` with the default voice returns `{ok:true}` and is heard on the default output. | Tester listens; the check is manual on top of the automated return value. | Not run |
| F1b | `[I]` Voice `No Such Voice` returns `{ok:false, reason}` and the reason names the voice (`Voice 'No Such Voice' is not installed`). | Call `speak` with that voice. | Not run |
| F2a | `[U]` Empty or whitespace text → `ValidationError('text is required')`, no native call. | `tests/speech.test.mjs` (planned). | Not run |
| F2b | `[U]` Text over 4,000 characters is rejected before any native call. | Same. | Not run |
| F2c | `[U]` Text is passed on stdin, never on the command line. | Planned `tests/runner.test.mjs` (G11 argv check; file not yet written). | Not run |
| V-D2d | `[U]` A second `speak` supersedes the first. The first resolves to `{ok:false, reason:'Superseded by newer speech'}`. | Start two `speak` calls with a fake adapter that waits on the abort signal. | Static pass (`speech.ts`); test not written. |
| V-D3 | `[I]` The PowerShell child is gone after a normal finish and after a supersede. | `tasklist` filter for `powershell.exe` before and after. | Not run |
| V-D4 | `[I]` **Playback length vs. the 60 s runner timeout.** Speak the 2,000-character UI maximum and time it. | `speak` uses a 60 s timeout (`electron/native/adapter.ts`). At normal speed, 2,000 characters is likely more than 60 s of speech (rough estimate: about 15 characters per second, so 60 s is roughly 900 characters). A longer text would be cut off and reported as `Native helper timed out`. Record the length that completes. | **Gap (static estimate).** The timeout and the text limits disagree. Options: raise the speak timeout, split long text, or lower the limits. Root decides. |
| V-D5 | `[M]` The UI cuts text at 2,000 characters without saying so. | Speak a 3,000-character reply and check whether the user is told the text was shortened. | Gap: `Assistant.tsx` slices silently. |
| V-D6 | `[M]` No stop control exists. `Assistant.tsx` says "There is no stop control yet." Backend `cancel()` is not part of the contract, so the UI cannot call it. | Look for a stop control during playback. Do not count the missing control as a passing feature. | Known limitation. |
| V-D7 | `[I]` No output device → a clear reason, not a hang. (Optional: only if the tester can disable output safely on a test machine.) | Optional. | Not run |

## E. Push-to-talk and microphone (manual only) — F4

These checks use a real microphone and must be run by a human tester on a test machine. The implementation worker does not run them.

Expected behaviour is from `src/components/Assistant.tsx` (`startRec` line 123, `stopRec` line 151, `cancelRec` line 183, PTT button and Esc handler lines 313–322), `src/ui/audio.ts` (`ClipRecorder`, `micErrorMessage`), and `docs/ui-guide.md`.

| ID | Check | Expected | Status |
|---|---|---|---|
| F4a | `[M]` The Windows microphone-in-use indicator is on only while the PTT control is held (or latched by tap), and off within about 1 s of release. | Indicator matches the recording state. | Not run |
| F4b | `[M]` Hold to record, release to stop. Tap once to start, tap again to stop. | Both gestures produce a transcript. | Not run |
| F4c | `[M]` Esc during recording (keyboard) and a pointer cancel both cancel. | Message `Recording cancelled. Nothing was sent.` Mic released, no transcript, no temp WAV created. | Not run |
| F4d | `[M]` Release during the permission prompt (longer than 1 s) keeps recording until the next tap. | Matches `startRec`: `pendingStop` only stops a start within 1 s. | Not run |
| F4e | `[M]` Clip under 300 ms → `That was too short. Hold the button while you speak.` No transcription call. | Quick tap. | Not run |
| F4f | `[M]` Silence (peak below 0.01) → `No sound was picked up. Check the microphone and try again.` No transcription call. | Cover the microphone or stay silent. | Not run |
| F4g | `[M]` Recording stops automatically at 30 s and the transcript appears. | Speak continuously past 30 s. | Not run |
| F4h | `[M]` Level meter moves with speech and returns to zero after stop. | Visual check. | Not run |
| F4i | `[M]` Denied microphone permission in Windows → `Microphone access was denied. Allow it in Windows privacy settings and try again.` Missing device → `No microphone was found.` In use by another app → `The microphone is in use by another application.` | Use a test machine only, and restore the original setting. Reproduce what the tester can. | Not run |
| F4j | `[M]` The electron permission handler grants only app-origin audio (`electron/main.ts` ~lines 131–137). | Static pass: other permissions are denied. Manual check: none needed beyond E4i. | Static pass |
| F4k | `[M]` The transcript is appended to any existing text in the message box, truncated at 4,000 characters, focus returns to the input, and nothing is sent automatically. | Type some text, dictate, check the box before pressing send. | Not run |
| F4l | `[M]` PTT still works with outbound network blocked (`docs/acceptance.md` C5). | Recognition is local. | Not run |
| F4m | `[M]` No audio clip is saved to disk. Only the transcribed `jarvis-<uuid>.wav` exists briefly in `%TEMP%`, and section C confirms it is removed. | Check `%TEMP%` and the user data folder after dictation. | Not run |
| F4n | `[M]` The level meter and status text do not claim recognition accuracy. | Label check against F6. | Not run |

## F. Dictation insertion — F5

| ID | Check | How | Status |
|---|---|---|---|
| F5 | `[M]` Dictation text reaches another window only through an approved `type-text` preview. | Static: `speech.transcribe` is called only from `Assistant.tsx` and sets the message box value. No code path from a transcript to `type-text`. Confirm by search before release. | Static pass (no dictation-to-window path exists in the current build). |

## G. Privacy and boundaries

| ID | Check | How | Status |
|---|---|---|---|
| V-G1 | `[U]` No cloud speech service is used by speech code. | Static scan of `electron/services/speech.ts`, `native/speak.ps1`, `native/transcribe.ps1`, `native/probe-speech.ps1` for network calls. Matches `docs/acceptance.md` A2 scan. | Static pass (the scripts make no network calls). |
| V-G2 | `[U]` Speech calls go only through the native runner, never through `fetch`. | Covered by the A2 static scan. | Static pass |

## H. Open gaps and decisions for the root owner

1. **Speak timeout vs. text length** (V-D4). The 60 s runner timeout is shorter than the 2,000-character UI maximum at normal speed. Affects F1/F2 wording and the user-visible behaviour. The 4,000-character backend limit is even further off.
2. **F6 label missing** (V-B7 / F6). The UI does not show "Basic (Windows Speech)".
3. **WAV parameters not validated** (V-C8b). `validateAudio` checks only the format tag, not sample rate, channels, or bit depth.
4. **Test assets not yet present.** `tests/fixtures/clear-english-16k.wav` and `tests/speech.test.mjs` do not exist. F3a/F3b and the `[U]` speech rows cannot pass until they do.
5. **Silent truncation of read-aloud text** at 2,000 characters (V-D5).
6. **No stop control and no cancel through the contract** (V-D6). `speech.cancel()` exists on the backend only.
7. **Probe cache has no refresh** (V-B6). Voice or recognizer changes take up to 30 s or a restart.
8. **Recognition result cap** (V-C9). The loop in `transcribe.ps1` stops after 100 results; a long clip could be cut short.

Known observations that are not gaps: the speech capability reason text says "Dictation quality is basic" (V-B5), and `current-verification.md` records that Windows TTS and an en-US recognizer were detected. That is detection only, not an audio test.

## I. Sign-off record

| Date | Machine / Windows build | DPI | Voices | Recognizers | Items run | Result | Tester |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Each row needs a list of item IDs and pass/fail. Paste failures with the observed text and the reason string shown. Do not mark an item passed on the basis of a detection result alone.
