import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {companionApi} from './api';

/*
 * The screen-region picker. It covers one display with a frozen picture of that display, taken by the main process when
 * the person chose "Select a region". Nothing is live here and nothing leaves the computer from this page: the page sends
 * only the rectangle, the main process crops its own copy of the picture, and the request is sent only if the person
 * then asks something. Escape or Cancel throws the picture away.
 */

type Rect = {x: number; y: number; width: number; height: number};
const MIN = 12;

export function RegionOverlay() {
  const api = companionApi();
  const [shot, setShot] = useState<{dataUrl: string; width: number; height: number} | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useRef<{x: number; y: number} | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.classList.add('ov-body');
    if (!api) return undefined;
    void api.overlayImage().then((s) => {
      if (s) setShot(s);
      else setProblem('The picture of the screen is no longer available. Close this and try again.');
    });
    root.current?.focus();
    return () => document.body.classList.remove('ov-body');
  }, [api]);

  const cancel = () => void api?.overlayCancel();
  const submit = async (r: Rect | null) => {
    if (!api || !r || busy) return;
    if (r.width < MIN || r.height < MIN) {
      setProblem('Drag a larger area, or use the whole screen.');
      return;
    }
    setBusy(true);
    const res = await api.overlaySubmit(r).catch(() => ({ok: false as const, reason: 'The selection could not be used.'}));
    setBusy(false);
    if (!res.ok) setProblem(res.reason);
  };
  const whole = (): Rect | null => (shot ? {x: 0, y: 0, width: shot.width, height: shot.height} : null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && sel && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void submit(sel);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const point = (e: ReactPointerEvent) => ({x: Math.max(0, Math.min(e.clientX, window.innerWidth)), y: Math.max(0, Math.min(e.clientY, window.innerHeight))});
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ov-bar')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = point(e);
    setProblem(null);
    setSel({...start.current, width: 0, height: 0});
  };
  const move = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const p = point(e);
    setSel({x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y)});
  };
  const up = () => {
    start.current = null;
  };

  if (!api) return <p className="cmp-browser">This page runs inside the Desktop Companion app.</p>;
  const ready = !!sel && sel.width >= MIN && sel.height >= MIN;
  return (
    <div ref={root} className="ov" tabIndex={-1} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Select a region of the screen">
      {shot && <img className="ov-shot" src={shot.dataUrl} alt="" draggable={false} />}
      <div className="ov-dim" style={sel ? {clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${sel.x}px ${sel.y}px, ${sel.x}px ${sel.y + sel.height}px, ${sel.x + sel.width}px ${sel.y + sel.height}px, ${sel.x + sel.width}px ${sel.y}px, ${sel.x}px ${sel.y}px)`} : undefined} />
      {sel && sel.width > 0 && (
        <div className="ov-sel" style={{left: sel.x, top: sel.y, width: sel.width, height: sel.height}}>
          <span className="ov-size">
            {Math.round(sel.width)} × {Math.round(sel.height)}
          </span>
        </div>
      )}
      <div className="ov-bar" role="toolbar" aria-label="Region selection">
        <span className="ov-hint" role="status">
          {problem ?? (shot ? (ready ? 'Enter uses this area. Drag again to change it.' : 'Drag across the part of the screen to ask about.') : 'Loading the picture…')}
        </span>
        <span className="ov-note">Frozen picture of this screen. Only the area you choose is kept, and it is sent only with your next request.</span>
        <button type="button" className="btn" onClick={() => void submit(whole())} disabled={!shot || busy}>
          Whole screen
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit(sel)} disabled={!ready || busy}>
          Use area
        </button>
        <button type="button" className="btn" onClick={cancel}>
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}
