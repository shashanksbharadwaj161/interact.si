import { useEffect, useState } from 'react';

const read = () =>
  typeof document !== 'undefined' &&
  (document.documentElement.dataset.motion === 'reduced' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches));

/**
 * Reduced motion, live: the OS preference or the app's own setting (the root `data-motion="reduced"` attribute, which
 * the companion document mirrors from the app settings). Updates when either changes, without a reload.
 */
export function useReducedMotion(): boolean {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const update = () => setOn(read());
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    mq?.addEventListener('change', update);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    update();
    return () => {
      mq?.removeEventListener('change', update);
      mo?.disconnect();
    };
  }, []);
  return on;
}
