import {createContext, useContext, useEffect, useRef, useState, type ReactNode, type CSSProperties} from 'react';
import {Sparkle} from '@phosphor-icons/react';
import {usePref} from '../ui/prefs';
import {CompanionField} from './CompanionField';
import {AsciiField} from './AsciiField';
import '../styles/experience-effects.css';

export const ATMOSPHERES = [
  {id: 'flow', name: 'Flow field', description: 'Luminous streams across smoked glass.'},
  {id: 'grid', name: 'Vapor grid', description: 'A moving perspective grid and distant horizon.'},
  {id: 'ascii', name: 'Signal', description: 'An animated wave surface made of glyphs.'},
  {id: 'quiet', name: 'Quiet', description: 'Still glass, without an animated backdrop.'},
] as const;
type Atmosphere = typeof ATMOSPHERES[number]['id'];
type Effects = {scene: Atmosphere; glass: number; edge: boolean; setScene: (s: Atmosphere) => void; setGlass: (v: number) => void; setEdge: (v: boolean) => void};
const fallback: Effects = {scene: 'grid', glass: 72, edge: true, setScene: () => undefined, setGlass: () => undefined, setEdge: () => undefined};
const Context = createContext<Effects>(fallback);

export function ExperienceProvider({children}: {children: ReactNode}) {
  const [savedScene, saveScene] = usePref<string>('experience.atmosphere', 'grid');
  const [savedGlass, saveGlass] = usePref<number>('experience.glass', 72);
  const [savedEdge, saveEdge] = usePref<boolean>('experience.edge', true);
  const scene = ATMOSPHERES.some(s => s.id === savedScene) ? savedScene as Atmosphere : 'grid';
  const glass = Number.isFinite(savedGlass) ? Math.max(40, Math.min(96, savedGlass)) : 72;
  const edge = typeof savedEdge === 'boolean' ? savedEdge : true;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.atmosphere = scene;
    root.dataset.edgeLight = String(edge);
    root.style.setProperty('--glass-opacity', String(glass / 100));
  }, [scene, glass, edge]);
  return <Context.Provider value={{scene, glass, edge, setScene: saveScene, setGlass: saveGlass, setEdge: saveEdge}}>{children}</Context.Provider>;
}

/** Decorative effects only. They do not represent AI activity or capture screen contents. */
export function ExperienceBackdrop() {
  const {scene, edge} = useContext(Context);
  const spot = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    let frame = 0;
    let x = 0; let y = 0;
    const move = (e: PointerEvent) => {
      if (document.hidden || document.documentElement.dataset.motion === 'reduced') return;
      x = e.clientX; y = e.clientY;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        spot.current?.style.setProperty('--pointer-x', `${x}px`);
        spot.current?.style.setProperty('--pointer-y', `${y}px`);
      });
    };
    const visibility = () => setHidden(document.hidden);
    document.addEventListener('pointermove', move, {passive: true});
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointermove', move); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  return <><div className="experience-effects" data-scene={scene} data-paused={hidden || undefined} aria-hidden="true">
    <div className="experience-color" />
    {scene === 'flow' && <CompanionField immersive />}
    {scene === 'grid' && <><div className="experience-horizon" /><div className="experience-grid" /></>}
    {scene === 'ascii' && <AsciiField />}
    {scene !== 'quiet' && <div className="experience-pointer" ref={spot} />}
  </div>{edge && <div className="experience-edge" data-paused={hidden || undefined} aria-hidden="true" />}</>;
}

export function ExperienceControls({compact = false}: {compact?: boolean}) {
  const {scene, glass, edge, setScene, setGlass, setEdge} = useContext(Context);
  const controls = <div className="effects-controls">
    <p className="effects-kicker">Make it feel like you</p>
    <div className="effects-presets" role="radiogroup" aria-label="Visual atmosphere">
      {ATMOSPHERES.map(p => <button key={p.id} type="button" role="radio" aria-label={p.name} aria-checked={scene === p.id} data-effect={p.id} onClick={() => setScene(p.id)} title={p.description}>
        <span className="effects-swatch" aria-hidden="true" /><strong>{p.name}</strong>
      </button>)}
    </div>
    <label className="effects-range"><span>Glass opacity <output>{glass}%</output></span><input type="range" aria-label="Glass opacity" min="40" max="96" value={glass} onChange={e => setGlass(Number(e.target.value))} /></label>
    <label className="effects-toggle"><span>Perimeter lighting</span><input type="checkbox" aria-label="Perimeter lighting" checked={edge} onChange={e => setEdge(e.target.checked)} /></label>
    <p className="effects-note">Effects pause when hidden and follow Reduce motion. Desktop blur also depends on Windows material support.</p>
  </div>;
  if (!compact) return controls;
  return <details className="effects-popover" onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary><Sparkle size={16} aria-hidden="true" /><span>Look & motion</span><span className="effects-current">{ATMOSPHERES.find(p => p.id === scene)?.name}</span></summary>
    {controls}
  </details>;
}
