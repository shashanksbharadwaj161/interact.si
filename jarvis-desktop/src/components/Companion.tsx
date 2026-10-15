import { useState, type CSSProperties } from 'react';
import { Avatar, AVATAR_STATES, type AvatarState } from './Avatar';
import { SceneBackdrop } from './SceneBackdrop';
import { PageHeader, Panel, Segmented, Switch, Notice } from '../ui/primitives';
import { readReducedMotion, useAnimMachine, useCompanion } from '../ui/companion';
import { usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { DEFAULT_SCENE, SCENES } from '../ui/scenes';
import { cx } from '../ui/util';

export function Companion() {
  const { settings, api, mutate } = useReady();
  const live = useCompanion();
  const [scene, setScene] = usePref('scene', DEFAULT_SCENE);
  const [pose, setPose] = useState<AvatarState | 'live'>('live');
  const shown = pose === 'live' ? live.state : pose;
  const reducedMotion = settings.reduceMotion || readReducedMotion();
  // Status badge: opens when the assistant becomes busy (listening/thinking/speaking/alert), crossfades between
  // states and closes on idle. A change mid-fade interrupts from the current progress instead of restarting.
  const status = useAnimMachine(shown === 'idle' ? null : shown, { reducedMotion });
  const statusStyle = { '--anim-progress': status.progress } as CSSProperties;

  return (
    <div className="page">
      <PageHeader eyebrow="Cockpit" title="Companion" subtitle="An original, procedurally drawn 2D avatar and scene backdrops. All shapes are CSS; no images or external assets." />

      <div className="companion-grid">
        <section className="stage-card" aria-label="Avatar preview">
          <SceneBackdrop scene={scene} className="stage-scene" />
          <div className="stage-avatar">
            <Avatar state={shown} size={240} level={pose === 'live' ? live.level : 0} />
          </div>
          {status.shown !== null && (
            <span className="stage-status anim-slot" data-anim-phase={status.phase} style={statusStyle} aria-hidden="true">
              {status.shown}
            </span>
          )}
          <p className="stage-caption">
            {pose === 'live' ? `Live state: ${live.state}` : `Previewing pose: ${pose}`}
          </p>
        </section>

        <div className="stack">
          <Panel title="Pose preview" eyebrow="Avatar">
            <Segmented<AvatarState | 'live'>
              label="Preview pose"
              value={pose}
              onChange={setPose}
              options={[{ value: 'live', label: 'Live' }, ...AVATAR_STATES.map((s) => ({ value: s.id, label: s.label }))]}
            />
            <p className="field-hint">
              “Live” follows the app: listening while you record, thinking while a reply or transcript is pending, speaking during playback, alert after an error. Other poses are manual previews only. The face is not driven by audio yet.
            </p>
          </Panel>

          <Panel title="Animation" eyebrow="Motion">
            <Switch
              label="Reduce motion (turn animations off)"
              description="Stops avatar, scene and panel animation. The Windows reduced-motion setting also turns it off automatically. Saved with your settings."
              checked={settings.reduceMotion}
              onChange={(v) => void mutate(() => api.saveSettings({ reduceMotion: v }))}
            />
          </Panel>

          <Panel title="Scene" eyebrow="Backdrop">
            <div className="scene-grid" role="radiogroup" aria-label="Scene">
              {SCENES.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={scene === s.id} className={cx('scene-card', scene === s.id && 'on')} onClick={() => setScene(s.id)}>
                  <span className="scene-thumb">
                    <SceneBackdrop scene={s.id} />
                  </span>
                  <strong>{s.name}</strong>
                  <span className="sub">{s.blurb}</span>
                </button>
              ))}
            </div>
            <Notice>The chosen scene is a display preference for this app. Individual capsules can also name a scene in the capsule editor.</Notice>
          </Panel>
        </div>
      </div>
    </div>
  );
}
