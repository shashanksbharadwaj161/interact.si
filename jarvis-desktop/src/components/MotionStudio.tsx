import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, FloppyDisk, Pause, Planet, Play, Sparkle, Trash, Waves } from '@phosphor-icons/react';
import { Badge, Button, Field, IconButton, Notice, Panel, Segmented } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { cx } from '../ui/util';
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  LIMITS,
  MAX_PRESET_NAME,
  MAX_SAVED_PRESETS,
  MOTION_KINDS,
  PRESET_PREF_KEY,
  describeSettings,
  hueColor,
  makePresetId,
  normalizePresetName,
  normalizeSettings,
  orbitCount,
  orbitPosition,
  parseSavedPresets,
  particleCount,
  removePreset,
  seedOrbits,
  seedParticles,
  stepParticles,
  timeScale,
  upsertPreset,
  waveLayerCount,
  wavePoint,
  type MotionKind,
  type MotionSettings,
  type OrbitBody,
  type Particle,
  type SavedPreset,
} from '../ui/motion-presets';
import '../styles/motion-studio.css';

/**
 * Motion Studio: a self-contained, offline canvas playground with three procedural presets.
 * It never calls the backend. The only thing it stores is the user's preset list (kind, three
 * numbers, a short name) under the non-sensitive UI preference prefix.
 */

const KIND_ICON: Record<MotionKind, typeof Waves> = { wave: Waves, particles: Sparkle, orbit: Planet };
const MAX_DPR = 2;
/** Largest step we will simulate for one frame, so a background tab does not "catch up" with a jump. */
const MAX_FRAME_S = 0.05;

type Sim = {
  t: number;
  seed: number;
  particles: Particle[];
  orbits: OrbitBody[];
  /** Settings the cached particle/orbit sets were built for. */
  built: { kind: MotionKind; intensity: number } | null;
};

function ensureSim(sim: Sim, s: MotionSettings): void {
  if (sim.built && sim.built.kind === s.kind && sim.built.intensity === s.intensity) return;
  if (s.kind === 'particles') sim.particles = seedParticles(particleCount(s.intensity), sim.seed);
  if (s.kind === 'orbit') sim.orbits = seedOrbits(orbitCount(s.intensity), sim.seed);
  sim.built = { kind: s.kind, intensity: s.intensity };
}

function drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, s: MotionSettings, t: number): void {
  const layers = waveLayerCount(s.intensity);
  const step = Math.max(3, Math.round(w / 180));
  for (let layer = layers - 1; layer >= 0; layer--) {
    ctx.beginPath();
    for (let x = 0; x <= w + step; x += step) {
      const y = wavePoint(layer, x / w, t, s.intensity) * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const stroke = hueColor(s.hue + layer * 16, 82, 64, 0.85 - layer * 0.12);
    ctx.lineTo(w + step, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = hueColor(s.hue + layer * 16, 70, 50, 0.08);
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x <= w + step; x += step) {
      const y = wavePoint(layer, x / w, t, s.intensity) * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = layer === 0 ? 2.2 : 1.4;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, w: number, h: number, s: MotionSettings, sim: Sim): void {
  for (const p of sim.particles) {
    const pulse = 1 + 0.35 * Math.sin(sim.t * 1.3 + p.phase);
    const r = p.r * pulse;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    ctx.fillStyle = hueColor(s.hue + (p.phase / (Math.PI * 2)) * 50, 85, 66, 0.35 + 0.45 * pulse * 0.5);
    ctx.fill();
  }
}

function drawOrbit(ctx: CanvasRenderingContext2D, w: number, h: number, s: MotionSettings, sim: Sim): void {
  const cx0 = w / 2;
  const cy0 = h / 2;
  const half = Math.min(w, h) / 2 - 6;
  // core
  const glow = 10 + (s.intensity / 100) * 12;
  const g = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, glow * 2.2);
  g.addColorStop(0, hueColor(s.hue, 90, 72, 0.9));
  g.addColorStop(1, hueColor(s.hue, 90, 60, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx0, cy0, glow * 2.2, 0, Math.PI * 2);
  ctx.fill();
  // rings then bodies
  sim.orbits.forEach((b, i) => {
    ctx.beginPath();
    ctx.ellipse(cx0, cy0, b.radius * half, b.radius * half * b.tilt, 0, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hueColor(s.hue + i * 9, 60, 60, 0.28);
    ctx.stroke();
  });
  sim.orbits.forEach((b, i) => {
    const p = orbitPosition(b, sim.t);
    const depth = (p.y / (b.radius * b.tilt) + 1) / 2; // 0 far, 1 near
    ctx.beginPath();
    ctx.arc(cx0 + p.x * half, cy0 + p.y * half, b.size * (0.7 + depth * 0.6), 0, Math.PI * 2);
    ctx.fillStyle = hueColor(s.hue + i * 9, 85, 70, 0.45 + depth * 0.5);
    ctx.fill();
  });
}

function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, s: MotionSettings, sim: Sim): void {
  ctx.clearRect(0, 0, w, h);
  ensureSim(sim, s);
  if (s.kind === 'wave') drawWave(ctx, w, h, s, sim.t);
  else if (s.kind === 'particles') drawParticles(ctx, w, h, s, sim);
  else drawOrbit(ctx, w, h, s, sim);
}

export function MotionStudio({ reducedMotion, className }: { reducedMotion: boolean; className?: string }) {
  const [settings, setSettingsState] = useState<MotionSettings>(DEFAULT_SETTINGS);
  const [playing, setPlaying] = useState<boolean>(!reducedMotion);
  const [frameCount, setFrameCount] = useState(0);
  const [rawSaved, setRawSaved] = usePref<unknown>(PRESET_PREF_KEY, []);
  const saved = useMemo(() => parseSavedPresets(rawSaved), [rawSaved]);
  const [draftName, setDraftName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  const simRef = useRef<Sim>({ t: 0, seed: 7, particles: [], orbits: [], built: null });
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const idSeq = useRef(0);
  const statusId = useId();

  const canRun = playing && !reducedMotion;

  const setSettings = useCallback((patch: Partial<MotionSettings>) => {
    setSettingsState((prev) => normalizeSettings({ ...prev, ...patch }, prev));
    setActiveId(null);
  }, []);
  settingsRef.current = settings;

  /** Paint one frame at the current sim time; cheap, used when paused or when a setting changes. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const { w, h } = sizeRef.current;
    if (!canvas || !ctx || w === 0 || h === 0) return;
    drawFrame(ctx, w, h, settingsRef.current, simRef.current);
  }, []);

  // Resize to the container, honouring device pixel ratio with an upper bound to keep fill cost low.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
      paint();
    };
    fit();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit);
      ro.observe(wrap);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [paint]);

  // Animation loop. Runs only while playing, motion is allowed and the document is visible.
  useEffect(() => {
    if (!canRun) {
      lastTsRef.current = null;
      paint();
      return undefined;
    }
    let active = true;
    const tick = (ts: number) => {
      if (!active) return;
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last !== null) {
        const s = settingsRef.current;
        const sim = simRef.current;
        const dt = Math.min(MAX_FRAME_S, (ts - last) / 1000) * timeScale(s.speed);
        sim.t += dt;
        ensureSim(sim, s);
        if (s.kind === 'particles') stepParticles(sim.particles, dt, s.intensity, sim.t);
        paint();
        setFrameCount((n) => (n + 1) % 1_000_000);
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    const start = () => {
      lastTsRef.current = null;
      rafRef.current = window.requestAnimationFrame(tick);
    };
    const stop = () => window.cancelAnimationFrame(rafRef.current);
    const onVisibility = () => {
      stop();
      if (document.visibilityState === 'visible') start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') start();
    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [canRun, paint]);

  // Repaint a still frame when settings change while paused.
  useEffect(() => {
    if (!canRun) paint();
  }, [settings, canRun, paint]);

  // Reduced motion coming on mid-session pauses playback; it is not resumed automatically.
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);

  const reset = useCallback(() => {
    const sim = simRef.current;
    sim.t = 0;
    sim.built = null;
    sim.seed = 7;
    lastTsRef.current = null;
    paint();
  }, [paint]);

  const applyPreset = (p: SavedPreset) => {
    setSettingsState(normalizeSettings(p));
    setActiveId(p.id);
    setSaveError(null);
  };

  const savePreset = () => {
    const name = normalizePresetName(draftName);
    if (!name) {
      setSaveError('Give the preset a name first.');
      return;
    }
    const existing = saved.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id ?? makePresetId(Date.now() * 100 + (idSeq.current++ % 100));
    const { list, ok } = upsertPreset(saved, { id, name, ...settings });
    if (!ok) {
      setSaveError(`You can keep up to ${MAX_SAVED_PRESETS} presets. Remove one to save another.`);
      return;
    }
    setRawSaved(list);
    setActiveId(id);
    setDraftName('');
    setSaveError(null);
  };

  const deletePreset = (id: string) => {
    setRawSaved(removePreset(saved, id));
    if (activeId === id) setActiveId(null);
  };

  const statusText = reducedMotion
    ? 'Motion is off because reduced motion is on. Showing a still frame.'
    : playing
      ? `Playing: ${describeSettings(settings)}.`
      : `Paused: ${describeSettings(settings)}.`;

  const sliders: { key: 'intensity' | 'speed' | 'hue'; label: string; hint: string; unit: string }[] = [
    { key: 'intensity', label: 'Intensity', hint: 'More layers, particles or orbits.', unit: '%' },
    { key: 'speed', label: 'Speed', hint: '0 freezes time; 50 is the natural rate.', unit: '%' },
    { key: 'hue', label: 'Colour', hint: 'Base hue of the palette.', unit: '°' },
  ];

  return (
    <div className={cx('motion-studio', className)}>
      {reducedMotion && (
        <Notice tone="info" title="Reduced motion is on">
          The canvas shows a single still frame and the Play control is disabled. Adjust the sliders to redraw it. Turn reduced motion off in Settings to animate.
        </Notice>
      )}

      <div className="motion-layout">
        <Panel className="motion-stage-panel" title="Stage" eyebrow="Canvas" actions={
          <>
            <Badge tone={reducedMotion ? 'muted' : playing ? 'ok' : 'warn'}>{reducedMotion ? 'Still' : playing ? 'Playing' : 'Paused'}</Badge>
            <Button size="sm" icon={playing ? Pause : Play} onClick={() => setPlaying((p) => !p)} disabled={reducedMotion} aria-pressed={playing} title={reducedMotion ? 'Disabled while reduced motion is on' : undefined}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button size="sm" icon={ArrowCounterClockwise} onClick={reset}>
              Reset
            </Button>
          </>
        }>
          <div ref={wrapRef} className={cx('motion-stage', `motion-${settings.kind}`)} style={{ ['--motion-hue' as string]: String(settings.hue) }}>
            <canvas ref={canvasRef} className="motion-canvas" role="img" aria-label={`Motion preview: ${describeSettings(settings)}`} aria-describedby={statusId} />
          </div>
          <p id={statusId} className="field-hint motion-status" role="status" aria-live="polite">
            {statusText}
            {canRun && <span className="sr-only"> Frames drawn: {frameCount}.</span>}
          </p>
        </Panel>

        <div className="stack motion-controls">
          <Panel title="Preset" eyebrow="Shape">
            <Segmented<MotionKind>
              label="Motion preset"
              value={settings.kind}
              onChange={(kind) => setSettings({ kind })}
              options={MOTION_KINDS.map((k) => ({ value: k.id, label: k.name, icon: KIND_ICON[k.id], hint: k.blurb }))}
            />
            <p className="field-hint">{MOTION_KINDS.find((k) => k.id === settings.kind)?.blurb}</p>
            {sliders.map((sl) => (
              <Field key={sl.key} label={sl.label} hint={sl.hint} className="motion-field">
                {(id, describedBy) => (
                  <div className="row motion-slider-row">
                    <input
                      id={id}
                      className="motion-slider"
                      type="range"
                      min={LIMITS[sl.key].min}
                      max={LIMITS[sl.key].max}
                      step={LIMITS[sl.key].step}
                      value={settings[sl.key]}
                      aria-describedby={describedBy}
                      aria-valuetext={`${settings[sl.key]}${sl.unit}`}
                      onChange={(e) => setSettings({ [sl.key]: Number(e.target.value) })}
                      style={sl.key === 'hue' ? { ['--motion-thumb' as string]: hueColor(settings.hue, 85, 62) } : undefined}
                    />
                    <output htmlFor={id} className="motion-value" aria-hidden>
                      {settings[sl.key]}
                      {sl.unit}
                    </output>
                  </div>
                )}
              </Field>
            ))}
            <div className="row wrap">
              <Button size="sm" onClick={() => { setSettingsState(DEFAULT_SETTINGS); setActiveId(null); }}>
                Defaults
              </Button>
            </div>
          </Panel>

          <Panel title="Library" eyebrow="Saved locally">
            <ul className="motion-presets" aria-label="Built-in presets">
              {BUILT_IN_PRESETS.map((p) => (
                <li key={p.id}>
                  <button type="button" className={cx('motion-preset', activeId === p.id && 'on')} aria-pressed={activeId === p.id} onClick={() => applyPreset(p)}>
                    <i className="motion-swatch" style={{ background: hueColor(p.hue, 85, 60) }} aria-hidden />
                    <span className="motion-preset-name">{p.name}</span>
                    <span className="motion-preset-meta">{MOTION_KINDS.find((k) => k.id === p.kind)?.name}</span>
                  </button>
                </li>
              ))}
            </ul>

            {saved.length > 0 ? (
              <ul className="motion-presets" aria-label="Your presets">
                {saved.map((p) => (
                  <li key={p.id}>
                    <button type="button" className={cx('motion-preset', activeId === p.id && 'on')} aria-pressed={activeId === p.id} onClick={() => applyPreset(p)}>
                      <i className="motion-swatch" style={{ background: hueColor(p.hue, 85, 60) }} aria-hidden />
                      <span className="motion-preset-name">{p.name}</span>
                      <span className="motion-preset-meta">{MOTION_KINDS.find((k) => k.id === p.kind)?.name} · {p.intensity}% · {p.speed}%</span>
                    </button>
                    <IconButton icon={Trash} label={`Delete preset ${p.name}`} size={14} onClick={() => deletePreset(p.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">No saved presets yet. Name the current look and save it; only the shape, three numbers and the name are stored on this device.</p>
            )}

            <Field label="Save current look as" error={saveError} hint={`${saved.length} of ${MAX_SAVED_PRESETS} slots used. Saving with an existing name replaces it.`}>
              {(id, describedBy) => (
                <div className="row">
                  <input
                    id={id}
                    className="input"
                    type="text"
                    maxLength={MAX_PRESET_NAME}
                    value={draftName}
                    placeholder="Preset name"
                    aria-describedby={describedBy}
                    onChange={(e) => { setDraftName(e.target.value); if (saveError) setSaveError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePreset(); } }}
                  />
                  <Button size="sm" variant="primary" icon={FloppyDisk} onClick={savePreset}>
                    Save
                  </Button>
                </div>
              )}
            </Field>
          </Panel>
        </div>
      </div>
    </div>
  );
}
