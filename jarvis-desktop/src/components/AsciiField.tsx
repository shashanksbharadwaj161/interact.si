import {useEffect, useRef} from 'react';

/** Original projected wave surface. Decorative glyphs, never model output or activity. */
export function AsciiField() {
  const host = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0; let last = 0; let visible = true;
    const reduced = () => media.matches || document.documentElement.dataset.motion === 'reduced';
    const render = (now: number) => {
      const phase = reduced() ? .8 : now * .00022;
      const rows: string[] = [];
      const ramp = ' ·:;+*ox%#@';
      for (let y = 0; y < 24; y++) {
        let line = '';
        for (let x = 0; x < 88; x++) {
          const dx = (x - 44) / 14; const dy = (y - 12) / 6;
          const radius = Math.hypot(dx, dy);
          const wave = Math.sin(radius * 2.1 - phase * 2) * .55 + Math.cos(dx * 1.4 + phase) * .28 + Math.sin(dy * 2.6 + phase * .7) * .17;
          const light = Math.max(0, Math.min(1, (wave + 1) * .5 * Math.max(0, 1 - radius / 4.2)));
          line += ramp[Math.round(light * (ramp.length - 1))];
        }
        rows.push(line);
      }
      element.textContent = rows.join('\n');
    };
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || !visible || reduced()) return;
      if (now - last >= 100) {render(now); last = now;}
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame); frame = 0; render(performance.now());
      if (!document.hidden && visible && !reduced()) frame = requestAnimationFrame(tick);
    };
    const intersection = new IntersectionObserver(entries => {visible = entries[0]?.isIntersecting ?? false; sync();});
    const attributes = new MutationObserver(sync);
    intersection.observe(element);
    attributes.observe(document.documentElement, {attributes: true, attributeFilter: ['data-motion']});
    document.addEventListener('visibilitychange', sync);
    media.addEventListener('change', sync);
    sync();
    return () => {cancelAnimationFrame(frame); intersection.disconnect(); attributes.disconnect(); document.removeEventListener('visibilitychange', sync); media.removeEventListener('change', sync);};
  }, []);
  return <pre ref={host} className="experience-ascii" aria-hidden="true" />;
}
