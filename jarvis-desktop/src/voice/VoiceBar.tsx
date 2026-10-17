import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Microphone, SpeakerHigh, Stop, X } from '@phosphor-icons/react';
import { MAX_CLIP_MS, remainingMs } from '../ui/audio';
import type { VoiceBlock, VoiceSession, VoiceSnapshot } from './session';
import { VoiceMeter } from './VoiceMeter';

/**
 * Voice UI shared by the hub Assistant and the companion island. Styles: src/styles/voice.css (scoped to .vx-*).
 * Everything shown comes from the session snapshot; nothing here starts the microphone except an explicit press.
 */

export const HOLD_MS = 400;

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Milliseconds since the microphone really opened, ticking 4 times a second while listening; 0 otherwise. */
export function useListeningElapsed(snap: VoiceSnapshot): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = snap.listeningSince;
    if (snap.phase !== 'listening' || t0 === null) {
      setElapsed(0);
      return undefined;
    }
    setElapsed(performance.now() - t0);
    const id = window.setInterval(() => setElapsed(performance.now() - t0), 250);
    return () => window.clearInterval(id);
  }, [snap.phase, snap.listeningSince]);
  return elapsed;
}

/**
 * Push to talk: press starts listening (and interrupts read-aloud), a second press stops and transcribes. Letting go
 * after a hold stops; a quick tap keeps listening until the next press. Esc cancels, or stops read-aloud.
 */
export function usePushToTalk(voice: VoiceSession, o: { holdMs?: number; onStart?: () => void } = {}) {
  const pressAt = useRef(0);
  const onStart = useRef(o.onStart);
  onStart.current = o.onStart;
  const holdMs = o.holdMs ?? HOLD_MS;
  const press = useCallback(() => {
    if (voice.getSnapshot().phase === 'listening') {
      void voice.stopListening();
      return;
    }
    pressAt.current = performance.now();
    onStart.current?.();
    void voice.startListening();
  }, [voice]);
  const release = useCallback(() => {
    const p = voice.getSnapshot().phase;
    if (p !== 'starting' && p !== 'listening') return;
    if (performance.now() - pressAt.current > holdMs) void voice.stopListening();
  }, [voice, holdMs]);
  const cancel = useCallback(() => voice.cancel(), [voice]);
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      press();
    },
    onPointerUp: release,
    onPointerCancel: cancel,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      // Esc ends whatever the voice is doing: read-aloud stops, a recording or transcription is cancelled.
      if (e.key === 'Escape') {
        if (voice.getSnapshot().phase === 'speaking') void voice.stopSpeaking();
        else cancel();
      }
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        press();
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        release();
      }
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) press();
    },
  };
  return { press, release, cancel, handlers };
}

/**
 * What the voice is doing right now: opening the microphone, listening (with the real level and the time used),
 * transcribing on this computer, or reading aloud, each with its way out. Renders nothing at rest. `compact` drops the
 * detail line and the time limit, for the companion bubble.
 */
export function VoiceBar({ voice, snap, voiceName, compact = false }: { voice: VoiceSession; snap: VoiceSnapshot; voiceName: string; compact?: boolean }) {
  const elapsedMs = useListeningElapsed(snap);
  const p = snap.phase;
  if (p === 'idle') return null;
  const sp = snap.speaking;
  const title = p === 'starting' ? 'Opening the microphone' : p === 'listening' ? 'Listening' : p === 'transcribing' ? 'Transcribing' : 'Reading aloud';
  const detail =
    p === 'starting'
      ? 'If Windows asks, allow microphone access.'
      : p === 'listening'
        ? 'Let go of Talk, or press it again, when you finish. Esc cancels.'
        : p === 'transcribing'
          ? snap.draining
            ? 'Waiting for Windows speech to finish the cancelled recording first.'
            : 'Windows speech recognition, on this computer. The audio is not sent online.'
          : `${voiceName} on this computer${sp?.truncated ? `, the first ${sp.chars.toLocaleString()} characters` : ''}. ${sp?.stoppable ? 'Esc or Stop reading ends it; Talk interrupts it.' : 'Stop is not available in this window.'}`;
  return (
    <div className={`vx vx-bar is-${p}${compact ? ' is-compact' : ''}`} role="group" aria-label={`Voice: ${title}`}>
      <span className="vx-sig" aria-hidden="true">
        {p === 'speaking' ? <SpeakerHigh size={16} weight="fill" /> : p === 'listening' ? <Microphone size={16} weight="fill" /> : <span className="vx-spin" />}
      </span>
      <span className="vx-text">
        <strong className="vx-title">{title}</strong>
        {!compact && <span className="vx-detail">{detail}</span>}
        {compact && <span className="vx-sr">{detail}</span>}
      </span>
      {p === 'listening' && <VoiceMeter voice={voice} bars={compact ? 12 : 20} />}
      {p === 'listening' && (
        <span className="vx-time" title={`${Math.ceil(remainingMs(elapsedMs) / 1000)} seconds left`}>
          {fmtClock(elapsedMs)}
          {!compact && <span className="vx-time-max"> / {fmtClock(MAX_CLIP_MS)}</span>}
        </span>
      )}
      <span className="vx-actions">
        {(p === 'starting' || p === 'listening' || p === 'transcribing') && (
          <button type="button" className="vx-btn" aria-keyshortcuts="Escape" onClick={() => voice.cancel()}>
            <X size={14} aria-hidden /> Cancel
          </button>
        )}
        {p === 'speaking' && sp?.stoppable && (
          <button type="button" className="vx-btn is-strong" aria-keyshortcuts="Escape" onClick={() => void voice.stopSpeaking()}>
            <Stop size={14} weight="fill" aria-hidden /> Stop reading
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A ready Talk button for a surface without its own (the companion bubble). Disabled with the block's reason as its
 * description when listening cannot start; shows Stop while listening.
 */
export function TalkButton({ voice, snap, block, className }: { voice: VoiceSession; snap: VoiceSnapshot; block: VoiceBlock | null; className?: string }) {
  const ptt = usePushToTalk(voice);
  const p = snap.phase;
  const listening = p === 'listening';
  const busy = p === 'starting' || p === 'transcribing';
  const disabled = p === 'transcribing' || ((p === 'idle' || p === 'speaking') && block !== null);
  return (
    <button
      type="button"
      className={`vx-talk${listening ? ' is-listening' : ''}${busy ? ' is-busy' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={listening}
      aria-label={listening ? 'Stop and transcribe' : p === 'starting' ? 'Opening the microphone' : p === 'transcribing' ? 'Transcribing' : 'Talk'}
      title={block && !listening ? block.reason : listening ? 'Press again or let go to stop. Esc cancels.' : 'Hold to talk, or tap to start and tap again to stop.'}
      disabled={disabled}
      {...ptt.handlers}
    >
      {listening ? <Stop size={16} weight="fill" aria-hidden /> : busy ? <span className="vx-spin" aria-hidden /> : <Microphone size={16} aria-hidden />}
      <span>{listening ? 'Stop' : p === 'transcribing' ? 'Transcribing' : 'Talk'}</span>
    </button>
  );
}
