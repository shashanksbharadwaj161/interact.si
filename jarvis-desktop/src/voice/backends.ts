import type { CompanionApi } from '../companion/api';
import type { JarvisAPI } from '../shared/contracts';
import type { VoiceBackend } from './session';

const NO_READ_ALOUD = 'Read aloud is not available in this window.';
const NO_VOICE_INPUT = 'Voice input is not available in this window.';

/**
 * The hub window's voice calls: window.jarvis speak/transcribe through the validated hub IPC (Windows speech on this
 * computer), plus stop and cancel when the bridge has them. Null when the bridge has neither speak nor transcribe.
 */
export function hubVoiceBackend(api: Partial<Pick<JarvisAPI, 'speak' | 'transcribe' | 'speechStop' | 'transcribeCancel'>>): VoiceBackend | null {
  const { speak, transcribe, speechStop, transcribeCancel } = api;
  if (typeof speak !== 'function' && typeof transcribe !== 'function') return null;
  return {
    transcribe: typeof transcribe === 'function' ? (wav) => transcribe(wav) : async () => ({ text: '', reason: NO_VOICE_INPUT }),
    speak: typeof speak === 'function' ? (text) => speak(text) : async () => ({ ok: false, reason: NO_READ_ALOUD }),
    ...(typeof speechStop === 'function' ? { stopSpeaking: () => speechStop() } : {}),
    ...(typeof transcribeCancel === 'function' ? { cancelTranscribe: () => transcribeCancel() } : {}),
  };
}

/** The companion island's voice calls: window.companion through its own island-only IPC (the same local Windows speech). */
export function companionVoiceBackend(api: Pick<CompanionApi, 'transcribe' | 'transcribeCancel' | 'speak' | 'speechStop'> | null): VoiceBackend | null {
  if (!api || typeof api.transcribe !== 'function' || typeof api.speak !== 'function') return null;
  return {
    transcribe: (wav) => api.transcribe(wav),
    speak: (text) => api.speak(text),
    stopSpeaking: () => api.speechStop(),
    cancelTranscribe: () => api.transcribeCancel(),
  };
}
