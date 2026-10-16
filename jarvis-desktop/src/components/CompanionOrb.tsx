import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { stateLabel, type CompanionAppearance } from '../ui/appearance';
import { useAppearance } from '../ui/appearance-context';
import { hostVoiceLevel, readReducedMotion, useOptionalCompanion } from '../ui/companion';
import { orbEngine, type OrbPlacement } from '../ui/orb-engine';
import { cx } from '../ui/util';

/**
 * The companion, wherever it appears. Every placement uses this component and the shared renderer in
 * src/ui/orb-engine.ts, so the Studio preview and the small shell mark are the same drawing.
 *
 * By default it follows the live companion state and the real microphone level (only while a recording is attached).
 * Studio passes `state` explicitly for labelled previews and `appearance` for preset thumbnails.
 * The canvas is decorative; the accessible name and any status text live outside it.
 */
export function CompanionOrb({
  size,
  state,
  level,
  appearance: override,
  label,
  decorative,
  showWhenHidden,
  className,
}: {
  size: number;
  state?: string;
  /** Measured level 0..1, or null for none. Omit to use the live companion level. */
  level?: number | null;
  appearance?: CompanionAppearance;
  label?: string;
  decorative?: boolean;
  /** Studio keeps drawing the companion even when it is hidden elsewhere, so it can be turned back on. */
  showWhenHidden?: boolean;
  className?: string;
}) {
  const [stored] = useAppearance();
  const appearance = override ?? stored;
  const companion = useOptionalCompanion();
  const s = state ?? companion?.state ?? 'idle';
  const lv = level !== undefined ? level : companion ? hostVoiceLevel(companion) : null;
  const shown = appearance.visible || Boolean(showWhenHidden);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ appearance, state: s, level: lv });
  live.current = { appearance, state: s, level: lv };
  const placement = useRef<OrbPlacement | null>(null);
  const uid = useId();

  useEffect(() => {
    const engine = orbEngine();
    const canvas = canvasRef.current;
    if (!engine || !canvas || !shown) return undefined;
    let seed = 0;
    for (const ch of uid) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
    const p: OrbPlacement = { canvas, cssSize: size, visible: true, params: () => ({ ...live.current, reducedMotion: readReducedMotion(), seed }) };
    placement.current = p;
    const off = engine.add(p);
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        p.visible = entries.some((e) => e.isIntersecting);
        if (p.visible) engine.invalidate(p);
      });
      io.observe(canvas);
    }
    return () => {
      io?.disconnect();
      off();
      placement.current = null;
    };
  }, [size, shown, uid]);

  useEffect(() => {
    const engine = orbEngine();
    if (engine && placement.current) engine.invalidate(placement.current);
  }, [appearance.form, appearance.tint, appearance.motion, s, lv]);

  if (!shown) return null;
  const style = { '--orb-size': `${size}px` } as CSSProperties;
  return (
    <span
      className={cx('orb', className)}
      style={style}
      data-state={s}
      data-form={appearance.form}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label ?? `Companion: ${stateLabel(s)}`}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
    </span>
  );
}

/**
 * The companion inside its HUD frame: four corner brackets and a caption line with the real state. Used wherever the
 * companion is the focal point (Today, the empty Assistant, first run, Studio), so the motif means "this is the core".
 * The caption is text outside the canvas, so state never depends on the drawing.
 */
export function CoreFrame({ size, state, caption, children, className, ...orb }: Parameters<typeof CompanionOrb>[0] & { caption?: string; children?: ReactNode }) {
  const companion = useOptionalCompanion();
  const [stored] = useAppearance();
  const s = state ?? companion?.state ?? 'idle';
  if (!(orb.appearance ?? stored).visible && !orb.showWhenHidden) return null;
  return (
    <div className={cx('core-frame', className)} data-state={s} style={{ '--frame': `${size}px` } as CSSProperties}>
      <span className="core-corner tl" aria-hidden="true" />
      <span className="core-corner tr" aria-hidden="true" />
      <span className="core-corner bl" aria-hidden="true" />
      <span className="core-corner br" aria-hidden="true" />
      <CompanionOrb size={size} state={state} {...orb} />
      <p className="core-caption" aria-live="polite">
        <span className="core-diode" aria-hidden="true" />
        {caption ?? `Core · ${stateLabel(s)}`}
      </p>
      {children}
    </div>
  );
}
