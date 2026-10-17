import '../styles/pet.css';

/** Canonical concept artwork, not the final 73-frame sprite atlas. Motion reflects real app state. */
export function CompanionPet({state = 'idle', decorative = false}: {state?: 'idle' | 'working' | 'waiting' | 'done' | 'error'; decorative?: boolean}) {
  return <span className="companion-pet" data-state={state}>
    <img src="./pets/first-light/concept.png" alt={decorative ? '' : 'Cream and indigo companion with one folded ear'} draggable={false} />
  </span>;
}
