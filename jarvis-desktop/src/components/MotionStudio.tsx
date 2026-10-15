import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowCounterClockwise, Copy, DownloadSimple, FloppyDisk, Pause, Planet, Play, Plus, Record, Sparkle, Stop, Trash, UploadSimple, Waves } from '@phosphor-icons/react';
import { Badge, Button, Field, IconButton, Notice, Panel, Segmented } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { cx } from '../ui/util';
import {
  BUILT_IN_PRESETS,
  ALL_MOTION_KINDS, LAB_PRESETS, LAB_GATES, MAX_LAB_BYTES, labFromScene, renderFrame, frameToSvg, contactSheetSvg, tracksToCss, parseLab, serializeLab, TRACK_PARAMS, trackParam, type Track, type TrackParam, type Paint,
  CLIP_FPS,
  CLIP_LIMITS,
  DEFAULT_SETTINGS,
  LIMITS,
  MAX_LAYERS,
  MAX_PRESET_NAME,
  MAX_SAVED_PRESETS,
  MAX_SAVED_SCENES,
  MAX_SCENE_BYTES,
  PRESET_PREF_KEY,
  SCENE_PREF_KEY,
  SCENE_SCHEMA_HINT,
  SCENE_TEMPLATES,
  clipFrameCount,
  describeScene,
  describeSettings,
  hueColor,
  makeLayerId,
  makePresetId,
  normalizeClipPlan,
  normalizeLayer,
  normalizePresetName,
  normalizeSettings,
  parseSavedPresets,
  parseSavedScenes,
  parseScene,
  removePreset,
  sceneFromSettings,
  sceneFromText,
  serializeScene,
  upsertPreset,
  upsertScene,
  type ClipFps,
  type ClipPlan,
  type MotionKind,
  type MotionLayer,
  type MotionScene,
  type MotionSettings,
  type SavedPreset,
  type SavedScene,
  type SceneParse,
} from '../ui/motion-presets';
import '../styles/motion-studio.css';
import { MAX_SCENE_SPEC_CHARS, composeSceneFromText, sceneSpecToSettings, serializeSceneSpec, validateSceneSpec, type SceneSpec, type SceneSpecResult } from '../ui/scene-spec';
import { CLIP_EXPORT_FPS, CLIP_EXPORT_LIMITS, clipByteSize, clipExportFrameCount, clipToBlobParts, formatBytes, sampleClip, type Clip } from '../ui/clip-export';
import { MOTION_AI_LIMITS, buildMotionRequest, describeDestination, runMotionGeneration, validateGeneratedScene, type GeneratedSceneResult } from '../ui/motion-ai';
import { useOptionalStore } from '../ui/store';
import { DEFAULT_TIMELINE, TIMELINE_LIMITS, MAX_KEYS, formatTimecode, normalizeTimeline, playbackFrame, stepFrame, EASING_LIST, upsertKey, QUALITY_IDS, QUALITY_PROFILES, previewIntervalMs, TIMELINE_FPS, type TimelineFps, type Timeline, type EasingName, type QualityId } from '../ui/motion-timing';

/**
 * Motion Studio: a self-contained, offline canvas playground. A scene stacks up to MAX_LAYERS
 * six original procedural kinds over a background hue. It calls the backend only for the optional
 * "Generate with AI" group, and only after an explicit click (see src/ui/motion-ai.ts).
 * The only things it stores are the user's preset and scene lists (kinds, small numbers, short
 * names) under the non-sensitive UI preference prefix. Scene JSON from anywhere (a file, a paste,
 * a model reply) is validated by parseScene before it is drawn.
 */

const KIND_ICON: Record<MotionKind, typeof Waves> = { wave: Waves, particles: Sparkle, orbit: Planet, aurora: Waves, bloom: Sparkle, lattice: Planet };
/** Largest step we will simulate for one frame, so a background tab does not "catch up" with a jump. */
const MAX_FRAME_S = 0.05;

function downloadBlob(name: string, blob: Blob): void {
  if (typeof URL === 'undefined' || typeof document === 'undefined') return;
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

const safeFileName = (name: string): string => name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scene';

const MAX_TRACKS = 12;

/** Sorted, de-duplicated keyframe frames, optionally limited to one layer. Pure so it can be tested without a DOM. */
export function keyframeFrames(tracks: readonly Track[], layerId?: string): number[] {
  const frames = new Set<number>();
  for (const track of tracks) if (layerId === undefined || track.layer === layerId) for (const key of track.keys) frames.add(key.frame);
  return [...frames].sort((a, b) => a - b);
}

/** Nearest keyframe strictly before (-1) or after (+1) the current frame, or null when there is none. */
export function adjacentKeyFrame(frames: readonly number[], current: number, direction: 1 | -1): number | null {
  if (direction > 0) return frames.find((frame) => frame > current) ?? null;
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i] < current) return frames[i];
  return null;
}

/** Pressing Play on a finished non-looping timeline starts again from frame 0 instead of stopping immediately. */
export const restartFrame = (frame: number, timeline: Timeline): number => (!timeline.loop && frame >= timeline.frames - 1 ? 0 : frame);

/** A recording follows playback: once the preview stops there is nothing left to capture but a still. */
export const shouldStopRecording = (recording: boolean, canRun: boolean): boolean => recording && !canRun;

type RecorderSupport = { ok: true; mime: string } | { ok: false; reason: string };

/** Canvas and exported SVG share the same deterministic frame geometry. */
function paintLab(ctx: CanvasRenderingContext2D, lab: ReturnType<typeof labFromScene>, frame: number, w: number, h: number) {
  const result = renderFrame(lab, frame, w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = result.background.base;
  ctx.fillRect(0, 0, w, h);
  const backdrop = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, Math.max(w, h) * 0.9);
  backdrop.addColorStop(0, result.background.tint); backdrop.addColorStop(1, 'transparent');
  ctx.fillStyle = backdrop; ctx.fillRect(0, 0, w, h);
  const fill = (value: Paint) => {
    if (typeof value === 'string') return value;
    const gradient = ctx.createLinearGradient(0, value.y0, 0, value.y1);
    gradient.addColorStop(0, value.from); gradient.addColorStop(1, value.to);
    return gradient;
  };
  for (const layer of result.layers) {
    ctx.save(); ctx.globalAlpha = layer.alpha;
    ctx.translate(w / 2 + layer.dx, h / 2 + layer.dy); ctx.scale(layer.scale, layer.scale); ctx.translate(-w / 2, -h / 2);
    for (const p of layer.prims) {
      ctx.beginPath();
      if (p.p === 'poly') {
        p.pts.forEach((_, i) => { if (i % 2 === 0) { if (i === 0) ctx.moveTo(p.pts[i], p.pts[i + 1]); else ctx.lineTo(p.pts[i], p.pts[i + 1]); } });
        if (p.closed) ctx.closePath();
        if (p.fill) { ctx.fillStyle = fill(p.fill); ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = p.width ?? 1; ctx.stroke(); }
      } else if (p.p === 'circle') { ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = p.fill; ctx.fill(); }
      else if (p.p === 'ellipse') { ctx.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, Math.PI * 2); ctx.strokeStyle = p.stroke; ctx.lineWidth = p.width; ctx.stroke(); }
      else if (p.p === 'line') { ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.strokeStyle = p.stroke; ctx.lineWidth = p.width; ctx.stroke(); }
      else { const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r); gradient.addColorStop(0, p.inner); gradient.addColorStop(1, p.outer); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = gradient; ctx.fill(); }
    }
    ctx.restore();
  }
}

/** Local clip recording needs canvas.captureStream and a WebM-capable MediaRecorder in this runtime. */
function recorderSupport(canvas: HTMLCanvasElement | null): RecorderSupport {
  if (!canvas) return { ok: false, reason: 'The stage is not mounted.' };
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'This runtime has no MediaRecorder, so clips cannot be encoded locally.' };
  if (typeof (canvas as HTMLCanvasElement & { captureStream?: unknown }).captureStream !== 'function') return { ok: false, reason: 'This runtime cannot capture a stream from the canvas.' };
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return { ok: false, reason: 'No WebM encoder is available in this runtime.' };
  return { ok: true, mime };
}

export function MotionStudio({ reducedMotion, className }: { reducedMotion: boolean; className?: string }) {
  const [scene, setSceneState] = useState<MotionScene>(() => sceneFromSettings(DEFAULT_SETTINGS));
  const [activeLayer, setActiveLayer] = useState(0);
  const [playing, setPlaying] = useState<boolean>(!reducedMotion);
  const [frameCount, setFrameCount] = useState(0);
  const [timeline, setTimeline] = useState<Timeline>(DEFAULT_TIMELINE);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [quality, setQuality] = useState<QualityId>('balanced');
  const [trackKind, setTrackKind] = useState<TrackParam>('opacity');
  const [keyValue, setKeyValue] = useState(100);
  const [easing, setEasing] = useState<EasingName>('in-out-sine');
  const [labText, setLabText] = useState('');
  const [labMessage, setLabMessage] = useState('');
  const frameRef = useRef(0);
  const fractionalFrameRef = useRef(0);
  const lab = useMemo(() => ({ ...labFromScene(scene, timeline), tracks: tracks.filter((t) => scene.layers.some((l) => l.id === t.layer)), quality }), [scene, timeline, tracks, quality]);
  const labRef = useRef(lab);
  labRef.current = lab;

  const [rawSaved, setRawSaved] = usePref<unknown>(PRESET_PREF_KEY, []);
  const saved = useMemo(() => parseSavedPresets(rawSaved), [rawSaved]);
  const [draftName, setDraftName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [rawScenes, setRawScenes] = usePref<unknown>(SCENE_PREF_KEY, []);
  const savedScenes = useMemo(() => parseSavedScenes(rawScenes), [rawScenes]);
  const [sceneName, setSceneName] = useState('');
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<{ source: string; result: SceneParse } | null>(null);

  const [describeText, setDescribeText] = useState('');
  const [specDraft, setSpecDraft] = useState<{ spec: SceneSpec; rationale: string[] } | { error: string } | null>(null);
  const [specJson, setSpecJson] = useState('');
  const [specResult, setSpecResult] = useState<SceneSpecResult | null>(null);
  const [specMessage, setSpecMessage] = useState('');

  /* Generate with AI (goals 80/139): the guarded chat service from the store; nothing is sent until an explicit click. */
  const store = useOptionalStore();
  const aiApi = store?.api ?? null;
  const aiMode = store?.settings?.mode ?? null;
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLive, setAiLive] = useState('');
  const [aiResult, setAiResult] = useState<GeneratedSceneResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState('');
  const [aiKeyMissing, setAiKeyMissing] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);

  const [clipPlan, setClipPlan] = useState<ClipPlan>(() => normalizeClipPlan({}));
  const [recording, setRecording] = useState(false);
  const [clipMsg, setClipMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [jsonClipFps, setJsonClipFps] = useState<number>(24);
  const [jsonClipMs, setJsonClipMs] = useState<number>(3000);
  const [jsonClip, setJsonClip] = useState<{ clip: Clip; bytes: number; key: unknown[] } | null>(null);
  const [jsonClipError, setJsonClipError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef(scene);

  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const idSeq = useRef(0);
  const recorderRef = useRef<{ rec: MediaRecorder; timer: number; stream: MediaStream } | null>(null);
  const mountedRef = useRef(false);
  const labImportSeq = useRef(0);
  const statusId = useId();

  const canRun = playing && !reducedMotion;
  const layer = scene.layers[Math.min(activeLayer, scene.layers.length - 1)] ?? scene.layers[0];
  const settings: MotionSettings = { kind: layer.kind, intensity: layer.intensity, speed: layer.speed, hue: layer.hue };
  sceneRef.current = scene;

  const nextId = (prefix: 'l' | 'p' | 's') => {
    const seed = Date.now() * 100 + (idSeq.current++ % 100);
    return prefix === 'l' ? makeLayerId(seed) : prefix === 'p' ? makePresetId(seed) : `s-${Math.abs(Math.trunc(seed)).toString(36)}`;
  };

  const setScene = useCallback((next: MotionScene) => {
    setSceneState(next);
    setActiveSceneId(null);
  }, []);

  const patchLayer = useCallback(
    (index: number, patch: Partial<MotionLayer>) => {
      setSceneState((prev) => {
        const layers = prev.layers.map((l, i) => (i === index ? normalizeLayer({ ...l, ...patch }, l.id) : l));
        return { ...prev, layers };
      });
      setActiveSceneId(null);
    },
    [],
  );

  const setSettings = useCallback(
    (patch: Partial<MotionSettings>) => {
      patchLayer(activeLayer, patch);
      setActiveId(null);
    },
    [activeLayer, patchLayer],
  );

  /** Paint one frame at the current sim time; cheap, used when paused or when a setting changes. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const { w, h } = sizeRef.current;
    if (!canvas || !ctx || w === 0 || h === 0) return;
    paintLab(ctx, labRef.current, frameRef.current, w, h);
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
      const dpr = Math.min(QUALITY_PROFILES[quality].maxDpr, window.devicePixelRatio || 1);
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
  }, [paint, quality]);

  // Animation loop. Runs only while playing, motion is allowed and the document is visible.
  useEffect(() => {
    if (!canRun) {
      lastTsRef.current = null;
      paint();
      return undefined;
    }
    let active = true;
    let lastPaint = 0;
    const tick = (ts: number) => {
      if (!active) return;
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last !== null) {
        fractionalFrameRef.current += Math.min(MAX_FRAME_S, (ts - last) / 1000) * labRef.current.timeline.fps;
        const delta = Math.floor(fractionalFrameRef.current);
        fractionalFrameRef.current -= delta;
        const result = playbackFrame(frameRef.current, delta / labRef.current.timeline.fps, labRef.current.timeline);
        frameRef.current = result.frame;
        if (result.ended) setPlaying(false);
        const interval = previewIntervalMs(labRef.current.timeline, QUALITY_PROFILES[labRef.current.quality]);
        if (delta > 0 && ts - lastPaint >= interval - 1) {
          paint();
          setFrameCount(frameRef.current);
          lastPaint = ts;
        }
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

  // Repaint a still frame when the scene changes while paused.
  useEffect(() => {
    if (!canRun) paint();
  }, [lab, canRun, paint]);

  // Reduced motion coming on mid-session pauses playback; it is not resumed automatically.
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);

  useEffect(() => {
    setTracks((previous) => previous.filter((track) => scene.layers.some((layer) => layer.id === track.layer)));
  }, [scene.layers]);

  // Stop and release a recording on unmount without opening a late Save dialog.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const r = recorderRef.current;
      recorderRef.current = null;
      if (r) {
        window.clearTimeout(r.timer);
        r.rec.onstop = null;
        r.rec.ondataavailable = null;
        r.rec.onerror = null;
        try { if (r.rec.state !== 'inactive') r.rec.stop(); }
        finally { r.stream.getTracks().forEach((track) => track.stop()); }
      }
    };
  }, []);

  const reset = useCallback(() => {

    lastTsRef.current = null;
    frameRef.current = 0;
    fractionalFrameRef.current = 0;
    setFrameCount(0);
    paint();
  }, [paint]);

  /* ---------- presets (single layer) ---------- */
  const applyPreset = (p: SavedPreset) => {
    patchLayer(activeLayer, normalizeSettings(p));
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
    const id = existing?.id ?? nextId('p');
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

  /* ---------- layers ---------- */
  const addLayer = () => {
    if (scene.layers.length >= MAX_LAYERS) return;
    const l = normalizeLayer({ ...settings, opacity: 60, seed: (layer.seed * 7 + 3) % 1_000_000 || 1 }, nextId('l'));
    setScene({ ...scene, layers: [...scene.layers, l] });
    setActiveLayer(scene.layers.length);
    setActiveId(null);
  };
  const removeLayer = (index: number) => {
    if (scene.layers.length <= 1) return;
    setScene({ ...scene, layers: scene.layers.filter((_, i) => i !== index) });
    setActiveLayer((a) => Math.max(0, Math.min(a > index ? a - 1 : a, scene.layers.length - 2)));
  };

  /* ---------- scenes ---------- */
  const loadScene = (s: SavedScene) => {
    setSceneState({ version: s.version, name: s.name, background: s.background, layers: s.layers.map((l) => ({ ...l })) });
    setActiveSceneId(s.id);
    setActiveLayer(0);
    setActiveId(null);
    setSceneError(null);
    setSceneName(s.id.startsWith('builtin:') ? '' : s.name);

  };
  const saveScene = () => {
    const name = normalizePresetName(sceneName);
    if (!name) {
      setSceneError('Give the scene a name first.');
      return;
    }
    const existing = savedScenes.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id ?? nextId('s');
    const { list, ok } = upsertScene(savedScenes, { id, ...scene, name });
    if (!ok) {
      setSceneError(`You can keep up to ${MAX_SAVED_SCENES} scenes. Remove one to save another.`);
      return;
    }
    setRawScenes(list);
    setSceneState({ ...scene, name });
    setActiveSceneId(id);
    setSceneError(null);
  };
  const deleteScene = (id: string) => {
    setRawScenes(savedScenes.filter((s) => s.id !== id));
    if (activeSceneId === id) setActiveSceneId(null);
  };

  const applyParsed = (source: string, result: SceneParse) => {
    setImportResult({ source, result });
    if (result.ok) {
      setScene(result.scene);
      setActiveLayer(0);
      setSceneName(result.scene.name);

    }
  };
  const importJson = () => applyParsed('pasted JSON', parseScene(importText));
  const importFromText = () => applyParsed('text', sceneFromText(importText));
  const exportScene = () => {
    downloadBlob(`${safeFileName(scene.name)}.scene.json`, new Blob([serializeScene(scene)], { type: 'application/json' }));
    setLabMessage('Scene JSON export ready: choose where to save it.');
  };
  const exportLab = (name: string, blob: Blob) => {
    downloadBlob(name, blob);
    setLabMessage('Export ready: choose where to save it.');
  };
  const copyScene = () => {
    const text = serializeScene(scene);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => setImportText(text));
    else setImportText(text);
  };

  /* ---------- describe a scene (feature 139): offline draft or pasted JSON, validated before applying ---------- */
  const draftFromText = () => {
    try {
      setSpecDraft(composeSceneFromText(describeText));
    } catch (err) {
      setSpecDraft({ error: err instanceof Error ? err.message : 'Could not draft a scene.' });
    }
  };
  const copyDraftToJson = () => {
    if (!specDraft || 'error' in specDraft) return;
    setSpecJson(serializeSceneSpec(specDraft.spec));
    setSpecResult(null);
    setSpecMessage('');
  };
  const validateSpec = () => {
    setSpecResult(validateSceneSpec(specJson));
    setSpecMessage('');
  };
  const applySpec = () => {
    if (!specResult?.ok) return;
    setSettings(sceneSpecToSettings(specResult.spec));
    setSpecMessage(`Applied "${specResult.spec.name}" to layer ${activeLayer + 1}.`);
  };

  /* ---------- generate with AI: preview the exact text, send on an explicit click, validate with the scene-spec parser ---------- */
  const aiRequest = useMemo(() => {
    if (!aiText.trim()) return null;
    try {
      return buildMotionRequest({ description: aiText, reducedMotion });
    } catch {
      return null;
    }
  }, [aiText, reducedMotion]);
  const aiDestination = aiMode ? describeDestination(aiMode) : null;
  const aiCloudBlocked = aiMode === 'online' && (aiKeyMissing || store?.cloudConfigured === false);
  /** Only a spec accepted by validateGeneratedScene (validateSceneSpec) can ever be previewed or applied. */
  const aiValidatedSpec = aiResult?.ok ? aiResult.spec : null;
  useEffect(() => () => aiAbortRef.current?.abort(), []);
  const generateWithAi = async () => {
    if (!aiApi || !aiMode || !aiRequest || aiAbortRef.current) return;
    const request = aiRequest;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiBusy(true);
    setAiResult(null);
    setAiError(null);
    setAiNote('');
    setAiLive('');
    setAiKeyMissing(false);
    const done = () => {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      if (mountedRef.current) setAiBusy(false);
    };
    if (describeDestination(aiMode).requiresConfirmation) {
      let configured = false;
      try {
        configured = (await aiApi.cloudKeyStatus()).configured === true;
      } catch {
        configured = false;
      }
      if (!configured || controller.signal.aborted) {
        done();
        if (mountedRef.current) {
          if (!configured) setAiKeyMissing(true);
          else setAiError('Stopped. Nothing was sent or applied.');
        }
        return;
      }
    }
    const out = await runMotionGeneration(aiApi, request, { signal: controller.signal, onDelta: (t) => { if (mountedRef.current) setAiLive(t); } });
    done();
    if (!mountedRef.current) return;
    if (out.outcome === 'cancelled') return setAiError('Stopped. Nothing was applied.');
    if (out.outcome === 'failed') return setAiError(out.error ?? 'No reply was generated. Nothing was applied.');
    if (out.outcome === 'truncated') setAiNote('The reply reached the length limit and was cut off before validation.');
    else if (out.outcome === 'incomplete') setAiNote(out.error ?? 'The reply ended early; only what arrived was validated.');
    setAiResult(validateGeneratedScene(out.text));
  };
  const cancelAi = () => aiAbortRef.current?.abort();
  const previewAiSpec = () => {
    if (!aiValidatedSpec) return;
    const json = serializeSceneSpec(aiValidatedSpec);
    setSpecJson(json);
    setSpecResult(validateSceneSpec(json));
    setSpecMessage('The generated scene is in the JSON box above for review. It is not applied yet.');
  };
  const applyAiSpec = () => {
    if (!aiValidatedSpec) return;
    setSettings(sceneSpecToSettings(aiValidatedSpec));
    setAiNote(`Applied "${aiValidatedSpec.name}" to layer ${activeLayer + 1}.`);
  };

  /* ---------- clip export ---------- */
  const support = recorderSupport(canvasRef.current);
  const saveStill = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paint();
    canvas.toBlob((blob) => {
      if (!mountedRef.current) return;
      if (blob) {
        downloadBlob(`${safeFileName(scene.name)}.png`, blob);
        setClipMsg({ tone: 'info', text: 'PNG export ready: choose where to save it.' });
      }
      else setClipMsg({ tone: 'danger', text: 'The stage could not be encoded as PNG.' });
    }, 'image/png');
  };
  const stopRecording = () => {
    const r = recorderRef.current;
    if (!r) return;
    window.clearTimeout(r.timer);
    if (r.rec.state !== 'inactive') r.rec.stop();
  };
  const startRecording = () => {
    if (recorderRef.current) return;
    const canvas = canvasRef.current;
    const sup = recorderSupport(canvas);
    if (!canvas || !sup.ok) {
      setClipMsg({ tone: 'warn', text: sup.ok ? 'The stage is not mounted.' : sup.reason });
      return;
    }
    if (!canRun) {
      setClipMsg({ tone: 'warn', text: 'Playback is paused, so a clip would be a still. Press Play first, or save a PNG instead.' });
      return;
    }
    const plan = normalizeClipPlan(clipPlan);
    let stream: MediaStream;
    try {
      stream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(plan.fps);
    } catch {
      setClipMsg({ tone: 'danger', text: 'The stage could not start a capture stream.' });
      return;
    }
    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: sup.mime });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setClipMsg({ tone: 'danger', text: 'The recorder could not be started in this runtime.' });
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    let failed = false;
    rec.onerror = () => {
      failed = true;
      stream.getTracks().forEach((track) => track.stop());
      if (mountedRef.current) setClipMsg({ tone: 'danger', text: 'The recorder failed; no clip was exported.' });
      stopRecording();
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recorderRef.current?.rec === rec) window.clearTimeout(recorderRef.current.timer);
      recorderRef.current = null;
      if (!mountedRef.current) return;
      setRecording(false);
      if (failed) return;
      if (chunks.length === 0) {
        setClipMsg({ tone: 'danger', text: 'The recorder produced no data.' });
        return;
      }
      downloadBlob(`${safeFileName(scene.name)}.webm`, new Blob(chunks, { type: sup.mime }));
      setClipMsg({ tone: 'info', text: 'WebM export ready: choose where to save it. Recording may be shorter if stopped early.' });
    };
    try {
      rec.start(250);
    } catch {
      rec.onstop = null;
      rec.ondataavailable = null;
      rec.onerror = null;
      stream.getTracks().forEach((track) => track.stop());
      setClipMsg({ tone: 'danger', text: 'The recorder could not start; no clip was exported.' });
      return;
    }
    const timer = window.setTimeout(() => stopRecording(), plan.seconds * 1000);
    recorderRef.current = { rec, timer, stream };
    setRecording(true);
    setClipMsg({ tone: 'info', text: `Recording ${plan.seconds} s…` });
  };

  /* ---------- clip JSON export (feature 140): sampled offline, previewed, then downloaded locally ---------- */
  const jsonClipKey = [lab, jsonClipFps, jsonClipMs, reducedMotion];
  const jsonClipReady = jsonClip && jsonClip.key.every((v, i) => v === jsonClipKey[i]) ? jsonClip : null;
  const prepareJsonClip = () => {
    try {
      const clip = sampleClip(lab, { fps: jsonClipFps, durationMs: jsonClipMs, reducedMotion });
      setJsonClip({ clip, bytes: clipByteSize(clip), key: jsonClipKey });
      setJsonClipError(null);
    } catch (err) {
      setJsonClip(null);
      setJsonClipError(err instanceof Error ? err.message : 'The clip could not be sampled.');
    }
  };
  const downloadJsonClip = () => {
    if (!jsonClipReady) return;
    const [text, options] = clipToBlobParts(jsonClipReady.clip);
    downloadBlob(`${safeFileName(scene.name)}.clip.json`, new Blob([text], options));
    setClipMsg({ tone: 'info', text: 'Clip JSON export ready: choose where to save it.' });
  };

  /* ---------- timeline authoring ---------- */
  const seekTo = (frame: number) => {
    setPlaying(false);
    frameRef.current = Math.max(0, Math.min(timeline.frames - 1, Math.round(Number.isFinite(frame) ? frame : 0)));
    fractionalFrameRef.current = 0;
    setFrameCount(frameRef.current);
    paint();
  };
  const togglePlay = () => {
    if (!playing) {
      const start = restartFrame(frameRef.current, timeline);
      if (start !== frameRef.current) {
        frameRef.current = start;
        fractionalFrameRef.current = 0;
        setFrameCount(start);
      }
    }
    setPlaying(!playing);
  };
  const layerKeyFrames = keyframeFrames(lab.tracks, layer.id);
  const previousKey = adjacentKeyFrame(layerKeyFrames, frameCount, -1);
  const nextKey = adjacentKeyFrame(layerKeyFrames, frameCount, 1);
  const hasKeyHere = lab.tracks.some((t) => t.layer === layer.id && t.param === trackKind && t.keys.some((k) => k.frame === frameCount));
  const setKeyframe = () => {
    const spec = trackParam(trackKind);
    const value = Math.min(spec.max, Math.max(spec.min, Number.isFinite(keyValue) ? keyValue : spec.rest(layer)));
    const existing = tracks.find((t) => t.layer === layer.id && t.param === trackKind);
    if (!existing && tracks.length >= MAX_TRACKS) {
      setLabMessage(`Track limit reached (${MAX_TRACKS}). Remove a track first.`);
      return;
    }
    const frame = frameRef.current;
    const replacing = existing?.keys.some((k) => k.frame === frame) ?? false;
    const updated = upsertKey(existing?.keys ?? [], { frame, value, ease: { type: 'preset', name: easing } });
    if (!updated.ok) {
      setLabMessage(`Keyframe limit reached (${MAX_KEYS} per track). Remove a key first.`);
      return;
    }
    setTracks([...tracks.filter((t) => t !== existing), { layer: layer.id, param: trackKind, keys: updated.keys }]);
    setLabMessage(`${replacing ? 'Replaced' : 'Added'} ${spec.name} keyframe at frame ${frame} (${formatTimecode(frame, timeline.fps)}).`);
  };
  const removeKey = (track: Track, frame: number) => {
    setTracks(tracks.map((t) => (t === track || (t.layer === track.layer && t.param === track.param) ? { ...t, keys: t.keys.filter((k) => k.frame !== frame) } : t)).filter((t) => t.keys.length));
    setLabMessage(`Removed ${trackParam(track.param).name} keyframe at frame ${frame}.`);
  };
  /** One validated path for pasted and file lab JSON; nothing is applied unless parseLab accepts it. */
  const applyLab = (text: string, source: string) => {
    const parsed = parseLab(text);
    if (!parsed.ok) {
      setLabMessage(`Rejected ${source}: ${parsed.error}`);
      return;
    }
    setScene(parsed.lab.scene);
    setTimeline(parsed.lab.timeline);
    setTracks(parsed.lab.tracks);
    setQuality(parsed.lab.quality);
    setActiveLayer(0);
    setPlaying(false);
    reset();
    setLabMessage(parsed.issues.length ? `Imported ${source} with changes: ${parsed.issues.join(' ')}` : `Imported ${source}.`);
  };
  const onLabFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const sequence = ++labImportSeq.current;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_LAB_BYTES) {
      setLabMessage(`Lab file exceeds ${MAX_LAB_BYTES / 1024} KB.`);
      return;
    }
    try {
      const text = await file.text();
      if (mountedRef.current && sequence === labImportSeq.current) applyLab(text, 'lab file');
    } catch {
      if (mountedRef.current && sequence === labImportSeq.current) setLabMessage('Could not read the lab file.');
    }
  };

  // The recorder follows playback: pausing, finishing a non-looping timeline or turning reduced motion on ends the clip.
  useEffect(() => {
    if (shouldStopRecording(recording, canRun)) stopRecording();
  });

  const statusText = reducedMotion
    ? `Motion is off because reduced motion is on. Showing a still frame of ${describeScene(scene)}.`
    : playing
      ? `Playing ${describeScene(scene)}. Editing layer ${activeLayer + 1}: ${describeSettings(settings)}.`
      : `Paused ${describeScene(scene)}. Editing layer ${activeLayer + 1}: ${describeSettings(settings)}.`;

  const sliders: { key: 'intensity' | 'speed' | 'hue'; label: string; hint: string; unit: string }[] = [
    { key: 'intensity', label: 'Intensity', hint: 'More layers, particles or orbits.', unit: '%' },
    { key: 'speed', label: 'Speed', hint: '0 freezes time; 50 is the natural rate.', unit: '%' },
    { key: 'hue', label: 'Colour', hint: 'Base hue of the palette.', unit: '°' },
  ];

  const frames = clipFrameCount(normalizeClipPlan(clipPlan));

  return (
    <div className={cx('motion-studio', className)}>
      {reducedMotion && (
        <Notice tone="info" title="Reduced motion is on">
          The canvas shows a single still frame and the Play control is disabled. Adjust the sliders to redraw it. Turn reduced motion off in Settings to animate.
        </Notice>
      )}

      <div className="motion-layout">
        <div className="stack">
          <Panel
            className="motion-stage-panel"
            title="Stage"
            eyebrow="Canvas"
            actions={
              <>
                <Badge tone={reducedMotion ? 'muted' : playing ? 'ok' : 'warn'}>{reducedMotion ? 'Still' : playing ? 'Playing' : 'Paused'}</Badge>
                <Button size="sm" icon={playing ? Pause : Play} onClick={togglePlay} disabled={reducedMotion} title={reducedMotion ? 'Disabled while reduced motion is on' : undefined}>
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Button size="sm" icon={ArrowCounterClockwise} onClick={reset}>
                  Reset
                </Button>
              </>
            }
          >
            <div ref={wrapRef} className={cx('motion-stage', `motion-${settings.kind}`)} style={{ ['--motion-hue' as string]: String(scene.background) }}>
              <canvas ref={canvasRef} className="motion-canvas" role="img" aria-label={`Motion preview: ${describeScene(scene)}`} aria-describedby={statusId} />
            </div>
            <p id={statusId} className="field-hint motion-status" role="status" aria-live="polite">
              {statusText}
            </p>
          </Panel>

          <Panel title="Timeline" eyebrow="Deterministic Motion Lab">
            <p className="field-hint">Original offline motion. Step or scrub exact frames; exported geometry uses the same frame engine.</p>
            <Field label="Current frame" hint={`Frame ${frameCount} of ${timeline.frames - 1} · ${formatTimecode(frameCount, timeline.fps)} of ${formatTimecode(timeline.frames - 1, timeline.fps)}`}>
              {(id, describedBy) => <input id={id} aria-describedby={describedBy} aria-valuetext={`Frame ${frameCount}, ${formatTimecode(frameCount, timeline.fps)}`} className="motion-slider" type="range" min={0} max={timeline.frames - 1} value={frameCount} onChange={(e) => seekTo(Number(e.target.value))} />}
            </Field>
            <div className="motion-key-ticks" aria-hidden style={{ position: 'relative', height: 8, margin: '0 8px 6px' }}>
              {layerKeyFrames.map((frame) => <i key={frame} style={{ position: 'absolute', top: 0, width: 2, height: 8, borderRadius: 1, background: 'currentColor', opacity: frame === frameCount ? 1 : 0.55, left: `${timeline.frames > 1 ? (frame / (timeline.frames - 1)) * 100 : 0}%` }} />)}
            </div>
            <p className="field-hint" role="status">{layerKeyFrames.length ? `Layer ${activeLayer + 1} keyframes at frames ${layerKeyFrames.join(', ')}.` : `Layer ${activeLayer + 1} has no keyframes yet.`}</p>
            <div className="row wrap" role="group" aria-label="Frame stepping">
              <Button size="sm" onClick={() => seekTo(stepFrame(frameRef.current, -1, timeline))}>Previous frame</Button>
              <Button size="sm" onClick={() => seekTo(stepFrame(frameRef.current, 1, timeline))}>Next frame</Button>
              <Button size="sm" disabled={previousKey === null} onClick={() => previousKey !== null && seekTo(previousKey)}>Previous keyframe</Button>
              <Button size="sm" disabled={nextKey === null} onClick={() => nextKey !== null && seekTo(nextKey)}>Next keyframe</Button>
              <Button size="sm" aria-pressed={timeline.loop} onClick={() => setTimeline(normalizeTimeline({ ...timeline, loop: !timeline.loop }))}>{timeline.loop ? 'Loop on' : 'Loop off'}</Button>
            </div>
            <Field label="Timeline frames" hint={`${TIMELINE_LIMITS.minFrames} to ${TIMELINE_LIMITS.maxFrames} frames. Changing duration clears tracks to keep their frame bounds valid.`}>
              {(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" type="number" min={TIMELINE_LIMITS.minFrames} max={TIMELINE_LIMITS.maxFrames} value={timeline.frames} onChange={(e) => { setTimeline(normalizeTimeline({ ...timeline, frames: Number(e.target.value) })); setTracks([]); reset(); }} />}
            </Field>
            <Field label="Timeline frame rate">{() => <Segmented<string> label="Timeline frame rate" value={String(timeline.fps)} onChange={(value) => { setTimeline(normalizeTimeline({ ...timeline, fps: Number(value) as TimelineFps })); setTracks([]); reset(); }} options={TIMELINE_FPS.map((value) => ({ value: String(value), label: `${value} fps` }))} />}</Field>
            <Field label="Quality">{() => <Segmented<QualityId> label="Preview quality" value={quality} onChange={setQuality} options={QUALITY_IDS.map((value) => ({ value, label: value }))} />}</Field>
            <Field label="Animated property">{(id) => <select id={id} className="input" value={trackKind} onChange={(e) => { const param = e.target.value as TrackParam; setTrackKind(param); setKeyValue(trackParam(param).rest(layer)); }}>{TRACK_PARAMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
            <Field label="Keyframe value" hint={`${trackParam(trackKind).min} to ${trackParam(trackKind).max}; out-of-range values are clamped.`}>{(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" type="number" min={trackParam(trackKind).min} max={trackParam(trackKind).max} value={keyValue} onChange={(e) => setKeyValue(Number(e.target.value))} />}</Field>
            <Field label="Easing">{(id) => <select id={id} className="input" value={easing} onChange={(e) => setEasing(e.target.value as EasingName)}>{EASING_LIST.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}</Field>
            <Button size="sm" onClick={setKeyframe}>{hasKeyHere ? 'Replace keyframe at current frame' : 'Set keyframe at current frame'}</Button>
            <ul className="motion-key-list" aria-label={`Keyframes for layer ${activeLayer + 1}`}>{lab.tracks.filter((t) => t.layer === layer.id).flatMap((t) => t.keys.map((key) => <li key={`${t.param}-${key.frame}`} className="row"><span>{trackParam(t.param).name}: frame {key.frame} → {key.value}</span><Button size="sm" onClick={() => removeKey(t, key.frame)}>Remove {t.param} frame {key.frame}</Button></li>))}</ul>
            <div className="row wrap" role="group" aria-label="Motion lab presets">{LAB_PRESETS.map((preset) => <Button key={preset.id} size="sm" onClick={() => { setScene(preset.lab.scene); setTimeline(preset.lab.timeline); setTracks(preset.lab.tracks); setQuality(preset.lab.quality); setActiveLayer(0); reset(); setLabMessage(`Applied lab preset ${preset.name}.`); }}>{preset.name}</Button>)}</div>
            <div className="row wrap">
              <Button size="sm" onClick={() => exportLab('motion-frame.svg', new Blob([frameToSvg(renderFrame(lab, frameRef.current, 960, 540), scene.name)], { type: 'image/svg+xml' }))}>Export SVG frame</Button>
              <Button size="sm" onClick={() => exportLab('motion-contact-sheet.svg', new Blob([contactSheetSvg(lab).svg], { type: 'image/svg+xml' }))}>Export contact sheet</Button>
              <Button size="sm" onClick={() => exportLab('motion-tracks.css', new Blob([tracksToCss(lab)], { type: 'text/css' }))}>Export CSS tracks</Button>
              <Button size="sm" onClick={() => exportLab('motion-lab.json', new Blob([serializeLab(lab)], { type: 'application/json' }))}>Export lab JSON</Button>
            </div>
            <Field label="Import lab JSON" hint={`Imports validated timeline, scene and keyframes, at most ${MAX_LAB_BYTES / 1024} KB. No scripts are executed.`}>{(id, describedBy) => <textarea id={id} aria-describedby={describedBy} rows={3} className="input" maxLength={MAX_LAB_BYTES} spellCheck={false} value={labText} onChange={(e) => setLabText(e.target.value)} />}</Field>
            <Button size="sm" disabled={!labText.trim()} onClick={() => applyLab(labText, 'pasted lab JSON')}>Import lab</Button>
            <Field label="Import lab file" hint={`JSON only, maximum ${MAX_LAB_BYTES / 1024} KB.`}>{(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" type="file" accept=".json,application/json" onChange={onLabFile} />}</Field>
            {labMessage && <p role="status" aria-live="polite" className="field-hint">{labMessage}</p>}
            <details><summary>Export and rendering limits</summary><ul>{LAB_GATES.map((gate) => <li key={gate.feature}>{gate.feature}: {gate.status}</li>)}</ul></details>
          </Panel>
          <Panel
            title="Layers"
            eyebrow="Scene composition"
            actions={
              <Button size="sm" icon={Plus} onClick={addLayer} disabled={scene.layers.length >= MAX_LAYERS}>
                Add layer
              </Button>
            }
          >
            <ol className="motion-layers" aria-label="Scene layers, bottom to top">
              {scene.layers.map((l, i) => {
                const Icon = KIND_ICON[l.kind];
                return (
                  <li key={l.id} className="motion-layer">
                    <button type="button" className={cx('motion-preset', i === activeLayer && 'on')} aria-pressed={i === activeLayer} onClick={() => { setActiveLayer(i); setActiveId(null); }}>
                      <Icon size={14} aria-hidden />
                      <span className="motion-preset-name">
                        Layer {i + 1}: {ALL_MOTION_KINDS.find((k) => k.id === l.kind)?.name}
                      </span>
                      <span className="motion-preset-meta">{l.intensity}% · {l.speed}%</span>
                    </button>
                    <label className="motion-layer-opacity">
                      <span className="sr-only">Layer {i + 1} opacity</span>
                      <input className="motion-slider" type="range" min={0} max={100} step={1} value={l.opacity} aria-label={`Layer ${i + 1} opacity`} aria-valuetext={`${l.opacity}%`} onChange={(e) => patchLayer(i, { opacity: Number(e.target.value) })} />
                      <output className="motion-value" aria-hidden>
                        {l.opacity}%
                      </output>
                    </label>
                    <IconButton icon={Trash} label={`Remove layer ${i + 1}`} size={14} disabled={scene.layers.length <= 1} onClick={() => removeLayer(i)} />
                  </li>
                );
              })}
            </ol>
            <Field label="Background hue" hint={`${scene.layers.length} of ${MAX_LAYERS} layers. The stage tint behind every layer.`}>
              {(id, describedBy) => (
                <div className="row motion-slider-row">
                  <input id={id} className="motion-slider" type="range" min={0} max={360} step={1} value={scene.background} aria-describedby={describedBy} aria-valuetext={`${scene.background}°`} onChange={(e) => setScene({ ...scene, background: Number(e.target.value) })} style={{ ['--motion-thumb' as string]: hueColor(scene.background, 85, 62) }} />
                  <output htmlFor={id} className="motion-value" aria-hidden>
                    {scene.background}°
                  </output>
                </div>
              )}
            </Field>
          </Panel>

          <Panel title="Scenes" eyebrow="Templates and saved scenes">
            <ul className="motion-presets" aria-label="Scene templates">
              {SCENE_TEMPLATES.map((s) => (
                <li key={s.id}>
                  <button type="button" className={cx('motion-preset', activeSceneId === s.id && 'on')} aria-pressed={activeSceneId === s.id} onClick={() => loadScene(s)}>
                    <i className="motion-swatch" style={{ background: hueColor(s.background, 85, 60) }} aria-hidden />
                    <span className="motion-preset-name">{s.name}</span>
                    <span className="motion-preset-meta">{s.layers.length} layers</span>
                  </button>
                </li>
              ))}
            </ul>
            {savedScenes.length > 0 ? (
              <ul className="motion-presets" aria-label="Your scenes">
                {savedScenes.map((s) => (
                  <li key={s.id}>
                    <button type="button" className={cx('motion-preset', activeSceneId === s.id && 'on')} aria-pressed={activeSceneId === s.id} onClick={() => loadScene(s)}>
                      <i className="motion-swatch" style={{ background: hueColor(s.background, 85, 60) }} aria-hidden />
                      <span className="motion-preset-name">{s.name}</span>
                      <span className="motion-preset-meta">{s.layers.length} layers</span>
                    </button>
                    <IconButton icon={Trash} label={`Delete scene ${s.name}`} size={14} onClick={() => deleteScene(s.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">No saved scenes yet. Name the current composition and save it; only layer kinds, small numbers and the name are stored on this device.</p>
            )}
            <Field label="Save scene as" error={sceneError} hint={`${savedScenes.length} of ${MAX_SAVED_SCENES} slots used. Saving with an existing name replaces it.`}>
              {(id, describedBy) => (
                <div className="row">
                  <input
                    id={id}
                    className="input"
                    type="text"
                    maxLength={MAX_PRESET_NAME}
                    value={sceneName}
                    placeholder="Scene name"
                    aria-describedby={describedBy}
                    onChange={(e) => {
                      setSceneName(e.target.value);
                      if (sceneError) setSceneError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveScene();
                      }
                    }}
                  />
                  <Button size="sm" variant="primary" icon={FloppyDisk} onClick={saveScene}>
                    Save
                  </Button>
                </div>
              )}
            </Field>
            <div className="row wrap">
              <Button size="sm" icon={DownloadSimple} onClick={exportScene}>
                Export JSON
              </Button>
              <Button size="sm" icon={Copy} onClick={copyScene}>
                Copy JSON
              </Button>
            </div>
            <Field label="Import scene" hint={`Paste scene JSON (up to ${MAX_SCENE_BYTES / 1024} KB), or paste a model reply and let the validator find the JSON inside it. Nothing is drawn until it passes.`}>
              {(id, describedBy) => (
                <div className="stack">
                  <textarea id={id} className="input motion-import" rows={4} value={importText} aria-describedby={describedBy} spellCheck={false} onChange={(e) => setImportText(e.target.value)} placeholder={SCENE_SCHEMA_HINT} />
                  <div className="row wrap">
                    <Button size="sm" variant="primary" icon={UploadSimple} onClick={importJson} disabled={!importText.trim()}>
                      Import JSON
                    </Button>
                    <Button size="sm" icon={UploadSimple} onClick={importFromText} disabled={!importText.trim()}>
                      Validate text reply
                    </Button>
                  </div>
                </div>
              )}
            </Field>
            <details>
              <summary className="field-hint">Schema a model should follow</summary>
              <pre className="motion-schema">{SCENE_SCHEMA_HINT}</pre>
              <p className="field-hint">This studio does not call a model itself. Ask the assistant for a scene, paste the reply here and only a validated result is applied.</p>
            </details>
            {importResult && (
              <Notice tone={importResult.result.ok ? (importResult.result.issues.length ? 'warn' : 'info') : 'danger'} title={importResult.result.ok ? `Applied "${importResult.result.scene.name}" from ${importResult.source}` : `Rejected ${importResult.source}`}>
                {importResult.result.ok ? (
                  importResult.result.issues.length > 0 ? (
                    <ul className="motion-issues">
                      {importResult.result.issues.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  ) : (
                    describeScene(importResult.result.scene)
                  )
                ) : (
                  importResult.result.error
                )}
              </Notice>
            )}
          </Panel>

          <Panel title="Describe a scene" eyebrow="Offline draft and validation" className="motion-describe">
            <Field label="Scene description" hint="Keywords set kind, speed, intensity and colour. Drafted on this device; no model is called.">
              {(id, describedBy) => (
                <div className="row">
                  <input id={id} className="input" type="text" maxLength={200} value={describeText} placeholder="calm blue waves" aria-describedby={describedBy} onChange={(e) => setDescribeText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); draftFromText(); } }} />
                  <Button size="sm" onClick={draftFromText}>Draft from text</Button>
                </div>
              )}
            </Field>
            {specDraft && ('error' in specDraft ? (
              <p className="field-hint motion-spec-error" role="alert">{specDraft.error}</p>
            ) : (
              <div className="motion-spec-preview" aria-label="Draft preview (not applied)">
                <p className="field-hint">Preview only, not applied yet: {describeSettings(sceneSpecToSettings(specDraft.spec))}.</p>
                <ul className="motion-issues">{specDraft.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <Button size="sm" onClick={copyDraftToJson}>Copy draft into JSON box</Button>
              </div>
            ))}
            <Field label="Paste JSON from any model; it is validated here, nothing is sent anywhere" hint={`Format "desktop-companion-scene", version 1, up to ${MAX_SCENE_SPEC_CHARS} characters.`}>
              {(id, describedBy) => (
                <textarea id={id} className="input motion-import" rows={4} maxLength={MAX_SCENE_SPEC_CHARS + 1} spellCheck={false} value={specJson} aria-describedby={describedBy} onChange={(e) => { setSpecJson(e.target.value); setSpecResult(null); setSpecMessage(''); }} />
              )}
            </Field>
            <div className="row wrap">
              <Button size="sm" onClick={validateSpec} disabled={!specJson.trim()}>Validate</Button>
              <Button size="sm" variant="primary" onClick={applySpec} disabled={!specResult?.ok}>Apply to studio</Button>
            </div>
            {specResult && (specResult.ok ? (
              <div className="motion-spec-result" role="status">
                <p className="field-hint">Valid: "{specResult.spec.name}", {describeSettings(sceneSpecToSettings(specResult.spec))}.</p>
                {specResult.warnings.length > 0 && <ul className="motion-issues" aria-label="Warnings">{specResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
              </div>
            ) : (
              <ul className="motion-issues motion-spec-error" role="alert" aria-label="Validation errors">{specResult.errors.map((e, i) => <li key={i}><code>{e.path || '(root)'}</code>: {e.message}</li>)}</ul>
            ))}
            {specMessage && <p className="field-hint" role="status">{specMessage}</p>}
          </Panel>

          <Panel title="Generate with AI" eyebrow="Assistant model, validated before use" className="motion-ai">
            <Field label="Describe the scene for the model" hint={`Up to ${MOTION_AI_LIMITS.descriptionChars} characters. This description is the only thing from you that Motion Studio puts in the request: not your library, clipboard or screen.`}>
              {(id, describedBy) => (
                <textarea id={id} className="input motion-import" rows={3} maxLength={MOTION_AI_LIMITS.descriptionChars} value={aiText} aria-describedby={describedBy} disabled={aiBusy} placeholder="slow violet aurora with a few sparks" onChange={(e) => { setAiText(e.target.value); setAiKeyMissing(false); }} />
              )}
            </Field>
            {!aiApi || !aiDestination ? (
              <p className="field-hint">The assistant service is not connected in this view, so nothing can be generated here. The offline draft above still works.</p>
            ) : (
              <>
                <details className="motion-ai-preview">
                  <summary className="field-hint">What will be sent: {aiRequest ? `${aiRequest.sentChars} characters` : 'nothing yet'} to {aiDestination.label}</summary>
                  {aiRequest ? <pre className="motion-schema motion-ai-prompt" aria-label="Exact text that will be sent">{aiRequest.preview}</pre> : <p className="field-hint">Write a description first.</p>}
                </details>
                {aiRequest && aiRequest.warnings.length > 0 && <ul className="motion-issues" aria-label="Request notes">{aiRequest.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                <p className="field-hint">Destination: {aiDestination.label}. The exchange is recorded in Assistant chat history like any other message, and the assistant may include recent Assistant conversation for context.</p>
                {aiCloudBlocked && (
                  <Notice tone="warn" title="Add your key in Settings">
                    Online mode needs a cloud API key saved in Settings. Nothing was sent.
                  </Notice>
                )}
                <div className="row wrap motion-ai-actions">
                  {aiBusy ? (
                    <Button size="sm" icon={Stop} onClick={cancelAi}>Cancel</Button>
                  ) : aiDestination.requiresConfirmation ? (
                    <Button size="sm" variant="primary" onClick={() => void generateWithAi()} disabled={!aiRequest || aiCloudBlocked}>Send to Anthropic cloud</Button>
                  ) : (
                    <Button size="sm" variant="primary" icon={Sparkle} onClick={() => void generateWithAi()} disabled={!aiRequest}>Generate locally</Button>
                  )}
                </div>
                {aiBusy && (
                  <div className="motion-ai-live" role="status" aria-live="polite">
                    <p className="field-hint">Generating… nothing is applied until the reply passes validation.</p>
                    {aiLive && <pre className="motion-schema">{aiLive.slice(-2000)}</pre>}
                  </div>
                )}
                {aiError && <p className="field-error" role="alert">{aiError}</p>}
                {aiResult && !aiResult.ok && (
                  <div className="motion-ai-result" role="alert">
                    <p className="field-hint">The reply was rejected by the scene validator. Nothing was applied.</p>
                    <ul className="motion-issues motion-spec-error" aria-label="Validation errors">{aiResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                    <Button size="sm" onClick={() => void generateWithAi()} disabled={aiBusy || !aiRequest || aiCloudBlocked}>Try again</Button>
                  </div>
                )}
                {aiValidatedSpec && (
                  <div className="motion-ai-result motion-ai-summary" role="status">
                    <p className="field-hint">
                      <i className="motion-swatch" style={{ background: hueColor(aiValidatedSpec.hue, 85, 60) }} aria-hidden /> Valid: "{aiValidatedSpec.name}", {describeSettings(sceneSpecToSettings(aiValidatedSpec))}. Not applied yet.
                    </p>
                    {aiResult?.ok && aiResult.warnings.length > 0 && <ul className="motion-issues" aria-label="Warnings">{aiResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                    <div className="row wrap">
                      <Button size="sm" onClick={previewAiSpec} disabled={!aiValidatedSpec}>Preview</Button>
                      <Button size="sm" variant="primary" onClick={applyAiSpec} disabled={!aiValidatedSpec}>Apply</Button>
                    </div>
                  </div>
                )}
                {aiNote && <p className="field-hint" role="status">{aiNote}</p>}
              </>
            )}
          </Panel>
        </div>

        <div className="stack motion-controls">
          <Panel title={`Layer ${activeLayer + 1}`} eyebrow="Shape">
            <Segmented<MotionKind> label="Motion preset" value={settings.kind} onChange={(kind) => setSettings({ kind })} options={ALL_MOTION_KINDS.map((k) => ({ value: k.id, label: k.name, icon: KIND_ICON[k.id], hint: k.blurb }))} />
            <p className="field-hint">{ALL_MOTION_KINDS.find((k) => k.id === settings.kind)?.blurb}</p>
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
              <Button size="sm" onClick={() => setSettings(DEFAULT_SETTINGS)}>
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
                    <span className="motion-preset-meta">{ALL_MOTION_KINDS.find((k) => k.id === p.kind)?.name}</span>
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
                      <span className="motion-preset-meta">
                        {ALL_MOTION_KINDS.find((k) => k.id === p.kind)?.name} · {p.intensity}% · {p.speed}%
                      </span>
                    </button>
                    <IconButton icon={Trash} label={`Delete preset ${p.name}`} size={14} onClick={() => deletePreset(p.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">No saved presets yet. Name the current layer look and save it; only the shape, three numbers and the name are stored on this device.</p>
            )}

            <Field label="Save layer look as" error={saveError} hint={`${saved.length} of ${MAX_SAVED_PRESETS} slots used. Saving with an existing name replaces it.`}>
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
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      if (saveError) setSaveError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        savePreset();
                      }
                    }}
                  />
                  <Button size="sm" variant="primary" icon={FloppyDisk} onClick={savePreset}>
                    Save
                  </Button>
                </div>
              )}
            </Field>
          </Panel>

          <Panel title="Clip export" eyebrow="Local only">
            <p className="field-hint">
              {support.ok ? 'Records the stage with the WebM encoder built into this runtime. Nothing leaves this computer.' : `Clip recording is unavailable: ${support.reason} A PNG still can always be saved.`}
            </p>
            <div className="motion-clip-grid">
              <Field label="Frame rate">
                {() => <Segmented<string> label="Clip frame rate" value={String(clipPlan.fps)} onChange={(v) => setClipPlan(normalizeClipPlan({ ...clipPlan, fps: Number(v) as ClipFps }))} options={CLIP_FPS.map((f) => ({ value: String(f), label: `${f} fps` }))} />}
              </Field>
              <Field label="Length" hint={`${CLIP_LIMITS.minSeconds} to ${CLIP_LIMITS.maxSeconds} seconds; ${frames} frames.`}>
                {(id, describedBy) => (
                  <input id={id} className="input" type="number" min={CLIP_LIMITS.minSeconds} max={CLIP_LIMITS.maxSeconds} step={1} value={clipPlan.seconds} aria-describedby={describedBy} onChange={(e) => setClipPlan(normalizeClipPlan({ ...clipPlan, seconds: Number(e.target.value) }))} />
                )}
              </Field>
            </div>
            <div className="row wrap">
              {recording ? (
                <Button size="sm" variant="primary" icon={Stop} onClick={stopRecording}>
                  Stop and save
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={Record} onClick={startRecording} disabled={!support.ok || !canRun} title={!support.ok ? support.reason : !canRun ? 'Press Play first' : undefined}>
                  Record WebM
                </Button>
              )}
              <Button size="sm" icon={DownloadSimple} onClick={saveStill}>
                Save PNG still
              </Button>
            </div>
            <div className="motion-clip-json" role="group" aria-label="Export clip">
              <div className="motion-clip-grid">
                <Field label="Clip fps">
                  {(id) => (
                    <select id={id} className="input" value={jsonClipFps} onChange={(e) => setJsonClipFps(Number(e.target.value))}>
                      {CLIP_EXPORT_FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Clip duration (ms)" hint={`${CLIP_EXPORT_LIMITS.minDurationMs} to ${CLIP_EXPORT_LIMITS.maxDurationMs} ms; ${Number.isFinite(jsonClipMs) ? clipExportFrameCount(jsonClipFps, jsonClipMs) : 0} frames.`}>
                  {(id, describedBy) => (
                    <input id={id} className="input" type="number" min={CLIP_EXPORT_LIMITS.minDurationMs} max={CLIP_EXPORT_LIMITS.maxDurationMs} step={100} value={jsonClipMs} aria-describedby={describedBy} onChange={(e) => setJsonClipMs(Math.round(Number(e.target.value)))} />
                  )}
                </Field>
              </div>
              <div className="row wrap">
                <Button size="sm" onClick={prepareJsonClip}>Export clip</Button>
                {jsonClipReady && (
                  <Button size="sm" variant="primary" icon={DownloadSimple} onClick={downloadJsonClip}>
                    Download clip JSON
                  </Button>
                )}
              </div>
              {jsonClipReady && (
                <p className="field-hint motion-clip-summary" role="status" aria-live="polite">
                  {jsonClipReady.clip.frameCount} frames at {jsonClipReady.clip.fps} fps, about {formatBytes(jsonClipReady.bytes)}{jsonClipReady.clip.reducedMotion ? ' (still frames: reduced motion is on)' : ''}. Saved only on this computer.
                </p>
              )}
              {jsonClipError && <p className="field-error" role="alert">{jsonClipError}</p>}
            </div>
            {clipMsg && (
              <p className={clipMsg.tone === 'danger' ? 'field-error' : 'field-hint'} role="status" aria-live="polite">
                {clipMsg.text}
              </p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
