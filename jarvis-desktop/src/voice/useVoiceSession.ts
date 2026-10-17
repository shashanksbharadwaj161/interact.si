import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createMicConsent, defaultConsentStorage, micSupport, type MicConsent } from '../ui/audio';
import { VoiceSession, voiceBlocks, type Transcript, type VoiceBackend, type VoiceCaps } from './session';

export type UseVoiceSessionOptions = {
  /** Memoise it: a new object re-binds the session (an in-flight call keeps the backend it started with). */
  backend: VoiceBackend | null;
  caps: VoiceCaps;
  consent?: MicConsent;
  consentHint?: string;
  maxSpeakChars?: number;
  onTranscript: (t: Transcript) => void;
};

/**
 * The voice session for one mounted surface. Unmounting (leaving the page, closing the bubble) releases it: the microphone
 * closes, a transcription in flight is discarded and read-aloud stops. Hiding the window cancels a recording.
 */
export function useVoiceSession(o: UseVoiceSessionOptions) {
  const capsRef = useRef(o.caps);
  capsRef.current = o.caps;
  const onTranscript = useRef(o.onTranscript);
  onTranscript.current = o.onTranscript;
  const [support] = useState(() => micSupport());
  const [voice] = useState(
    () =>
      new VoiceSession({
        backend: o.backend,
        consent: o.consent ?? createMicConsent(defaultConsentStorage()),
        support,
        caps: () => capsRef.current,
        consentHint: o.consentHint,
        maxSpeakChars: o.maxSpeakChars,
        onTranscript: (t) => onTranscript.current(t),
      }),
  );
  useEffect(() => voice.setBackend(o.backend), [voice, o.backend]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') voice.windowHidden(); };
    const onPageHide = () => voice.release();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      voice.release();
    };
  }, [voice]);
  const snap = useSyncExternalStore(voice.subscribe, voice.getSnapshot, voice.getSnapshot);
  const blocks = voiceBlocks({ hasBackend: o.backend !== null, caps: o.caps, support, consent: snap.consent, consentHint: o.consentHint });
  return { voice, snap, blocks, support };
}
