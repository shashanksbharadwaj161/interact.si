import { useMemo } from 'react';
import { starShadow } from '../ui/scenes';

export function SceneBackdrop({ scene, className = '' }: { scene: string; className?: string }) {
  const stars = useMemo(() => ({ a: starShadow(46, 11), b: starShadow(22, 29) }), []);
  return (
    <div className={`scene ${className}`} data-scene={scene} aria-hidden="true">
      <div className="scene-wash" />
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
