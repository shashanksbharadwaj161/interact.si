import {useEffect, useRef} from 'react';

/** Decorative laminar field. No app activity, audio, or model output is represented here. */
export function CompanionField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let frame = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    let visible = true;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => media.matches || document.documentElement.dataset.motion === 'reduced';
    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      const phase = reduced() ? 0 : time * .00008;
      for (let row = 0; row < 23; row++) {
        context.beginPath();
        context.strokeStyle = `rgba(163, 190, 231, ${.025 + row / 850})`;
        context.lineWidth = .7;
        for (let x = -20; x <= width + 20; x += 10) {
          const y = height * .45 + row * 11 + Math.sin(x / 130 + phase + row * .12) * 36 + Math.cos(x / 210 - phase) * 22;
          if (x === -20) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.stroke();
      }
    };
    const tick = (time: number) => {
      frame = 0;
      if (document.hidden || !visible || reduced()) return;
      if (time - last > 33) { draw(time); last = time; }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      draw(performance.now());
      if (!document.hidden && visible && !reduced()) frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      sync();
    });
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; sync(); });
    const attributes = new MutationObserver(sync);
    resize.observe(canvas);
    observer.observe(canvas);
    attributes.observe(document.documentElement, {attributes: true, attributeFilter: ['data-motion']});
    document.addEventListener('visibilitychange', sync);
    media.addEventListener('change', sync);
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); observer.disconnect(); attributes.disconnect();
      document.removeEventListener('visibilitychange', sync); media.removeEventListener('change', sync);
    };
  }, []);
  return <canvas className="companion-field" ref={ref} aria-hidden="true" />;
}
