import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowCounterClockwise, Cube, DownloadSimple, GridFour, Pause, Play, Repeat, SkipBack, UploadSimple } from '@phosphor-icons/react';
import { Badge, Button, Field, Notice, Panel, Segmented, Switch } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { cx } from '../ui/util';
import {
  DEFAULT_SCENE,
  GL_LIMITS,
  LIMITS,
  LOOP_SECONDS,
  MAX_SCENE_BYTES,
  QUALITY_IDS,
  QUALITY_PROFILES,
  SCENE3D_PREF_KEY,
  SCENE_PRESETS,
  Scene3DError,
  contactSheetPlan,
  contextAttributes,
  createPlayhead,
  createSceneRenderer,
  effectiveCounts,
  effectiveFps,
  effectiveFrameMs,
  fallbackSvg,
  fitCanvas,
  normalizeScene,
  parseSceneJson,
  pickDpr,
  serializeScene,
  shouldPaint,
  type QualityId,
  type Range,
  type RenderResult,
  type SceneConfig,
  type SceneRenderer,
} from '../ui/scene3d';
import '../styles/scene3d.css';

/**
 * Scene 3D studio: a procedural WebGL2 scene (orbs, planes, particles) rendered by src/ui/scene3d.ts.
 *
 * Props
 * - reducedMotion: when true the studio never auto-plays. It shows a still frame that can still be scrubbed by hand
 *   and the Play control is disabled. Reduced motion coming on mid-session pauses playback.
 * - className: extra class for the root element.
 * - storageKey: preference key for the persisted scene (default SCENE3D_PREF_KEY). Only plain scene JSON is stored.
 * - initialScene: optional starting scene (any shape; normalized, invalid fields fall back to the stored or default scene).
 * - onStatus: notified when the rendering status changes: 'gpu' (WebGL2 drawing), 'fallback' (static SVG, no WebGL2),
 *   'lost' (context lost, waiting for restore), 'error' (shader or program failure, static SVG shown).
 *
 * Behaviour
 * - Everything on screen is renderAt(scene, time): the same scrub position always gives the same frame.
 * - Playback is bounded by the quality profile and the user fps / pixel-ratio limits; the loop pauses while the
 *   document is hidden and the GPU objects are released on unmount.
 * - PNG frame and PNG contact sheet exports read back the real drawing buffer; no video encoder is offered.
 */
export type Scene3DStatus = { kind: 'idle' | 'gpu' | 'fallback' | 'lost' | 'error'; detail: string };
export type Scene3DProps = { reducedMotion: boolean; className?: string; storageKey?: string; initialScene?: unknown; onStatus?: (status: Scene3DStatus) => void };

/** Preference key for the user's named scene presets (plain scene JSON only). */
export const USER_PRESETS_KEY = 'scene3d.userPresets';
export const MAX_USER_PRESETS = 8;
export const MAX_PRESET_NAME = 40;
/** One transport step: a thirtieth of a second, matching the frame cap's upper bound. */
export const STEP_SECONDS = 1 / 30;

export type UserPreset = { name: string; scene: SceneConfig };

/** Printable, trimmed, bounded name; empty when nothing usable is left. */
export function normalizePresetName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME).trim();
}

/** Reads stored presets defensively: wrong shapes are dropped, scenes are re-normalized, names de-duplicated, count bounded. */
export function parseUserPresets(raw: unknown): UserPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: UserPreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_USER_PRESETS) break;
    if (!item || typeof item !== 'object') continue;
    const name = normalizePresetName((item as { name?: unknown }).name);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, scene: normalizeScene((item as { scene?: unknown }).scene) });
  }
  return out;
}

/** Saves under a case-insensitive name, replacing an existing entry; refuses a new entry past the cap. */
export function upsertUserPreset(list: readonly UserPreset[], name: string, scene: SceneConfig): { list: UserPreset[]; ok: boolean; replaced: boolean } {
  const clean = normalizePresetName(name);
  if (!clean) return { list: [...list], ok: false, replaced: false };
  const index = list.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
  const entry: UserPreset = { name: clean, scene: normalizeScene(scene) };
  if (index >= 0) return { list: list.map((p, i) => (i === index ? entry : p)), ok: true, replaced: true };
  if (list.length >= MAX_USER_PRESETS) return { list: [...list], ok: false, replaced: false };
  return { list: [...list, entry], ok: true, replaced: false };
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fmt = (n: number, digits = 1) => (Number.isInteger(n) ? String(n) : n.toFixed(digits));

function Slider({ label, value, range, onChange, unit = '', hint }: { label: string; value: number; range: Range; onChange: (v: number) => void; unit?: string; hint?: string }) {
  return (
    <Field label={`${label} (${fmt(value)}${unit})`} hint={hint} className="scene3d-slider">
      {(id, describedBy) => (
        <input id={id} type="range" min={range.min} max={range.max} step={range.step ?? 1} value={value} aria-describedby={describedBy} aria-valuetext={`${fmt(value)}${unit}`} onChange={(e) => onChange(Number(e.target.value))} />
      )}
    </Field>
  );
}

export function Scene3D({ reducedMotion, className, storageKey = SCENE3D_PREF_KEY, initialScene, onStatus }: Scene3DProps) {
  const [storedScene, setStoredScene] = usePref<unknown>(storageKey, DEFAULT_SCENE);
  const [scene, setSceneState] = useState<SceneConfig>(() => normalizeScene(initialScene ?? storedScene, normalizeScene(storedScene)));
  const setScene = useCallback(
    (next: SceneConfig) => {
      const clean = normalizeScene(next);
      setSceneState(clean);
      setStoredScene(clean);
    },
    [setStoredScene],
  );
  const patch = useCallback(<K extends keyof SceneConfig>(group: K, value: Partial<SceneConfig[K]>) => setScene({ ...sceneRef.current, [group]: typeof sceneRef.current[group] === 'object' ? { ...(sceneRef.current[group] as object), ...(value as object) } : value } as SceneConfig), [setScene]);

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const cssSizeRef = useRef({ width: 640, height: 360 });
  const playheadRef = useRef(createPlayhead());
  const rafRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const lastPaintRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const importSeqRef = useRef(0);

  const [status, setStatusState] = useState<Scene3DStatus>({ kind: 'idle', detail: 'Starting renderer…' });
  const statusRef = useRef(status);
  const setStatus = useCallback(
    (next: Scene3DStatus) => {
      if (statusRef.current.kind === next.kind && statusRef.current.detail === next.detail) return;
      statusRef.current = next;
      setStatusState(next);
      onStatus?.(next);
    },
    [onStatus],
  );
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [stats, setStats] = useState<RenderResult | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0, dpr: 1 });
  const [jsonText, setJsonText] = useState(() => serializeScene(scene));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [fallbackFrame, setFallbackFrame] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [rawUserPresets, setRawUserPresets] = usePref<unknown>(USER_PRESETS_KEY, []);
  const userPresets = useMemo(() => parseUserPresets(rawUserPresets), [rawUserPresets]);
  const [presetName, setPresetName] = useState('');
  const [presetError, setPresetError] = useState<string | null>(null);

  const counts = useMemo(() => effectiveCounts(scene), [scene]);
  const canPlay = !reducedMotion && status.kind === 'gpu';

  /** Draws one frame at `t` with the GPU renderer, or refreshes the static SVG when there is no GPU path. */
  const paint = useCallback(
    (t: number) => {
      const current = sceneRef.current;
      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!renderer || !canvas) {
        if (statusRef.current.kind === 'fallback' || statusRef.current.kind === 'error') setFallbackFrame(fallbackSvg(current, t, 960, 540));
        return;
      }
      const dpr = pickDpr(window.devicePixelRatio, current);
      const size = fitCanvas(cssSizeRef.current.width, cssSizeRef.current.height, dpr);
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      let result: RenderResult;
      try { result = renderer.renderAt(current, t, size.width, size.height); }
      catch {
        renderer.dispose(); rendererRef.current = null;
        setStatus({ kind: 'error', detail: 'The GPU frame failed. Showing a static projection instead.' });
        setFallbackFrame(fallbackSvg(current, t, 960, 540));
        return;
      }
      setStats((prev) => (prev && prev.ok === result.ok && prev.drawCalls === result.drawCalls && prev.triangles === result.triangles && prev.particles === result.particles && prev.width === result.width && prev.height === result.height ? prev : result));
      setFrameSize((prev) => (prev.width === size.width && prev.height === size.height && prev.dpr === dpr ? prev : { width: size.width, height: size.height, dpr }));
      if (!result.ok && result.reason === 'context lost') setStatus({ kind: 'lost', detail: 'The GPU context was lost. Waiting for the browser to restore it.' });
    },
    [setStatus],
  );

  // Renderer lifecycle: create on mount, recreate on context restore, release on unmount.
  useEffect(() => {
    mountedRef.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const attach = () => {
      let gl: WebGL2RenderingContext | null;
      try { gl = glRef.current ?? (canvas.getContext('webgl2', contextAttributes(sceneRef.current)) as WebGL2RenderingContext | null); }
      catch { gl = null; }
      if (!gl) {
        glRef.current = null;
        setStatus({ kind: 'fallback', detail: 'WebGL2 is not available here. Showing a static projection instead of GPU rendering.' });
        setFallbackFrame(fallbackSvg(sceneRef.current, playheadRef.current.time, 960, 540));
        return;
      }
      glRef.current = gl;
      try {
        rendererRef.current?.dispose();
        rendererRef.current = createSceneRenderer(gl);
        setStatus({ kind: 'gpu', detail: 'WebGL2 rendering (GLSL ES 3.00, instanced orbs and planes, point particles).' });
        setFallbackFrame(null);
        paint(playheadRef.current.time);
      } catch (err) {
        rendererRef.current = null;
        const detail = err instanceof Scene3DError ? err.message : `Renderer failed: ${err instanceof Error ? err.message : String(err)}`;
        setStatus({ kind: 'error', detail });
        setFallbackFrame(fallbackSvg(sceneRef.current, playheadRef.current.time, 960, 540));
      }
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      setPlaying(false);
      window.cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setStatus({ kind: 'lost', detail: 'The GPU context was lost. Waiting for the browser to restore it.' });
    };
    const onRestored = () => attach();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width < 1 || box.height < 1) return;
      cssSizeRef.current = { width: box.width, height: box.height };
      paint(playheadRef.current.time);
    }) : null;
    if (stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) cssSizeRef.current = { width: rect.width, height: rect.height };
      ro?.observe(stageRef.current);
    }
    attach();
    return () => {
      mountedRef.current = false;
      importSeqRef.current++;
      window.cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      rendererRef.current?.dispose();
      rendererRef.current = null;
      glRef.current = null;
    };
  }, [paint, setStatus]);

  // Play loop: bounded by the effective frame cap, paused while hidden, stopped when the playhead ends without loop.
  useEffect(() => {
    const playhead = playheadRef.current;
    if (!playing || !canPlay) {
      playhead.pause();
      window.cancelAnimationFrame(rafRef.current);
      return;
    }
    playhead.play();
    let active = true;
    const tick = (ts: number) => {
      if (!active) return;
      const dt = lastTsRef.current === null ? 0 : ts - lastTsRef.current;
      lastTsRef.current = ts;
      const step = playhead.advance(dt);
      if (shouldPaint(lastPaintRef.current, ts, effectiveFrameMs(sceneRef.current))) {
        lastPaintRef.current = ts;
        paint(step.time);
        setTime(step.time);
      }
      if (step.stopped) {
        setPlaying(false);
        return;
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    const start = () => {
      lastTsRef.current = null;
      rafRef.current = window.requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(rafRef.current);
      if (document.visibilityState === 'visible') start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') start();
    return () => {
      active = false;
      window.cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [playing, canPlay, paint]);

  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  useEffect(() => {
    playheadRef.current.setLoop(loop);
  }, [loop]);
  // Scene edits repaint the current frame while paused.
  useEffect(() => {
    if (!playing) paint(playheadRef.current.time);
    setJsonText(serializeScene(scene));
    setJsonError(null);
  }, [scene, playing, paint]);

  const seek = (t: number) => {
    const clamped = playheadRef.current.seek(t);
    setTime(clamped);
    paint(clamped);
  };

  const step = (direction: 1 | -1) => {
    setPlaying(false);
    seek(playheadRef.current.time + direction * STEP_SECONDS);
  };
  const savePreset = () => {
    const result = upsertUserPreset(userPresets, presetName, sceneRef.current);
    if (!result.ok) {
      setPresetError(normalizePresetName(presetName) ? `You can keep up to ${MAX_USER_PRESETS} presets. Delete one to save another.` : 'Give the preset a name first.');
      return;
    }
    setRawUserPresets(result.list);
    setPresetError(null);
    setPresetName('');
    setImportNote(`${result.replaced ? 'Replaced' : 'Saved'} preset "${normalizePresetName(presetName)}" on this device.`);
  };
  const importJson = (text: string) => {
    const parsed = parseSceneJson(text);
    if (!parsed.ok) {
      setImportNote(null);
      setJsonError(parsed.error);
      return;
    }
    setJsonError(null);
    setScene(parsed.scene);
    setImportNote('Scene JSON applied. Out-of-range values were clamped and unknown fields dropped.');
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const sequence = ++importSeqRef.current;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_SCENE_BYTES) {
      setImportNote(null);
      setJsonError(`Scene file exceeds ${MAX_SCENE_BYTES / 1024} KB.`);
      return;
    }
    try { const text = await file.text(); if (mountedRef.current && sequence === importSeqRef.current) importJson(text); }
    catch { if (mountedRef.current && sequence === importSeqRef.current) setJsonError('The scene file could not be read.'); }
  };

  const exportFrame = () => {
    const canvas = canvasRef.current;
    const t = playheadRef.current.time;
    if (!rendererRef.current || !canvas) {
      if (fallbackFrame) {
        downloadBlob(`scene3d-static-${fmt(t, 2)}s.svg`, new Blob([fallbackFrame], { type: 'image/svg+xml' }));
        setExportNote('Static SVG export ready: choose where to save it. No GPU frame is available.');
      }
      return;
    }
    paint(t);
    canvas.toBlob((blob) => {
      if (!mountedRef.current) return;
      if (!blob) {
        setExportNote('PNG export failed: the canvas could not be encoded.');
        return;
      }
      downloadBlob(`scene3d-frame-${fmt(t, 2)}s.png`, blob);
      setExportNote(`PNG frame export ready at ${fmt(t, 2)} s: choose where to save it.`);
    }, 'image/png');
  };

  const exportContactSheet = () => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) {
      setExportNote('Contact sheets need the GPU renderer.');
      return;
    }
    const plan = contactSheetPlan({ tiles: 12, tileWidth: 320 });
    const sheet = document.createElement('canvas');
    sheet.width = plan.width;
    sheet.height = plan.height;
    const ctx = sheet.getContext('2d');
    if (!ctx) {
      setExportNote('Contact sheet failed: no 2D context for the sheet canvas.');
      return;
    }
    const previous = { width: canvas.width, height: canvas.height };
    canvas.width = plan.tileWidth;
    canvas.height = plan.tileHeight;
    let drawn = 0;
    try { plan.times.forEach((t, i) => {
      const result = renderer.renderAt(sceneRef.current, t, plan.tileWidth, plan.tileHeight);
      if (!result.ok) return;
      const x = (i % plan.columns) * plan.tileWidth;
      const y = Math.floor(i / plan.columns) * plan.tileHeight;
      ctx.drawImage(canvas, 0, 0, plan.tileWidth, plan.tileHeight, x, y, plan.tileWidth, plan.tileHeight);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y + plan.tileHeight - 18, 72, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`t=${fmt(t, 2)}s`, x + 6, y + plan.tileHeight - 5);
      drawn++;
    }); } catch {
      setExportNote('Contact sheet failed while rendering. The stage has been restored.');
      return;
    } finally {
      canvas.width = previous.width;
      canvas.height = previous.height;
      paint(playheadRef.current.time);
    }
    if (drawn === 0) {
      setExportNote('Contact sheet failed: no tile could be rendered.');
      return;
    }
    sheet.toBlob((blob) => {
      if (!mountedRef.current) return;
      if (!blob) {
        setExportNote('Contact sheet export failed: the sheet could not be encoded.');
        return;
      }
      downloadBlob('scene3d-contact-sheet.png', blob);
      setExportNote(`${plan.width}×${plan.height} contact sheet ready (${drawn} frames): choose where to save it.`);
    }, 'image/png');
  };

  const presetId = SCENE_PRESETS.find((p) => serializeScene(p.scene) === serializeScene(scene))?.id ?? '';
  const tone = status.kind === 'gpu' ? 'ok' : status.kind === 'fallback' ? 'warn' : status.kind === 'idle' ? 'muted' : 'danger';

  return (
    <div className={cx('scene3d', className)} data-status={status.kind}>
      {reducedMotion && (
        <Notice tone="info" title="Reduced motion">
          Playback is off. The frame can still be scrubbed by hand and exported.
        </Notice>
      )}
      <div className="scene3d-layout">
        <Panel
          title="Stage"
          eyebrow="Procedural 3D"
          className="scene3d-stage-panel"
          actions={
            <Badge tone={tone} title={status.detail}>
              {status.kind === 'gpu' ? 'WebGL2' : status.kind === 'fallback' ? 'Static fallback' : status.kind === 'lost' ? 'Context lost' : status.kind === 'error' ? 'Renderer error' : 'Starting'}
            </Badge>
          }
        >
          <div ref={stageRef} className="scene3d-stage" data-testid="scene3d-stage">
            <canvas ref={canvasRef} className={cx('scene3d-canvas', fallbackFrame && 'is-hidden')} aria-label="Procedural 3D scene" role="img" />
            {fallbackFrame && <img className="scene3d-fallback" alt="Static scene preview without GPU rendering" src={`data:image/svg+xml;utf8,${encodeURIComponent(fallbackFrame)}`} />}
          </div>
          <p className="scene3d-status muted">{status.detail}</p>
          <div className="scene3d-transport" role="group" aria-label="Playback">
            <Button size="sm" icon={SkipBack} onClick={() => seek(0)} aria-label="Go to loop start">Start</Button>
            <Button size="sm" onClick={() => step(-1)} aria-label="Step back one frame (1/30 second)">Step back</Button>
            <Button size="sm" onClick={() => step(1)} aria-label="Step forward one frame (1/30 second)">Step forward</Button>
            <Button size="sm" variant="primary" icon={playing ? Pause : Play} disabled={!canPlay} onClick={() => setPlaying((p) => !p)} aria-pressed={playing} title={reducedMotion ? 'Playback is off while reduced motion is on' : undefined}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button size="sm" icon={Repeat} onClick={() => setLoop((l) => !l)} aria-pressed={loop}>
              {loop ? 'Loop on' : 'Loop off'}
            </Button>
            <label className="scene3d-scrub">
              <span className="muted">Time {fmt(time, 2)} / {LOOP_SECONDS} s</span>
              <input type="range" min={0} max={LOOP_SECONDS} step={0.01} value={time} aria-label="Loop time" aria-valuetext={`${fmt(time, 2)} seconds`} onChange={(e) => seek(Number(e.target.value))} />
            </label>
          </div>
          <div className="scene3d-exports">
            <Button size="sm" icon={DownloadSimple} onClick={exportFrame} disabled={status.kind === 'idle' || status.kind === 'lost'}>{rendererRef.current ? 'Export PNG frame' : 'Export static SVG'}</Button>
            <Button size="sm" icon={GridFour} onClick={exportContactSheet} disabled={status.kind !== 'gpu'}>Export contact sheet (PNG)</Button>
            <Button size="sm" icon={DownloadSimple} onClick={() => { downloadBlob('scene3d-scene.json', new Blob([serializeScene(scene)], { type: 'application/json' })); setExportNote('Scene JSON export ready: choose where to save it.'); }}>Export scene JSON</Button>
          </div>
          {exportNote && <p className="scene3d-note muted" role="status">{exportNote}</p>}
          <dl className="scene3d-stats" aria-label="Resource use">
            <div><dt>Orbs</dt><dd>{counts.orbs} / {QUALITY_PROFILES[scene.quality].maxOrbs}</dd></div>
            <div><dt>Planes</dt><dd>{counts.planes} / {GL_LIMITS.maxPlanes}</dd></div>
            <div><dt>Particles</dt><dd>{counts.particles} / {QUALITY_PROFILES[scene.quality].maxParticles}</dd></div>
            <div><dt>Triangles</dt><dd>{stats?.ok ? stats.triangles : counts.triangles}</dd></div>
            <div><dt>Draw calls</dt><dd>{stats?.ok ? stats.drawCalls : 0}</dd></div>
            <div><dt>Pixels</dt><dd>{frameSize.width}×{frameSize.height} @ {fmt(frameSize.dpr, 2)}x</dd></div>
            <div><dt>Frame cap</dt><dd>{effectiveFps(scene)} fps</dd></div>
          </dl>
        </Panel>

        <div className="scene3d-controls">
          <Panel title="Scene" eyebrow="Presets and quality">
            <Field label="Preset" hint="Presets are plain scene JSON; applying one replaces the current scene.">
              {(id, describedBy) => (
                <select id={id} aria-describedby={describedBy} value={presetId} onChange={(e) => { const p = SCENE_PRESETS.find((x) => x.id === e.target.value); if (p) setScene(p.scene); }}>
                  <option value="">Custom</option>
                  {SCENE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name} :  {p.hint}</option>)}
                </select>
              )}
            </Field>
            <Segmented<QualityId> label="Quality" value={scene.quality} onChange={(q) => patch('quality', q as never)} options={QUALITY_IDS.map((q) => ({ value: q, label: QUALITY_PROFILES[q].name, hint: QUALITY_PROFILES[q].hint }))} />
            <Slider label="Frame cap" unit=" fps" value={scene.limits.fps} range={LIMITS.limits.fps} onChange={(fps) => patch('limits', { fps })} />
            <Slider label="Pixel ratio cap" unit="x" value={scene.limits.dpr} range={LIMITS.limits.dpr} onChange={(dpr) => patch('limits', { dpr })} hint={`Canvas edges never exceed ${GL_LIMITS.maxEdge} device pixels.`} />
            <Button size="sm" icon={ArrowCounterClockwise} onClick={() => setScene(DEFAULT_SCENE)}>Reset to default</Button>
          </Panel>

          <Panel title="Your presets" eyebrow="Saved on this device">
            {userPresets.length > 0 ? (
              <ul className="scene3d-user-presets" aria-label="Your scene presets">
                {userPresets.map((p) => (
                  <li key={p.name} className="row">
                    <Button size="sm" aria-pressed={serializeScene(p.scene) === serializeScene(scene)} onClick={() => { setScene(p.scene); setPresetError(null); setImportNote(`Applied preset "${p.name}".`); }}>{p.name}</Button>
                    <Button size="sm" aria-label={`Delete preset ${p.name}`} onClick={() => setRawUserPresets(userPresets.filter((q) => q.name !== p.name))}>Delete</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">No saved presets yet. Only the validated scene numbers and the name are stored here; nothing is uploaded.</p>
            )}
            <Field label="Save current scene as" error={presetError} hint={`${userPresets.length} of ${MAX_USER_PRESETS} slots used. Saving with an existing name replaces it.`}>
              {(id, describedBy) => (
                <div className="row">
                  <input id={id} className="input" type="text" maxLength={MAX_PRESET_NAME} value={presetName} placeholder="Preset name" aria-describedby={describedBy} onChange={(e) => { setPresetName(e.target.value); if (presetError) setPresetError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePreset(); } }} />
                  <Button size="sm" variant="primary" onClick={savePreset}>Save</Button>
                </div>
              )}
            </Field>
          </Panel>

          <Panel title="Camera" eyebrow="Orbit and lens">
            <Slider label="Yaw" unit="°" value={scene.camera.yaw} range={LIMITS.camera.yaw} onChange={(yaw) => patch('camera', { yaw })} />
            <Slider label="Pitch" unit="°" value={scene.camera.pitch} range={LIMITS.camera.pitch} onChange={(pitch) => patch('camera', { pitch })} />
            <Slider label="Distance" value={scene.camera.distance} range={LIMITS.camera.distance} onChange={(distance) => patch('camera', { distance })} />
            <Slider label="Field of view" unit="°" value={scene.camera.fov} range={LIMITS.camera.fov} onChange={(fov) => patch('camera', { fov })} />
            <Switch label="Auto orbit" description="One full revolution per loop so the seam stays clean." checked={scene.camera.autoOrbit} onChange={(autoOrbit) => patch('camera', { autoOrbit })} />
          </Panel>

          <Panel title="Material" eyebrow="Orb surface">
            <Slider label="Hue" unit="°" value={scene.material.hue} range={LIMITS.material.hue} onChange={(hue) => patch('material', { hue })} />
            <Slider label="Saturation" unit="%" value={scene.material.saturation} range={LIMITS.material.saturation} onChange={(saturation) => patch('material', { saturation })} />
            <Slider label="Roughness" unit="%" value={scene.material.roughness} range={LIMITS.material.roughness} onChange={(roughness) => patch('material', { roughness })} />
            <Slider label="Metal" unit="%" value={scene.material.metal} range={LIMITS.material.metal} onChange={(metal) => patch('material', { metal })} />
          </Panel>

          <Panel title="Lighting" eyebrow="Key, fill and fog">
            <Slider label="Key" unit="%" value={scene.lighting.key} range={LIMITS.lighting.key} onChange={(key) => patch('lighting', { key })} />
            <Slider label="Fill" unit="%" value={scene.lighting.fill} range={LIMITS.lighting.fill} onChange={(fill) => patch('lighting', { fill })} />
            <Slider label="Ambient" unit="%" value={scene.lighting.ambient} range={LIMITS.lighting.ambient} onChange={(ambient) => patch('lighting', { ambient })} />
            <Slider label="Light azimuth" unit="°" value={scene.lighting.azimuth} range={LIMITS.lighting.azimuth} onChange={(azimuth) => patch('lighting', { azimuth })} />
            <Slider label="Light elevation" unit="°" value={scene.lighting.elevation} range={LIMITS.lighting.elevation} onChange={(elevation) => patch('lighting', { elevation })} />
            <Slider label="Fog" unit="%" value={scene.lighting.fog} range={LIMITS.lighting.fog} onChange={(fog) => patch('lighting', { fog })} />
          </Panel>

          <Panel title="Objects and motion" eyebrow="Bounded geometry">
            <Slider label="Orbs" value={scene.objects.orbs} range={LIMITS.objects.orbs} onChange={(orbs) => patch('objects', { orbs })} hint={`Quality "${QUALITY_PROFILES[scene.quality].name}" renders at most ${QUALITY_PROFILES[scene.quality].maxOrbs}.`} />
            <Slider label="Planes" value={scene.objects.planes} range={LIMITS.objects.planes} onChange={(planes) => patch('objects', { planes })} />
            <Slider label="Particles" value={scene.objects.particles} range={LIMITS.objects.particles} onChange={(particles) => patch('objects', { particles })} hint={`Quality "${QUALITY_PROFILES[scene.quality].name}" renders at most ${QUALITY_PROFILES[scene.quality].maxParticles}.`} />
            <Slider label="Speed" unit="%" value={scene.motion.speed} range={LIMITS.motion.speed} onChange={(speed) => patch('motion', { speed })} hint="Rounded to whole cycles per loop so t = 0 and t = 12 s match." />
            <Slider label="Seed" value={scene.motion.seed} range={LIMITS.motion.seed} onChange={(seed) => patch('motion', { seed })} />
          </Panel>

          <Panel title="Scene JSON" eyebrow="Import and export">
            <Field label="Scene JSON" hint={`Plain data only, at most ${MAX_SCENE_BYTES / 1024} KB. Out-of-range values are clamped; unknown fields are dropped.`} error={jsonError}>
              {(id, describedBy) => <textarea id={id} aria-describedby={describedBy} className="scene3d-json" rows={8} maxLength={MAX_SCENE_BYTES} spellCheck={false} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />}
            </Field>
            <div className="scene3d-exports">
              <Button size="sm" icon={UploadSimple} onClick={() => importJson(jsonText)}>Apply JSON</Button>
              <label className="btn btn-ghost btn-sm scene3d-file">
                <Cube size={14} aria-hidden />
                <span>Import file…</span>
                <input type="file" accept="application/json,.json" onChange={onFile} />
              </label>
            </div>
            {importNote && !jsonError && <p className="scene3d-note muted" role="status" aria-live="polite">{importNote}</p>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default Scene3D;
