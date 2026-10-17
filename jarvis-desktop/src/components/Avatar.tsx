import { COMPANION_STATES, type CompanionState } from '../ui/appearance';
import { CompanionOrb } from './CompanionOrb';

/** Companion state ids. Kept under the older name so existing imports keep working. */
export type AvatarState = CompanionState;

/** Display labels: thinking is shown as Working and alert as Needs attention. */
export const AVATAR_STATES: { id: AvatarState; label: string }[] = COMPANION_STATES.map((s) => ({ id: s.id, label: s.label }));

/**
 * Compatibility wrapper. The old hardcoded CSS robot is gone: every placement now draws the appearance chosen in
 * Studio through the shared renderer. `level` is only a real measured amplitude; omit it when nothing is attached.
 */
export function Avatar({ state = 'idle', size = 160, level, label }: { state?: AvatarState; size?: number; level?: number | null; label?: string }) {
  return <CompanionOrb size={size} state={state} level={level} label={label} />;
}
