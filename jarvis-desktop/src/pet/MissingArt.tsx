import { petBoxWidth } from './PetSprite';

/**
 * The explicit missing-art state: the same box the character would occupy, saying plainly that no approved character
 * art is installed and why. It is text on calm glass, never a creature, face, silhouette or procedural stand-in.
 */
export function MissingArt({ size, reason, status = 'missing' }: { size: number; reason: string; status?: 'missing' | 'invalid' }) {
  const width = petBoxWidth(size);
  // Small boxes keep a short label on screen; the full reason is always in the accessible name and the tooltip.
  const level = size < 96 ? 'compact' : size < 128 ? 'medium' : 'full';
  const title = status === 'invalid' ? 'Character art could not be used' : 'Character art not installed';
  return (
    <div className="pet-missing" data-level={level} data-status={status} style={{ width, height: size }} title={`${title}. ${reason}`} role="img" aria-label={`${title}. ${reason}`}>
      <span className="pet-missing-title">{level === 'compact' ? (status === 'invalid' ? 'Art error' : 'Art pending') : title}</span>
      {level === 'full' && <span className="pet-missing-reason">{reason}</span>}
    </div>
  );
}
