import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { starShadow } from '../ui/scenes';
import { useAnimMachine } from '../ui/companion';

/**
 * Ambient motion policy for the backdrop. Pure so it can be tested without a DOM.
 * - `reduced` comes from the root data-motion attribute, which App derives from the setting, Windows and the battery rule.
 * - `hidden` is the document visibility; a hidden window gets no animation work at all.
 * Returns the value for the `data-ambient` attribute the stylesheet keys on.
 */
export function ambientMode(reduced: boolean, hidden: boolean): 'off' | 'paused' | 'on' {
  if (reduced) return 'off';
  if (hidden) return 'paused';
  return 'on';
}

/** Reads the root motion attribute App writes; true when it says 'reduced'. Safe to call without a document. */
function readReduced(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.motion === 'reduced';
}

function readHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden';
}

/**
 * Tracks visibility and the root motion attribute while mounted, and removes both listeners on unmount.
 * The attribute is watched with a MutationObserver so a settings change or a battery drop stops the drift
 * without a reload; the first render uses the current values so there is no flash of motion.
 */
function useAmbient(): 'off' | 'paused' | 'on' {
  const [reduced, setReduced] = useState(readReduced);
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    const onVisibility = () => setHidden(readHidden());
    document.addEventListener('visibilitychange', onVisibility);
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => setReduced(readReduced())) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    setReduced(readReduced());
    setHidden(readHidden());
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    };
  }, []);
  return ambientMode(reduced, hidden);
}

export function SceneBackdrop({ scene: requested, className = '' }: { scene: string; className?: string }) {
  const stars = useMemo(() => ({ a: starShadow(46, 11), b: starShadow(22, 29) }), []);
  const ambient = useAmbient();
  // Project-to-project scene crossfade on the shared interruptible machine: the current scene fades out from
  // wherever it is, then the requested one fades in. Switching twice quickly retargets without restarting or
  // overlapping two fades; reduced motion (ambient 'off') swaps in one step.
  const fade = useAnimMachine(requested, { reducedMotion: ambient === 'off' });
  const scene = fade.shown ?? requested;
  // Only a running fade adds attributes, so a settled backdrop renders exactly the markup it always did.
  const fading = fade.phase === 'entering' || fade.phase === 'exiting' || fade.phase === 'interrupted';
  const fadeStyle = fading ? ({ '--anim-progress': fade.progress } as CSSProperties) : undefined;
  return (
    <div className={`scene ${className}`} data-scene={scene} data-ambient={ambient} data-anim-phase={fading ? fade.phase : undefined} style={fadeStyle} aria-hidden="true">
      <div className="scene-wash" />
      <div className="scene-drift" />
      {(scene === 'deep-space' || scene === 'orbit') && (
        <>
          <i className="scene-stars scene-stars-a" style={{ boxShadow: stars.a }} />
          <i className="scene-stars scene-stars-b" style={{ boxShadow: stars.b }} />
        </>
      )}
      {scene === 'orbit' && (
        <div className="scene-orbit">
          <i />
          <i />
          <i />
          <b />
        </div>
      )}
      {scene === 'aurora' && (
        <>
          <i className="scene-ribbon scene-ribbon-a" />
          <i className="scene-ribbon scene-ribbon-b" />
          <i className="scene-ribbon scene-ribbon-c" />
        </>
      )}
      {scene === 'horizon' && (
        <>
          <i className="scene-sun" />
          <i className="scene-grid" />
        </>
      )}
      {scene === 'dusk' && (
        <>
          <i className="scene-sun scene-sun-low" />
          <i className="scene-ridge scene-ridge-a" />
          <i className="scene-ridge scene-ridge-b" />
          <i className="scene-ridge scene-ridge-c" />
        </>
      )}
      <div className="scene-vignette" />
    </div>
  );
}
