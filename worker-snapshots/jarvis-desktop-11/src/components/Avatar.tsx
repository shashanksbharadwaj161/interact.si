import type { CSSProperties } from 'react';

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
 * is actually doing (recording, waiting for a reply, speaking, error); it is not a voice-driven face.
 */
export function Avatar({ state = 'idle', size = 160, level = 0, label }: { state?: AvatarState; size?: number; level?: number; label?: string }) {
  const style = { '--av-size': `${size}px`, '--av-level': level.toFixed(2) } as CSSProperties;
  return (
    <div className="avatar" data-state={state} style={style} role="img" aria-label={label ?? `Companion, ${state}`}>
      <div className="av-halo" />
      <div className="av-ring av-ring-a" />
      <div className="av-ring av-ring-b" />
      <div className="av-body">
        <div className="av-antenna">
          <i />
        </div>
        <div className="av-head">
          <div className="av-visor">
            <span className="av-eye av-eye-l" />
            <span className="av-eye av-eye-r" />
            <span className="av-mouth" />
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
