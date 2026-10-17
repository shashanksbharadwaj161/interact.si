import { useEffect, useRef } from 'react';
import { LEVEL_HISTORY, type VoiceSession } from './session';

/**
 * The real microphone level as a short rolling trace (newest on the right). Bars are written directly from the session's
 * level feed, so the page around it does not re-render at microphone rate. Shows nothing invented: with no level the
 * bars rest flat. Decorative for assistive technology; the listening state is announced as text by the owner.
 */
export function VoiceMeter({ voice, bars = 20, className }: { voice: VoiceSession; bars?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const n = Math.min(bars, LEVEL_HISTORY);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const cells = Array.from(el.children) as HTMLElement[];
    return voice.subscribeLevel((_, history) => {
      const tail = history.slice(-n);
      const pad = n - tail.length;
      for (let i = 0; i < cells.length; i++) {
        const v = i < pad ? 0 : tail[i - pad];
        cells[i].style.setProperty('--l', String(v));
      }
      el.style.setProperty('--now', String(tail.at(-1) ?? 0));
    });
  }, [voice, n]);
  return (
    <span ref={ref} className={className ? `vx-meter ${className}` : 'vx-meter'} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <i key={i} />)}
    </span>
  );
}
