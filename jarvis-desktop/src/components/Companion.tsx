import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowCounterClockwise, Check, PencilSimple } from '@phosphor-icons/react';
import { CompanionOrb } from './CompanionOrb';
import { SceneBackdrop } from './SceneBackdrop';
import { Button, PageHeader, Segmented, Switch } from '../ui/primitives';
import { readReducedMotion, useAnimMachine, useCompanion } from '../ui/companion';
import { useAppearance } from '../ui/appearance-context';
import { COMPANION_STATES, DEFAULT_APPEARANCE, FORMS, TINT_PRESETS, formInfo, sameAppearance, stateLabel, type CompanionAppearance, type CompanionMotion, type CompanionState } from '../ui/appearance';
import { AVATAR_PREF_KEY, DEFAULT_PACK, packFromStorage, serializeAvatarPack } from '../ui/avatar-editor';
import { readPref, usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { SCENES } from '../ui/scenes';
import { cx } from '../ui/util';
import '../styles/studio.css';

type Preview = CompanionState | 'live';
const STAGE_PLAIN = 'plain';

/**
 * Studio: choose the companion used everywhere. The stage, the form thumbnails, the shell, Today and the Assistant all
 * draw through the same renderer. Changes are a draft until Apply, which saves the choice on this computer and updates
 * every placement at once; Revert drops the draft. Preview states are labelled as previews: they never change what the
 * app is doing, and the Live option shows the real state.
 */
export function Companion() {
  const { settings, api, mutate } = useReady();
  const live = useCompanion();
  const [applied, setApplied] = useAppearance();
  const [draft, setDraft] = useState<CompanionAppearance>(applied);
  const [preview, setPreview] = useState<Preview>('live');
  const [stageScene, setStageScene] = usePref<string>('studio.stage', STAGE_PLAIN);
  const [justApplied, setJustApplied] = useState(false);
  useEffect(() => setDraft(applied), [applied]);
  const dirty = !sameAppearance(draft, applied);
  const shown = preview === 'live' ? live.state : preview;
  const reducedMotion = settings.reduceMotion || readReducedMotion();
  // The state label opens when the companion is busy, crossfades between states and closes on idle. A change mid-fade
  // interrupts from the current progress instead of restarting.
  const status = useAnimMachine(shown === 'idle' ? null : shown, { reducedMotion });
  const statusStyle = { '--anim-progress': status.progress } as CSSProperties;
  const hasCustomPack = serializeAvatarPack(packFromStorage(readPref<unknown>(AVATAR_PREF_KEY, null))) !== serializeAvatarPack(DEFAULT_PACK);
  const set = (patch: Partial<CompanionAppearance>) => {
    setJustApplied(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const apply = () => {
    setApplied(draft);
    setJustApplied(true);
  };

  return (
    <div className="page page-wide studio">
      <PageHeader
        title="Companion"
        subtitle="Choose the companion shown across the app. It reflects what the app is really doing: ready, listening, transcribing, working, speaking or needing attention."
        actions={
          <div className="studio-apply" role="group" aria-label="Apply changes">
            <span className={cx('studio-dirty', dirty && 'on')} role="status">
              {dirty ? 'Not applied yet' : justApplied ? 'Applied everywhere' : 'In use everywhere'}
            </span>
            <Button icon={ArrowCounterClockwise} disabled={!dirty} onClick={() => setDraft(applied)}>
              Revert
            </Button>
            <Button variant="primary" icon={Check} disabled={!dirty} onClick={apply}>
              Apply
            </Button>
          </div>
        }
      />

      <div className="studio-grid">
        <section className="studio-stage-wrap" aria-label="Preview">
          <div className={cx('studio-stage', stageScene !== STAGE_PLAIN && 'has-scene')}>
            {stageScene !== STAGE_PLAIN && <SceneBackdrop scene={stageScene} className="stage-scene" />}
            <CompanionOrb size={300} state={shown} level={preview === 'live' ? undefined : null} appearance={draft} showWhenHidden label={`${formInfo(draft.form).name} companion, ${stateLabel(shown)}${preview === 'live' ? '' : ' (preview)'}`} />
            {status.shown !== null && (
              <span className="stage-status anim-slot" data-anim-phase={status.phase} style={statusStyle} aria-hidden="true">
                {stateLabel(status.shown)}
              </span>
            )}
            <p className="stage-caption">{preview === 'live' ? `Live: ${stateLabel(live.state)}` : `Preview only: ${stateLabel(preview)}. The app is not doing this.`}</p>
          </div>
          <div className="studio-preview">
            <Segmented<Preview>
              label="Preview a state"
              value={preview}
              onChange={setPreview}
              options={[{ value: 'live', label: 'Live' }, ...COMPANION_STATES.map((s) => ({ value: s.id, label: s.label, hint: s.description }))]}
            />
            <p className="field-hint">Live follows the app. The other states are previews for this stage only. Listening only reacts to sound while you are really recording in the Assistant.</p>
          </div>
        </section>

        <div className="studio-controls">
          <section className="section" aria-labelledby="studio-form">
            <h2 id="studio-form">Form</h2>
            <div className="form-list" role="radiogroup" aria-labelledby="studio-form">
              {FORMS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={draft.form === f.id}
                  className={cx('form-card', draft.form === f.id && 'on')}
                  onClick={() => set({ form: f.id, tint: f.id === draft.form ? draft.tint : f.id === 'character' ? draft.tint : f.defaultTint })}
                >
                  <CompanionOrb size={64} state="idle" level={null} appearance={{ ...draft, form: f.id, tint: f.id === draft.form ? draft.tint : f.defaultTint, motion: 'still' }} decorative showWhenHidden />
                  <span className="grow">
                    <strong>{f.name}</strong>
                    <span className="sub">{f.id === 'character' && !hasCustomPack ? 'The default character from earlier versions. Edit it in the Character editor.' : f.description}</span>
                  </span>
                  {draft.form === f.id && <Check size={18} weight="bold" aria-hidden className="form-check" />}
                </button>
              ))}
            </div>
            {draft.form === 'character' && (
              <a className="btn btn-sm studio-edit" href="#/avatar">
                <PencilSimple size={14} aria-hidden /> Edit the character
              </a>
            )}
          </section>

          {draft.form !== 'character' && (
            <section className="section" aria-labelledby="studio-light">
              <h2 id="studio-light">Inner light</h2>
              <div className="tint-row" role="radiogroup" aria-labelledby="studio-light">
                {TINT_PRESETS.map((t) => (
                  <button key={t.name} type="button" role="radio" aria-checked={draft.tint === t.hue} aria-label={t.name} title={t.name} className={cx('tint', draft.tint === t.hue && 'on')} style={{ '--tint': `hsl(${t.hue} 62% 58%)` } as CSSProperties} onClick={() => set({ tint: t.hue })} />
                ))}
                <label className="tint-custom">
                  <span className="sub">Hue {draft.tint}°</span>
                  <input type="range" min={0} max={359} value={draft.tint} aria-label="Custom hue" onChange={(e) => set({ tint: Number(e.target.value) })} />
                </label>
              </div>
            </section>
          )}

          <section className="section" aria-labelledby="studio-motion">
            <h2 id="studio-motion">Motion</h2>
            <Segmented<CompanionMotion>
              label="Companion motion"
              value={draft.motion}
              onChange={(v) => set({ motion: v })}
              options={[
                { value: 'live', label: 'Lively', hint: 'Smooth motion while the app works' },
                { value: 'calm', label: 'Calm', hint: 'Slower, lower frame rate' },
                { value: 'still', label: 'Still', hint: 'No animation; redrawn only when the state changes' },
              ]}
            />
            <Switch
              label="Reduce motion everywhere"
              description="Stills the companion and shortens screen transitions across the app. The Windows setting is respected too. Saved with your settings."
              checked={settings.reduceMotion}
              onChange={(v) => void mutate(() => api.saveSettings({ reduceMotion: v }))}
            />
          </section>

          <section className="section" aria-labelledby="studio-show">
            <h2 id="studio-show">Where it appears</h2>
            <Switch
              label="Show the companion"
              description={draft.visible ? 'Shown in the sidebar, on Today and in the Assistant.' : 'Hidden everywhere except this Studio page. State is still written as text.'}
              checked={draft.visible}
              onChange={(v) => set({ visible: v })}
            />
            <div className="field">
              <label htmlFor="studio-stage-scene">Studio backdrop</label>
              <select id="studio-stage-scene" className="input" value={stageScene} onChange={(e) => setStageScene(e.target.value)}>
                <option value={STAGE_PLAIN}>Plain</option>
                {SCENES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="field-hint">Only behind this preview. The rest of the app stays plain so text is easy to read.</p>
            </div>
            <button type="button" className="linkbtn" disabled={sameAppearance(draft, DEFAULT_APPEARANCE)} onClick={() => set({ ...DEFAULT_APPEARANCE })}>
              Back to the default companion
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
