import type { CSSProperties } from 'react';
import { isMouthState, isPoseState, type MouthState, type PoseState } from '../ui/avatar-voice';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert';

export const AVATAR_STATES: { id: AvatarState; label: string }[] = [
  { id: 'idle', label: 'Idle' },
  { id: 'listening', label: 'Listening' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'speaking', label: 'Speaking' },
  { id: 'alert', label: 'Alert' },
];

/**
 * Original procedural 2D companion drawn only with CSS shapes. Its state is driven by what the app
 * is actually doing (recording, waiting for a reply, speaking, error). When a voice link passes
 * `mouth` and `pose` (from speech playback events), they are rendered as data-mouth / data-pose and
 * classes on the mouth and head layers; reduced motion keeps the shapes but drops the head tilt.
 */
export function Avatar({
  state = 'idle',
  size = 160,
  level = 0,
  label,
  mouth,
  pose,
}: {
  state?: AvatarState;
  size?: number;
  level?: number;
  label?: string;
  /** Mouth shape from the voice link; defaults to closed. */
  mouth?: MouthState;
  /** Head pose from the voice link; defaults to idle. */
  pose?: PoseState;
}) {
  const style = { '--av-size': `${size}px`, '--av-level': level.toFixed(2) } as CSSProperties;
  const m: MouthState = isMouthState(mouth) ? mouth : 'closed';
  const p: PoseState = isPoseState(pose) ? pose : 'idle';
  const linked = mouth !== undefined || pose !== undefined;
  return (
    <div
      className="avatar"
      data-state={state}
      style={style}
      role="img"
      aria-label={label ?? `Companion, ${state}`}
      data-mouth={m}
      data-pose={p}
      data-voice-link={linked ? 'on' : undefined}
    >
      <div className="av-halo" />
      <div className="av-ring av-ring-a" />
      <div className="av-ring av-ring-b" />
      <div className="av-body">
        <div className="av-antenna">
          <i />
        </div>
        <div className={`av-head av-pose-${p}`}>
          <div className="av-visor">
            <span className="av-eye av-eye-l" />
            <span className="av-eye av-eye-r" />
            <span className={`av-mouth av-mouth-${m}`} />
          </div>
          <span className="av-cheek av-cheek-l" />
          <span className="av-cheek av-cheek-r" />
        </div>
        <div className="av-neck" />
        <div className="av-shoulders" />
      </div>
      <i className="av-spark av-spark-1" />
      <i className="av-spark av-spark-2" />
      <i className="av-spark av-spark-3" />
    </div>
  );
}
