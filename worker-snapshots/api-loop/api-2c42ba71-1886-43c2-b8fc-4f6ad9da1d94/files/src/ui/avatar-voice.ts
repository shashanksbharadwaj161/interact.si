/**
 * Voice link: turns speech playback events (start, word boundaries, output level, pause, resume, end,
 * cancel, error) into avatar mouth and pose states. Pure and DOM-free: no timers, no audio, no window.
 * Callers pass timestamps in explicitly so every transition is deterministic and testable.
 */

export const VOICE_LINK_LIMITS = Object.freeze({
  /** How often a level meter samples the playback output. */
  sampleWindowMs: 50,
  minAmplitude: 0,
  maxAmplitude: 1,
  /** At most this many vowels of one word are considered when picking its mouth shape. */
  maxVisemes: 8,
});

export type MouthState = 'closed' | 'narrow' | 'open' | 'wide';
export type PoseState = 'idle' | 'speaking' | 'listening' | 'thinking';

export const MOUTH_STATES: readonly MouthState[] = Object.freeze(['closed', 'narrow', 'open', 'wide'] as MouthState[]);
export const POSE_STATES: readonly PoseState[] = Object.freeze(['idle', 'speaking', 'listening', 'thinking'] as PoseState[]);

/** RMS thresholds (inclusive lower bounds) for each open mouth shape. */
export const MOUTH_THRESHOLDS = Object.freeze({ narrow: 0.04, open: 0.15, wide: 0.35 });

export type VoiceLinkEvent =
  | { type: 'start'; at?: number }
  | { type: 'boundary'; charIndex: number; text: string; at?: number }
  | { type: 'level'; rms: number; at?: number }
  | { type: 'pause'; at?: number }
  | { type: 'resume'; at?: number }
  | { type: 'end'; at?: number }
  | { type: 'cancel'; at?: number }
  | { type: 'error'; error?: string; at?: number }
  | { type: 'listen'; at?: number }
  | { type: 'think'; at?: number };

export type VoiceLinkEventType = VoiceLinkEvent['type'];

export const VOICE_LINK_EVENTS: readonly VoiceLinkEventType[] = Object.freeze([
  'start', 'boundary', 'level', 'pause', 'resume', 'end', 'cancel', 'error', 'listen', 'think',
] as VoiceLinkEventType[]);

export interface VoiceLink {
  readonly mouth: MouthState;
  readonly pose: PoseState;
  readonly speaking: boolean;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly lastEventAt: number;
}

export function isMouthState(v: unknown): v is MouthState {
  return typeof v === 'string' && (MOUTH_STATES as readonly string[]).includes(v);
}

export function isPoseState(v: unknown): v is PoseState {
  return typeof v === 'string' && (POSE_STATES as readonly string[]).includes(v);
}

function checkRms(rms: unknown): number {
  if (typeof rms !== 'number' || !Number.isFinite(rms) || rms < VOICE_LINK_LIMITS.minAmplitude || rms > VOICE_LINK_LIMITS.maxAmplitude) {
    throw new RangeError(`Voice link: rms must be a finite number from ${VOICE_LINK_LIMITS.minAmplitude} to ${VOICE_LINK_LIMITS.maxAmplitude}, got ${String(rms)}.`);
  }
  return rms;
}

function checkCharIndex(charIndex: unknown): number {
  if (typeof charIndex !== 'number' || !Number.isInteger(charIndex) || charIndex < 0) {
    throw new RangeError(`Voice link: charIndex must be a non-negative integer, got ${String(charIndex)}.`);
  }
  return charIndex;
}

/** Reduced motion keeps only two shapes, so the mouth never flickers between subtle variants. */
function collapse(m: MouthState, reducedMotion: boolean): MouthState {
  if (!reducedMotion) return m;
  return m === 'closed' ? 'closed' : 'open';
}

/** Maps a playback RMS level (0..1) to a mouth shape with fixed thresholds. */
export function mouthFromAmplitude(rms: number, opts: { reducedMotion?: boolean } = {}): MouthState {
  const r = checkRms(rms);
  const reduced = opts.reducedMotion === true;
  if (reduced) return r >= MOUTH_THRESHOLDS.narrow ? 'open' : 'closed';
  if (r >= MOUTH_THRESHOLDS.wide) return 'wide';
  if (r >= MOUTH_THRESHOLDS.open) return 'open';
  if (r >= MOUTH_THRESHOLDS.narrow) return 'narrow';
  return 'closed';
}

const WORD_CHAR = /[\p{L}\p{N}']/u;
const MAX_WORD_SCAN = 64;

/** Vowel letter (diacritics removed, lower case) to the lip shape it needs. */
const VOWEL_SHAPES: Record<string, MouthState> = { a: 'open', e: 'wide', i: 'wide', y: 'wide', o: 'narrow', u: 'narrow' };

function baseLetter(ch: string): string {
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * For speechSynthesis boundary events when no amplitude is available: finds the word at (or the first
 * word after) charIndex and maps its dominant vowel to a mouth shape. "a" opens, "e/i/y" spread wide,
 * "o/u" round to narrow; a word without vowels gives narrow; no word at all gives closed.
 */
export function mouthFromBoundary(charIndex: number, text: string, opts: { reducedMotion?: boolean } = {}): MouthState {
  const idx = checkCharIndex(charIndex);
  if (typeof text !== 'string') throw new TypeError('Voice link: boundary text must be a string.');
  let start = idx;
  while (start < text.length && !WORD_CHAR.test(text[start])) start++;
  if (start >= text.length) return 'closed';
  while (start > 0 && WORD_CHAR.test(text[start - 1]) && idx - start < MAX_WORD_SCAN) start--;
  const counts: Record<MouthState, number> = { closed: 0, narrow: 0, open: 0, wide: 0 };
  const first: Partial<Record<MouthState, number>> = {};
  let vowels = 0;
  for (let i = start, n = 0; i < text.length && n < MAX_WORD_SCAN && WORD_CHAR.test(text[i]); i++, n++) {
    const shape = VOWEL_SHAPES[baseLetter(text[i])];
    if (!shape) continue;
    counts[shape]++;
    if (first[shape] === undefined) first[shape] = vowels;
    vowels++;
    if (vowels >= VOICE_LINK_LIMITS.maxVisemes) break;
  }
  if (vowels === 0) return collapse('narrow', opts.reducedMotion === true);
  let best: MouthState = 'narrow';
  let bestCount = -1;
  let bestFirst = Infinity;
  for (const shape of ['open', 'wide', 'narrow'] as MouthState[]) {
    const c = counts[shape];
    const f = first[shape] ?? Infinity;
    if (c > bestCount || (c === bestCount && f < bestFirst)) {
      best = shape;
      bestCount = c;
      bestFirst = f;
    }
  }
  return collapse(best, opts.reducedMotion === true);
}

function make(link: Omit<VoiceLink, never>): VoiceLink {
  return Object.freeze({ ...link });
}

export function createVoiceLink(opts: { reducedMotion?: boolean; now?: number } = {}): VoiceLink {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : 0;
  return make({ mouth: 'closed', pose: 'idle', speaking: false, paused: false, reducedMotion: opts.reducedMotion === true, lastEventAt: now });
}

/**
 * Returns the next frozen link. Never mutates the input. Boundary and level events are ignored (the same
 * link is returned) unless speech is running and not paused, so late events after cancel cannot reopen the
 * mouth. end, cancel and error always return to closed/idle.
 */
export function transition(link: VoiceLink, event: VoiceLinkEvent): VoiceLink {
  if (!link || typeof link !== 'object') throw new TypeError('Voice link: transition needs a link from createVoiceLink.');
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
    throw new TypeError('Voice link: event must be an object with a type.');
  }
  const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : link.lastEventAt;
  const next = (patch: Partial<VoiceLink>): VoiceLink => make({ ...link, ...patch, lastEventAt: at });
  const rest = { mouth: 'closed' as MouthState, pose: 'idle' as PoseState, speaking: false, paused: false };
  switch (event.type) {
    case 'start':
      return next({ mouth: 'closed', pose: 'speaking', speaking: true, paused: false });
    case 'boundary': {
      const mouth = mouthFromBoundary(event.charIndex, event.text, { reducedMotion: link.reducedMotion });
      if (!link.speaking || link.paused) return link;
      return next({ mouth, pose: 'speaking' });
    }
    case 'level': {
      const mouth = mouthFromAmplitude(event.rms, { reducedMotion: link.reducedMotion });
      if (!link.speaking || link.paused) return link;
      return next({ mouth, pose: 'speaking' });
    }
    case 'pause':
      if (!link.speaking) return link;
      return next({ mouth: 'closed', pose: 'thinking', paused: true });
    case 'resume':
      if (!link.speaking || !link.paused) return link;
      return next({ pose: 'speaking', paused: false });
    case 'end':
    case 'cancel':
    case 'error':
      return next(rest);
    case 'listen':
      return next({ ...rest, pose: 'listening' });
    case 'think':
      return next({ ...rest, pose: 'thinking' });
    default:
      throw new Error(`Voice link: unknown event type "${String((event as { type: unknown }).type)}".`);
  }
}

/** Short readable summary for live status text. */
export function describeVoiceLink(link: VoiceLink): string {
  const state = link.speaking ? (link.paused ? 'paused' : 'speaking') : 'not speaking';
  return `Mouth ${link.mouth}, pose ${link.pose}, ${state}.`;
}
