import {useEffect, useRef, useState, type MutableRefObject} from 'react';
import {REDUCED_MOTION_KEY_FRAME, rowDurationMs, type PetState} from '../pet/contract';
import {useAppearance} from '../ui/appearance-context';
import type {PetView} from '../pet/adapter';
type SlotComponent = typeof import('../pet/PetSlot').PetSlot;
import '../styles/pet.css';

/** Shared frame-based character. Unapproved art is explicitly marked as an animation preview. */
export function CompanionPet({state = 'idle', decorative = false, hitRef, size, pose, look, replay = 0, showWhenHidden = false}: {state?: 'idle' | 'working' | 'waiting' | 'done' | 'error'; decorative?: boolean; hitRef?: MutableRefObject<((x: number, y: number) => boolean) | null>; size?: number; pose?: PetState; look?: number | null; replay?: number; showWhenHidden?: boolean}) {
  const [appearance] = useAppearance();
  const host = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState(size ?? 96);
  const [sprite, setSprite] = useState<{Slot: SlotComponent; packId: string; mode: 'review' | 'product'} | null>(null);
  const [greeting, setGreeting] = useState(false);
  const [reduced, setReduced] = useState(false);
  const since = useRef(0);
  const [view, setView] = useState<PetView>({kind: 'state', state: 'idle', loop: true, still: false, reason: 'Resting', since: 0, plays: 0, holdLast: false, frame: null, until: null});
  useEffect(() => {
    let alive = true;
    void Promise.all([import('../pet/PetSlot'), import('../pet/registry')]).then(([renderer, registry]) => {
      const pack = registry.listPetPacks().find(p => p.manifest?.id === 'first-light' && p.manifest.qa && !p.errors.length);
      if (alive && pack?.manifest) setSprite({Slot: renderer.PetSlot, packId: pack.manifest.id, mode: pack.manifest.review.status === 'approved' ? 'product' : 'review'});
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches || document.documentElement.dataset.motion === 'reduced');
    const observer = new MutationObserver(sync); observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-motion']});
    media.addEventListener('change', sync); sync();
    return () => { media.removeEventListener('change', sync); observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (size !== undefined) { setMeasured(size); return; }
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setMeasured(Math.max(32, Math.round(Math.min(r.height, r.width * 208 / 192))));
    });
    resize.observe(el); return () => resize.disconnect();
  }, [size]);
  const motion: PetState = pose ?? (state === 'working' ? 'running' : state === 'waiting' ? 'waiting' : state === 'done' ? 'jumping' : state === 'error' ? 'failed' : greeting ? 'waving' : 'idle');
  useEffect(() => {
    since.current = performance.now();
    // A manually selected still pose remains available with reduced motion; automatic gaze is disabled by PetIdentity.
    if (look !== undefined && look !== null) { setView({kind: 'look', index: Math.max(0, Math.min(15, Math.round(look))), reason: 'Direction preview'}); return; }
    const oneShot = motion === 'waving' || motion === 'jumping' || motion === 'failed';
    setView({kind: 'state', state: motion, loop: !oneShot, still: reduced, reason: decorative ? '' : `${motion} animation`, since: since.current, plays: oneShot ? 1 : 0, holdLast: oneShot, frame: reduced ? REDUCED_MOTION_KEY_FRAME[motion] : null, until: oneShot ? since.current + rowDurationMs(motion) : null});
  }, [motion, look, reduced, decorative, replay]);
  useEffect(() => {
    if (!greeting) return;
    const timer = window.setTimeout(() => setGreeting(false), rowDurationMs('waving'));
    return () => window.clearTimeout(timer);
  }, [greeting]);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!hitRef || sprite) return;
    const element = image.current;
    if (!element) return;
    const height = size ?? measured;
    const width = Math.round(height * 192 / 208);
    const buildMask = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) return;
        const scale = Math.min(width / element.naturalWidth, height / element.naturalHeight);
        const w = element.naturalWidth * scale; const h = element.naturalHeight * scale;
        context.drawImage(element, (width - w) / 2, (height - h) / 2, w, h);
        const pixels = context.getImageData(0, 0, width, height).data;
        hitRef.current = (x, y) => {
          const px = Math.floor(x); const py = Math.floor(y);
          return px >= 0 && py >= 0 && px < width && py < height && pixels[(py * width + px) * 4 + 3] > 24;
        };
      } catch { hitRef.current = (x, y) => x >= 0 && y >= 0 && x < width && y < height; }
    };
    if (element.complete && element.naturalWidth) buildMask();
    element.addEventListener('load', buildMask);
    return () => { element.removeEventListener('load', buildMask); hitRef.current = null; };
  }, [hitRef, size, measured, sprite]);
  if (!appearance.visible && !showWhenHidden) return null;
  return <span ref={host} className="companion-pet" data-state={state} data-animated={sprite ? 'true' : undefined}
    onPointerEnter={() => { if (state === 'idle' && !pose && !reduced) setGreeting(true); }}>
    {sprite ? <sprite.Slot size={measured} view={view} packId={sprite.packId} mode={sprite.mode} hitRef={hitRef} /> : <img ref={image} src="./pets/first-light/concept.png" alt={decorative ? '' : 'Cream and indigo companion with one folded ear'} draggable={false} />}
  </span>;
}
