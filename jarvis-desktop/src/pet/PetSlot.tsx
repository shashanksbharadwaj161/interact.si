import { useEffect, useState, type MutableRefObject } from 'react';
import { CompanionOrb } from '../components/CompanionOrb';
import type { PetView } from './adapter';
import { acquirePetPack, releasePetPack, type LoadMode, type PetLoad } from './loader';
import { MissingArt } from './MissingArt';
import { PetSprite, petBoxWidth, type PetHitTest } from './PetSprite';
import '../styles/pet.css';

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
  /** What is showing, for callers that describe it elsewhere (status text, settings). */
  onStatus?: (s: { kind: 'pet' | 'legacy-orb' | 'missing' | 'invalid'; name?: string; review?: string; reason?: string }) => void;
}) {
  const [load, setLoad] = useState<PetLoad | null>(null);
  useEffect(() => {
    if (appearance !== 'pet') return undefined;
    let alive = true;
    let acquired: string | null = null;
    void acquirePetPack(mode, packId).then((l) => {
      if (l.status === 'ready') acquired = l.manifest.id;
      if (alive) setLoad(l);
      else if (acquired) releasePetPack(acquired);
    });
    return () => {
      alive = false;
      if (acquired) releasePetPack(acquired);
      setLoad(null);
    };
  }, [appearance, mode, packId]);

  const kind = appearance === 'legacy-orb' ? 'legacy-orb' : load?.status === 'ready' ? 'pet' : load?.status === 'invalid' ? 'invalid' : 'missing';
  useEffect(() => {
    if (!onStatus) return;
    if (kind === 'pet' && load?.status === 'ready') onStatus({ kind, name: load.manifest.name, review: load.manifest.review.status });
    else if (kind === 'invalid' && load?.status === 'invalid') onStatus({ kind, reason: load.errors.join(' ') });
    else if (kind === 'missing') onStatus({ kind, reason: load?.status === 'missing' ? load.reason : undefined });
    else onStatus({ kind });
  }, [kind, load, onStatus]);

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
        {mode === 'review' && load.manifest.review.status !== 'approved' && <span className="pet-review-tag">{load.manifest.review.status}</span>}
      </>
    );
  } else if (load?.status === 'invalid') {
    body = <MissingArt size={size} status="invalid" reason={load.errors[0] ?? 'The pack failed its load check.'} />;
  } else {
    body = <MissingArt size={size} reason={load?.status === 'missing' ? load.reason : 'Loading…'} />;
  }
  return (
    <div className="pet-slot" data-kind={kind} style={{ width: petBoxWidth(size), height: size }}>
      {body}
      <span className="pet-sr" role="status" aria-live="polite">
        {kind === 'pet' ? view.reason : ''}
      </span>
    </div>
  );
}
