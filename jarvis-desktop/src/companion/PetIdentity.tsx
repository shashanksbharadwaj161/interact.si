import {useEffect, useRef, useState, type MutableRefObject} from 'react';
import {CompanionPet} from '../components/CompanionPet';
import {PetSlot} from '../pet/PetSlot';
import {listPetPacks} from '../pet/registry';
import {createPetAdapter, type PetSignals, type PetSurface, type PetFailure} from '../pet/adapter';
import type {PetHitTest} from '../pet/PetSprite';
import {companionApi, type AgentEvent} from './api';

type ToolStep = Extract<AgentEvent, {type: 'tool'}>;

/** Connects the reviewed sprite adapter to real UI signals; concept mode never claims those sprite poses exist. */
export function PetIdentity(p: {size: number; appearance: 'pet' | 'legacy-orb'; surface: PetSurface; steps: ToolStep[]; failure: PetFailure | null; invoked: number; answered: number; drag: number | null; gaze: number | null; hitRef: MutableRefObject<PetHitTest | null>}) {
  const adapter = useRef(createPetAdapter(performance.now()));
  const [view, setView] = useState(() => adapter.current.view(performance.now()));
  const [tick, setTick] = useState(0);
  const [reduced, setReduced] = useState(() => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches);
  const seen = useRef({invoked: p.invoked, answered: p.answered, verified: new Set<string>()});
  const installed = listPetPacks().find(pack => pack.manifest?.review.status === 'approved' && !pack.errors.length) ?? listPetPacks().find(pack => pack.manifest?.id === 'first-light' && pack.manifest.qa && !pack.errors.length);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches || document.documentElement.dataset.motion === 'reduced');
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-motion']});
    media.addEventListener('change', sync);
    return () => { observer.disconnect(); media.removeEventListener('change', sync); };
  }, []);
  useEffect(() => {
    const api = companionApi();
    const on = !!installed && p.appearance === 'pet' && !reduced && (p.surface === 'rest' || p.surface === 'command');
    void api?.gaze(on).catch(() => undefined);
    return () => { void api?.gaze(false).catch(() => undefined); };
  }, [!!installed, p.appearance, p.surface, reduced]);
  useEffect(() => {
    const now = performance.now();
    const signals: PetSignals = {surface: p.surface, requestInFlight: p.surface === 'working', awaitingPerson: p.steps.some(s => s.phase === 'awaiting-confirm'), failure: p.surface === 'error' ? p.failure : null, dragVx: p.drag, gaze: p.gaze === null ? null : p.gaze * 22.5, reducedMotion: reduced};
    adapter.current.signal(signals, now);
    if (seen.current.invoked !== p.invoked) adapter.current.event({kind: 'invoked'}, now);
    if (seen.current.answered !== p.answered) adapter.current.event({kind: 'answer-shown'}, now);
    for (const step of p.steps) {
      if (step.phase === 'done' && step.verified && step.undo && !seen.current.verified.has(step.callId)) {
        seen.current.verified.add(step.callId); adapter.current.event({kind: 'verified-change'}, now);
      }
    }
    seen.current.invoked = p.invoked; seen.current.answered = p.answered;
    const next = adapter.current.view(now); setView(next);
    const until = next.kind === 'state' ? next.until : null;
    // Reduced motion still needs one semantic expiry (for example greeting -> resting); it must not hold a stale state.
    if (until !== null) {
      const timer = window.setTimeout(() => setTick(v => v + 1), Math.max(1, until - now + 1));
      return () => window.clearTimeout(timer);
    }
  }, [p.surface, p.steps, p.failure, p.invoked, p.answered, p.drag, p.gaze, reduced, tick]);
  if (installed || p.appearance === 'legacy-orb') return <PetSlot size={p.size} appearance={p.appearance} view={view} hitRef={p.hitRef} packId={installed?.manifest?.id} mode={installed?.manifest?.review.status === 'approved' ? 'product' : 'review'} />;
  const state = p.surface === 'error' ? 'error' : p.steps.some(s => s.phase === 'awaiting-confirm') ? 'waiting' : p.surface === 'working' ? 'working' : p.surface === 'answer' ? 'done' : 'idle';
  return <>
    <CompanionPet state={state} decorative hitRef={p.hitRef} size={p.size} />
    <span className="pet-concept-tag">concept</span>
  </>;
}
