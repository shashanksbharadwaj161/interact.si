import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { CompanionOrb } from '../components/CompanionOrb';
import type { PetView } from './adapter';
import { acquirePetPack, releasePetPack, type LoadMode, type PetLoad } from './loader';
import { MissingArt } from './MissingArt';
import { PetSprite, petBoxWidth, type PetHitTest } from './PetSprite';
import '../styles/pet.css';

export type SlotKind = 'pet' | 'legacy-orb' | 'loading' | 'missing' | 'invalid';

/**
 * The one place the companion's identity is drawn. Exactly one of: the character from an approved pack (in review mode
 * also concept / in-review packs, labelled with their status), the legacy orb when the person chose it, or the
 * missing-art state with its reason. Never a stand-in character.
 *
 * `hitRef` receives a hit test in box coordinates: the character's own pixels, or the whole box for the orb and the
 * missing-art slot. The desktop window uses it so clicks on transparent pixels reach the desktop.
 */
export function PetSlot({ size, view, appearance = 'pet', mode = 'product', packId, hitRef, onStatus }: {
  size: number;
  view: PetView;
  appearance?: 'pet' | 'legacy-orb';
  mode?: LoadMode;
  packId?: string;
  hitRef?: MutableRefObject<PetHitTest | null>;
  /** What is showing, for callers that describe it elsewhere (status text, settings). Called only when it changes. */
  onStatus?: (s: { kind: SlotKind; name?: string; review?: string; reason?: string }) => void;
}) {
  const [load, setLoad] = useState<PetLoad | null>(null);
  useEffect(() => {
    if (appearance !== 'pet') return undefined;
    let alive = true;
    setLoad(null);
    void acquirePetPack(mode, packId).then((l) => {
      if (alive) setLoad(l);
      else if (l.status === 'ready') releasePetPack(l.manifest.id);
    });
    return () => {
      alive = false;
    };
  }, [appearance, mode, packId]);
  // Release a ready pack only after React has stopped rendering it (this cleanup runs after the commit that removes it).
  useEffect(() => {
    if (load?.status !== 'ready') return undefined;
    const id = load.manifest.id;
    return () => releasePetPack(id);
  }, [load]);

  const kind: SlotKind = appearance === 'legacy-orb' ? 'legacy-orb' : load === null ? 'loading' : load.status === 'ready' ? 'pet' : load.status === 'invalid' ? 'invalid' : 'missing';
  const statusCb = useRef(onStatus);
  statusCb.current = onStatus;
  useEffect(() => {
    const cb = statusCb.current;
    if (!cb) return;
    if (kind === 'pet' && load?.status === 'ready') cb({ kind, name: load.manifest.name, review: load.manifest.review.status });
    else if (kind === 'invalid' && load?.status === 'invalid') cb({ kind, reason: load.errors.join(' ') });
    else if (kind === 'missing' && load?.status === 'missing') cb({ kind, reason: load.reason });
    else cb({ kind });
  }, [kind, load]);

  // The live region reports what the character is doing for the person's request; pointer- and drag-driven changes
  // (gaze, being carried) are not announced.
  const quiet = view.kind === 'look' || (view.kind === 'state' && (view.state === 'running-left' || view.state === 'running-right' || /carried/i.test(view.reason)));
  const live = useRef('');
  if (!quiet) live.current = view.reason;

  useEffect(() => {
    if (!hitRef || kind === 'pet') return undefined;
    // The orb and the missing-art slot are hit anywhere in their box.
    const w = petBoxWidth(size);
    hitRef.current = (x, y) => x >= 0 && y >= 0 && x < w && y < size;
    return () => {
      hitRef.current = null;
    };
  }, [hitRef, kind, size]);

  let body;
  if (appearance === 'legacy-orb') {
    body = (
      <div className="pet-orb" style={{ width: petBoxWidth(size), height: size }}>
        <CompanionOrb size={Math.round(size * 0.72)} decorative showWhenHidden />
      </div>
    );
  } else if (load?.status === 'ready') {
    body = (
      <>
        <PetSprite pet={load} view={view} size={size} hitRef={hitRef} />
        {mode === 'review' && load.manifest.review.status !== 'approved' && <span className="pet-review-tag">{load.manifest.review.status === 'concept' ? 'Art concept' : 'Animation preview'}</span>}
      </>
    );
  } else if (load?.status === 'invalid') {
    body = <MissingArt size={size} status="invalid" reason={load.errors[0] ?? 'The pack failed its load check.'} />;
  } else if (load?.status === 'missing') {
    body = <MissingArt size={size} reason={load.reason} />;
  } else {
    body = <div className="pet-loading" style={{ width: petBoxWidth(size), height: size }} role="img" aria-label="Loading the character" />;
  }
  return (
    <div className="pet-slot" data-kind={kind} style={{ width: petBoxWidth(size), height: size }}>
      {body}
      <span className="pet-sr" role="status" aria-live="polite">
        {kind === 'pet' ? live.current : ''}
      </span>
    </div>
  );
}
