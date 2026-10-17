import {useState} from 'react';
import {ArrowClockwise, ArrowRight, HandWaving, Sparkle} from '@phosphor-icons/react';
import {CompanionPet} from './CompanionPet';
import {ExperienceControls} from './ExperienceEffects';
import {PET_ROWS, PET_STATES, type PetState} from '../pet/contract';
import {useReady} from '../ui/store';
import {Switch} from '../ui/primitives';
import '../styles/character-studio.css';

const NAMES: Record<PetState, string> = {idle: 'At ease', 'running-right': 'Run right', 'running-left': 'Run left', waving: 'Say hello', jumping: 'Little leap', failed: 'Something went wrong', waiting: 'Your turn', running: 'Thinking', review: 'Checking'};

/** Explicit animation preview. Selecting a pose never starts an AI request or an app action. */
export function CharacterStudio() {
  const [pose, setPose] = useState<PetState>('idle');
  const [direction, setDirection] = useState<number | null>(null);
  const [replay, setReplay] = useState(0);
  const {settings, api, mutate} = useReady();
  return <div className="character-studio">
    <header className="character-heading"><p>Your companion, in motion</p><h1>Small companion.<br /><em>Quite a character.</em></h1><span>An original character with real frame animation. Every pose below is a preview.</span></header>
    <div className="character-workbench">
      <section className="character-stage" aria-label="Character animation preview">
        <div className="character-stage-rings" aria-hidden="true" />
        <span className="character-preview-label"><Sparkle size={13} aria-hidden="true" /> Animation preview</span>
        <div className="character-actor"><CompanionPet pose={pose} look={direction} replay={replay} showWhenHidden /></div>
        <div className="character-stage-caption"><strong>{direction === null ? NAMES[pose] : `Looking ${direction * 22.5}° clockwise from up`}</strong><span>{direction === null ? `${PET_ROWS[pose].durations.length} generated poses` : 'A physical head and eye pose'} · Preview only</span></div>
      </section>
      <div className="character-tuning">
        <section aria-labelledby="character-poses"><h2 id="character-poses">Try a little personality</h2><p>Distinct poses and expressions, played from the sprite sheet.</p>
          <div className="character-poses" role="group" aria-label="Preview an animation">{PET_STATES.map(state => <button key={state} type="button" aria-pressed={pose === state && direction === null} onClick={() => {setDirection(null); setPose(state); setReplay(value => value + 1);}}>{state === 'waving' && <HandWaving size={15} aria-hidden="true" />}{NAMES[state]}<ArrowRight size={13} aria-hidden="true" /></button>)}</div>
          <button type="button" className="linkbtn character-replay" disabled={direction !== null} onClick={() => setReplay(value => value + 1)}><ArrowClockwise size={14} aria-hidden="true" /> Replay animation</button>
        </section>
        <section><label className="character-look"><span>Look around <output>{direction === null ? 'Neutral' : `${direction * 22.5}°`}</output></span><input type="range" min="0" max="15" value={direction ?? 0} onChange={e => setDirection(Number(e.target.value))} aria-label="Preview look direction" /></label><button type="button" className="linkbtn" onClick={() => {setDirection(null);setPose('idle');}}>Back to resting</button></section>
        <section><Switch label="Reduce motion everywhere" description="Still poses and simpler transitions. The Windows motion setting is respected too." checked={settings.reduceMotion} onChange={value => void mutate(() => api.saveSettings({reduceMotion: value}))} /></section>
        <section><ExperienceControls /></section>
      </div>
    </div>
  </div>;
}
