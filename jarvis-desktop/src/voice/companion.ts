import { useCallback, useEffect, useState } from 'react';
import type { CompanionApi, CompanionVoiceStatus } from '../companion/api';
import type { VoiceCaps } from './session';

const UNCHECKED: VoiceCaps = { stt: null, tts: null };

/** Engine state as VoiceCaps, from a voice status call. A failed check is reported with its reason, never as available. */
export function capsFromStatus(s: CompanionVoiceStatus | null, error?: string | null): VoiceCaps {
  if (error) return { stt: { available: false, reason: error }, tts: { available: false, reason: error } };
  if (!s) return UNCHECKED;
  return { stt: { available: s.stt.available, reason: s.stt.reason }, tts: { available: s.tts.available, reason: s.tts.reason } };
}

/**
 * The island's engine state for useVoiceSession: asked once on mount and again on refresh() (for example when the bubble
 * opens). Until the first answer both engines read "not checked yet", so nothing is offered early.
 */
export function useCompanionVoiceCaps(api: Pick<CompanionApi, 'voiceStatus'> | null): { caps: VoiceCaps; status: CompanionVoiceStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<CompanionVoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(api ? null : 'Voice is not available in this window.');
  const [n, setN] = useState(0);
  const refresh = useCallback(() => setN((v) => v + 1), []);
  useEffect(() => {
    if (!api || typeof api.voiceStatus !== 'function') return undefined;
    let alive = true;
    api.voiceStatus().then(
      (s) => { if (alive) { setStatus(s); setError(null); } },
      (e: unknown) => { if (alive) setError(e instanceof Error && e.message ? e.message : 'Speech could not be checked.'); },
    );
    return () => { alive = false; };
  }, [api, n]);
  return { caps: capsFromStatus(status, error), status, refresh };
}
