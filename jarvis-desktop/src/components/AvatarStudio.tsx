import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, CaretLeft, CaretRight, Copy, DownloadSimple, FloppyDisk, Pause, Play, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import { Badge, Button, Field, IconButton, Notice, Panel, Segmented, Switch } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { cx } from '../ui/util';
import {
  AVATAR_EXPORTS,
  AVATAR_GATES,
  EMPTY_HISTORY,
  STUDIO_SHORTCUTS,
  checkExpressionName,
  classifyImportFile,
  exportPreviews,
  formatKb,
  keyframeNeighbors,
  peekRedo,
  peekUndo,
  previewImport,
  pushHistory,
  redoHistory,
  stepTime,
  studioKeyAction,
  undoHistory,
  type EditHistory,
  type ImportClass,
  type StudioAction,
  AVATAR_LIMITS,
  AVATAR_PREF_KEY,
  BUILT_IN_EXPRESSIONS,
  BUILT_IN_TIMELINES,
  DEFAULT_GEOMETRY,
  DEFAULT_PACK,
  DEFAULT_QUALITY,
  EASE_OPTIONS,
  EXPRESSION_LIMITS,
  EYE_STYLES,
  GEOMETRY_LIMITS,
  HEAD_SHAPES,
  IDLE_PREF_KEY,
  MOUTH_STYLES,
  NEUTRAL_EXPRESSION,
  NO_IDLE,
  QUALITY_PREF_KEY,
  QUALITY_PROFILES,
  SEAM_WARN,
  analyzeTimeline,
  applyIdle,
  applyVoiceLevel,
  describeExpression,
  drawAvatar,
  findExpression,
  hsl,
  idleLayer,
  isBuiltInId,
  makeAvatarId,
  mergeAvatarPacks,
  normalizeExpression,
  normalizeGeometry,
  normalizeName,
  normalizeTimeline,
  packFromStorage,
  parseAvatarPack,
  qualityProfile,
  renderAvatarSvg,
  renderContactSheetSvg,
  safeFileStem,
  sampleTimeline,
  seedFromText,
  serializeAvatarPack,
  smoothVoiceLevel,
  summarizePack,
  upsertExpression,
  upsertTimeline,
  voiceBand,
  type AvatarGeometry,
  type AvatarPack,
  type Ease,
  type Expression,
  type ExpressionPreset,
  type QualityProfile,
  type Timeline,
} from '../ui/avatar-editor';
import '../styles/avatar-studio.css';
import '../styles/parallel-avatar.css';

/**
 * Avatar Studio: an offline editor for the companion's original 2D vector avatar.
 * Geometry, expressions and timelines live in one "pack" kept under the non-sensitive UI
 * preference prefix. Packs import and export as plain JSON that is validated and bounded
 * before anything is drawn, and an import is reviewed before it changes the saved pack.
 * Nothing here reads a microphone, a camera or a model file; the voice level is either an
 * amplitude the host injects or the clearly labelled simulation slider.
 *
 * Props are stable: reducedMotion, className and voiceLevel (0..1 or null). Storage keys:
 * avatar.pack (schema version 1), avatar.quality and avatar.idle.
 */

type GeometryNumberKey = keyof typeof GEOMETRY_LIMITS;
type ExpressionKey = keyof Expression;
type Keyframe = Timeline['keyframes'][number];
type Msg = { tone: 'info' | 'warn' | 'danger'; title: string; lines: string[] };
type Pending = { pack: AvatarPack; warnings: string[]; source: string };

const GEOMETRY_SLIDERS: { key: GeometryNumberKey; label: string; unit: string }[] = [
  { key: 'headWidth', label: 'Head width', unit: '%' },
  { key: 'headHeight', label: 'Head height', unit: '%' },
  { key: 'eyeSize', label: 'Eye size', unit: '' },
  { key: 'eyeSpacing', label: 'Eye spacing', unit: '%' },
  { key: 'mouthWidth', label: 'Mouth width', unit: '%' },
  { key: 'antennaHeight', label: 'Antenna height', unit: '' },
  { key: 'bodyHue', label: 'Body colour', unit: '°' },
  { key: 'accentHue', label: 'Accent colour', unit: '°' },
  { key: 'glowHue', label: 'Glow colour', unit: '°' },
];

const EXPRESSION_SLIDERS: { key: ExpressionKey; label: string }[] = [
  { key: 'eyeOpen', label: 'Eyes open' },
  { key: 'eyeShiftX', label: 'Gaze left/right' },
  { key: 'eyeShiftY', label: 'Gaze up/down' },
  { key: 'browTilt', label: 'Brow' },
  { key: 'mouthOpen', label: 'Mouth open' },
  { key: 'mouthCurve', label: 'Mouth curve' },
  { key: 'headTilt', label: 'Head tilt' },
  { key: 'glow', label: 'Glow' },
];

/** How often the live status text and scrubber catch up with the animation clock. */
const STATUS_UPDATE_MS = 120;

function downloadText(name: string, text: string, type: string): void {
  if (typeof URL === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RangeRow({ id, describedBy, value, min, max, step, unit, onChange, thumb, disabled }: { id: string; describedBy?: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; thumb?: string; disabled?: boolean }) {
  return (
    <div className="row avs-slider-row">
      <input
        id={id}
        className="avs-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-valuetext={`${value}${unit}`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={thumb ? { ['--avs-thumb' as string]: thumb } : undefined}
      />
      <output htmlFor={id} className="avs-value" aria-hidden>
        {value}
        {unit}
      </output>
    </div>
  );
}

/**
 * Number box that keeps what you type and applies it on blur or Enter, so a half typed value is never
 * clamped under your cursor and the row does not re-sort while you are still editing.
 */
function CommitNumber({ id, label, value, min, max, step, onCommit, describedBy, className }: { id: string; label?: string; value: number; min: number; max: number; step: number; onCommit: (n: number) => void; describedBy?: string; className?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <input
      id={id}
      className={cx('input', className)}
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      aria-label={label}
      aria-describedby={describedBy}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

const dataUri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function AvatarStudio({
  reducedMotion,
  className,
  voiceLevel = null,
  voiceSourceLabel = 'Host',
}: {
  reducedMotion: boolean;
  className?: string;
  /** Host-injected speech amplitude 0..1, or null when no audio source is attached. */
  voiceLevel?: number | null;
  /** What the injected amplitude is (for example "Assistant microphone"); shown only while one is attached. */
  voiceSourceLabel?: string;
}) {
  const [rawPack, setRawPack] = usePref<unknown>(AVATAR_PREF_KEY, null);
  const pack = useMemo<AvatarPack>(() => packFromStorage(rawPack), [rawPack]);
  const savePack = useCallback((next: AvatarPack) => setRawPack(JSON.parse(serializeAvatarPack(next))), [setRawPack]);

  const [rawQuality, setRawQuality] = usePref<unknown>(QUALITY_PREF_KEY, DEFAULT_QUALITY);
  const quality = qualityProfile(rawQuality);
  const [rawIdle, setRawIdle] = usePref<unknown>(IDLE_PREF_KEY, false);
  const idleOn = rawIdle === true && !reducedMotion;

  const [draftExpr, setDraftExpr] = useState<Expression>(NEUTRAL_EXPRESSION);
  const [exprName, setExprName] = useState('');
  const [exprError, setExprError] = useState<string | null>(null);
  const [activeExprId, setActiveExprId] = useState<string>('builtin:neutral');

  const [draftTl, setDraftTl] = useState<Timeline | null>(null);
  const [tlError, setTlError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [simLevel, setSimLevel] = useState(0);
  const [voiceTail, setVoiceTail] = useState(false);

  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<Msg | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<EditHistory>(EMPTY_HISTORY);
  const importGeneration = useRef(0);
  useEffect(() => () => { importGeneration.current += 1; }, []);
  const [dropHover, setDropHover] = useState(false);
  const [packName, setPackName] = useState(pack.name);
  useEffect(() => setPackName(pack.name), [pack.name]);

  /** Every change to the saved pack goes through here so it can be undone and redone (bounded, in memory only). */
  const setUndo = useCallback((entry: { label: string; pack: AvatarPack; coalesce?: string }) => setHistory((h) => pushHistory(h, entry)), []);
  const commit = (label: string, next: AvatarPack, coalesce?: string) => {
    setUndo({ label, pack, coalesce });
    savePack(next);
  };
  const undo = peekUndo(history);
  const redo = peekRedo(history);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const tRef = useRef(0);
  const idleTRef = useRef(0);
  const envRef = useRef(0);
  const lastStatusRef = useRef(0);
  const idSeq = useRef(0);
  const statusId = useId();

  const hostVoice = voiceLevel !== null && Number.isFinite(voiceLevel);
  const target = hostVoice ? Math.min(1, Math.max(0, voiceLevel as number)) : simLevel;
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (target > 0) setVoiceTail(true);
  }, [target > 0]);

  const seed = useMemo(() => seedFromText(pack.name), [pack.name]);
  const canPlay = !!draftTl && draftTl.keyframes.length > 0 && !reducedMotion;
  const running = playing && canPlay;
  /** The frame loop runs only while something moves: a timeline, the idle preview or a voice level settling. */
  const animate = !reducedMotion && (running || idleOn || voiceTail);

  /** The timeline or draft pose alone: what exports and the contact sheet show. */
  const basePose = useCallback(
    (tMs: number): Expression => (draftTl && draftTl.keyframes.length > 0 ? sampleTimeline(draftTl, pack.expressions, tMs, reducedMotion) : draftExpr),
    [draftTl, pack.expressions, reducedMotion, draftExpr],
  );
  /** The pose that is drawn right now: base pose, then the idle layer, then the voice amplitude. */
  const poseAt = useCallback(
    (tMs: number): Expression => {
      let e = basePose(tMs);
      if (idleOn) e = applyIdle(e, idleLayer(idleTRef.current, seed));
      return applyVoiceLevel(e, envRef.current);
    },
    [basePose, idleOn, seed],
  );
  const poseRef = useRef(poseAt);
  poseRef.current = poseAt;
  const geometryRef = useRef(pack.geometry);
  geometryRef.current = pack.geometry;
  const idleRef = useRef(idleOn);
  idleRef.current = idleOn;
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const paint = useCallback((tMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const { w, h } = sizeRef.current;
    if (!canvas || !ctx || w === 0 || h === 0) return;
    ctx.clearRect(0, 0, w, h);
    const idle = idleRef.current ? idleLayer(idleTRef.current, seedRef.current) : NO_IDLE;
    drawAvatar(ctx, w, h, geometryRef.current, poseRef.current(tMs), typeof Path2D !== 'undefined' ? Path2D : undefined, { dy: idle.dy });
  }, []);

  // Fit the canvas to its box; the quality profile caps the device pixel ratio.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(quality.maxDpr, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
      paint(tRef.current);
    };
    fit();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit);
      ro.observe(wrap);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [paint, quality.maxDpr]);

  // Still repaint whenever the pose inputs change and nothing is animating. With reduced motion the
  // injected level is applied directly (no smoothing), because lip movement follows speech, not decoration.
  useEffect(() => {
    if (!animate) {
      tRef.current = scrub;
      envRef.current = targetRef.current;
      paint(scrub);
    }
  }, [animate, scrub, paint, poseAt, pack.geometry, target]);

  // Frame loop, throttled to the profile's frame rate and paused while the window is hidden.
  useEffect(() => {
    if (!animate) return undefined;
    let active = true;
    const frameMs = 1000 / quality.fps;
    const tick = (ts: number) => {
      if (!active) return;
      const last = lastTsRef.current;
      if (last === null || ts - last >= frameMs - 0.5) {
        const dt = last === null ? 0 : Math.min(100, ts - last);
        lastTsRef.current = ts;
        idleTRef.current += dt;
        envRef.current = smoothVoiceLevel(envRef.current, targetRef.current, dt);
        if (running && draftTl) {
          let t = tRef.current + dt;
          if (t >= draftTl.duration) {
            if (draftTl.loop) t %= Math.max(1, draftTl.duration);
            else {
              t = draftTl.duration;
              setPlaying(false);
            }
          }
          tRef.current = t;
          if (ts - lastStatusRef.current >= STATUS_UPDATE_MS || t >= draftTl.duration) {
            lastStatusRef.current = ts;
            setScrub(Math.round(t));
          }
        }
        paint(tRef.current);
        if (!running && !idleOn && targetRef.current === 0 && envRef.current === 0) {
          active = false;
          setVoiceTail(false);
        }
      }
      if (active) rafRef.current = window.requestAnimationFrame(tick);
    };
    const start = () => {
      lastTsRef.current = null;
      rafRef.current = window.requestAnimationFrame(tick);
    };
    const stop = () => window.cancelAnimationFrame(rafRef.current);
    const onVisibility = () => {
      stop();
      if (document.visibilityState === 'visible' && active) start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') start();
    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [animate, running, idleOn, draftTl, quality.fps, paint]);

  useEffect(() => {
    if (reducedMotion) {
      setPlaying(false);
      setVoiceTail(false);
    }
  }, [reducedMotion]);

  // Unmount: drop any pending frame and release the canvas bitmap so a hidden route holds no pixels.
  useEffect(
    () => () => {
      window.cancelAnimationFrame(rafRef.current);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      sizeRef.current = { w: 0, h: 0 };
    },
    [],
  );

  /* ---------- geometry ---------- */
  /** Slider drags coalesce into one history step per control; a different control starts a new step. */
  const setGeometry = (patch: Partial<AvatarGeometry>) => {
    const keys = Object.keys(patch);
    commit(`geometry ${keys.join(', ')}`, { ...pack, geometry: normalizeGeometry({ ...pack.geometry, ...patch }, pack.geometry) }, `geometry:${keys.join(',')}`);
  };

  /* ---------- expressions ---------- */
  const nextId = (prefix: string) => makeAvatarId(prefix, Date.now() * 100 + (idSeq.current++ % 100));
  const loadExpression = (p: ExpressionPreset) => {
    setDraftExpr(p.expression);
    setActiveExprId(p.id);
    setExprName(isBuiltInId(p.id) ? '' : p.name);
    setExprError(null);
  };
  const setExpr = (patch: Partial<Expression>) => {
    setDraftExpr((prev) => normalizeExpression({ ...prev, ...patch }, prev));
    setActiveExprId('');
  };
  /** Live validation of the pose name: reserved built-in names, slot limits and replacements are shown before Save. */
  const nameCheck = useMemo(() => checkExpressionName(exprName, pack.expressions), [exprName, pack.expressions]);
  const saveExpression = () => {
    if (!nameCheck.ok) {
      setExprError(nameCheck.reason);
      return;
    }
    const id = nameCheck.replaces?.id ?? nextId('ex');
    const { list, ok, reason } = upsertExpression(pack.expressions, { id, name: nameCheck.name, expression: draftExpr });
    if (!ok) {
      setExprError(reason ?? 'Could not save the expression.');
      return;
    }
    commit(nameCheck.replaces ? `replace pose "${nameCheck.name}"` : `save pose "${nameCheck.name}"`, { ...pack, expressions: list });
    setActiveExprId(id);
    setExprError(null);
  };
  const deleteExpression = (id: string) => {
    // Timelines that referenced the expression lose those keyframes; normalizeTimeline drops them.
    const expressions = pack.expressions.filter((p) => p.id !== id);
    const timelines = pack.timelines.map((t) => normalizeTimeline(t, expressions, t.id)).filter((t): t is Timeline => t !== null);
    commit(`delete pose "${pack.expressions.find((p) => p.id === id)?.name ?? id}"`, { ...pack, expressions, timelines });
    if (activeExprId === id) setActiveExprId('');
    if (draftTl) setDraftTl(normalizeTimeline(draftTl, expressions, draftTl.id));
  };

  /* ---------- timelines ---------- */
  const allExpressions = useMemo(() => [...BUILT_IN_EXPRESSIONS, ...pack.expressions], [pack.expressions]);
  const seekTo = (ms: number) => {
    setPlaying(false);
    tRef.current = ms;
    setScrub(ms);
  };
  const openTimeline = (tl: Timeline) => {
    const copy = { ...tl, keyframes: tl.keyframes.map((k) => ({ ...k })) };
    setDraftTl(isBuiltInId(tl.id) ? { ...copy, id: nextId('tl'), name: `${tl.name} copy` } : copy);
    seekTo(0);
    setTlError(null);
  };
  const newTimeline = () => {
    openTimeline({ id: nextId('tl'), name: 'New timeline', duration: 2000, loop: false, keyframes: [{ at: 0, expressionId: findExpression(activeExprId, pack.expressions) ? activeExprId : 'builtin:neutral', ease: 'ease' }] });
  };
  const patchTimeline = (patch: Partial<Timeline>) => {
    if (!draftTl) return;
    const next = normalizeTimeline({ ...draftTl, ...patch }, pack.expressions, draftTl.id);
    if (next) {
      setDraftTl(next);
      if (scrub > next.duration) seekTo(next.duration);
    }
    setTlError(null);
  };
  const addKeyframe = () => {
    if (!draftTl) return;
    if (draftTl.keyframes.length >= AVATAR_LIMITS.keyframes) {
      setTlError(`A timeline holds up to ${AVATAR_LIMITS.keyframes} keyframes.`);
      return;
    }
    const expressionId = findExpression(activeExprId, pack.expressions) ? activeExprId : 'builtin:neutral';
    patchTimeline({ keyframes: [...draftTl.keyframes, { at: Math.min(draftTl.duration, scrub), expressionId, ease: 'ease' }] });
  };
  const editKeyframe = (i: number, patch: Partial<Keyframe>) => {
    if (!draftTl) return;
    patchTimeline({ keyframes: draftTl.keyframes.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  };
  const removeKeyframe = (i: number) => {
    if (!draftTl) return;
    patchTimeline({ keyframes: draftTl.keyframes.filter((_, j) => j !== i) });
  };
  const saveTimeline = () => {
    if (!draftTl) return;
    if (draftTl.keyframes.length === 0) {
      setTlError('Add at least one keyframe before saving.');
      return;
    }
    const { list, ok, reason } = upsertTimeline(pack.timelines, draftTl);
    if (!ok) {
      setTlError(reason ?? 'Could not save the timeline.');
      return;
    }
    commit(`save timeline "${draftTl.name}"`, { ...pack, timelines: list });
    setTlError(null);
  };
  const deleteTimeline = (id: string) => {
    commit(`delete timeline "${pack.timelines.find((t) => t.id === id)?.name ?? id}"`, { ...pack, timelines: pack.timelines.filter((t) => t.id !== id) });
    if (draftTl?.id === id) setDraftTl(null);
  };
  const closeTimeline = () => {
    setDraftTl(null);
    seekTo(0);
  };
  const neighbors = draftTl ? keyframeNeighbors(draftTl, scrub) : null;
  /** Keyboard and button transport share one path; every move is clamped by the model. */
  const transport = (action: StudioAction) => {
    if (!draftTl) return;
    if (action === 'play') {
      if (canPlay) setPlaying((p) => !p);
      return;
    }
    seekTo(stepTime(draftTl, scrub, action));
  };

  const report = useMemo(() => (draftTl ? analyzeTimeline(draftTl, pack.expressions) : null), [draftTl, pack.expressions]);
  const sheetSvg = useMemo(
    () => (draftTl && draftTl.keyframes.length > 0 ? renderContactSheetSvg(pack.geometry, draftTl, pack.expressions, { frames: 8, columns: 4, cell: 120 }) : null),
    [draftTl, pack.geometry, pack.expressions],
  );

  /* ---------- packs ---------- */
  /** Parse and bound the input, then hold it for review. Nothing is saved until the user chooses. */
  const stageImport = (input: unknown, source: string) => {
    importGeneration.current += 1;
    const r = parseAvatarPack(input);
    if (!r.ok) {
      setPending(null);
      setImportMsg({ tone: 'danger', title: `Import from ${source} was rejected`, lines: [r.error] });
      return;
    }
    setImportMsg(null);
    setPending({ pack: r.pack, warnings: r.warnings, source });
  };
  const finishImport = (mode: 'replace' | 'merge') => {
    if (!pending) return;
    importGeneration.current += 1;
    const before = pack;
    if (mode === 'replace') {
      savePack(pending.pack);
      closeTimeline();
      setImportMsg({
        tone: pending.warnings.length ? 'warn' : 'info',
        title: `Replaced the pack with "${pending.pack.name}"`,
        lines: pending.warnings.length ? pending.warnings : [`${pending.pack.expressions.length} expressions, ${pending.pack.timelines.length} timelines.`],
      });
    } else {
      const m = mergeAvatarPacks(pack, pending.pack);
      savePack(m.pack);
      const lines = [`Added ${m.addedExpressions} expressions and ${m.addedTimelines} timelines. Your geometry and name were kept.`, ...m.warnings, ...pending.warnings];
      setImportMsg({ tone: m.warnings.length || pending.warnings.length ? 'warn' : 'info', title: `Added content from "${pending.pack.name}"`, lines });
    }
    setUndo({ label: mode === 'replace' ? 'import' : 'merge', pack: before });
    setPending(null);
    setImportText('');
  };
  /** Restore a pack from the history and keep the open timeline consistent with the restored expressions. */
  const restore = (step: { history: EditHistory; pack: AvatarPack; label: string } | null, verb: 'Undid' | 'Redid') => {
    if (!step) return;
    setHistory(step.history);
    savePack(step.pack);
    if (draftTl) setDraftTl(normalizeTimeline(draftTl, step.pack.expressions, draftTl.id));
    setPending(null);
    setImportMsg({ tone: 'info', title: `${verb} ${step.label}`, lines: [`Pack is "${step.pack.name}" with ${step.pack.expressions.length} expressions and ${step.pack.timelines.length} timelines.`] });
  };
  const undoLast = () => restore(undoHistory(history, pack), 'Undid');
  const redoLast = () => restore(redoHistory(history, pack), 'Redid');
  /**
   * Chosen or dropped files: each is classified by name and size first. Only one pack JSON inside
   * the size bound is read; every other file is listed with its format and why it is not read.
   */
  const importFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    const generation = ++importGeneration.current;
    const classed = files.map((f) => ({ file: f, info: classifyImportFile(f) as ImportClass }));
    const first = classed.find((c) => c.info.kind === 'pack');
    const rejected = classed.filter((c) => c !== first);
    const lines = rejected.map((c) => `${c.file.name}: ${c.info.format}. ${c.info.reason}`);
    if (!first) {
      setImportMsg({ tone: 'danger', title: rejected.length === 1 ? 'File was not read' : `${rejected.length} files were not read`, lines });
      return;
    }
    if (first.file.size > AVATAR_LIMITS.packBytes) return; // classifyImportFile already marks this unsupported; kept as a guard before reading.
    first.file
      .text()
      .then((text) => {
        if (generation !== importGeneration.current) return;
        stageImport(text, first.file.name);
        if (lines.length) setImportMsg({ tone: 'warn', title: `Only "${first.file.name}" was read`, lines });
      })
      .catch(() => {
        if (generation === importGeneration.current) setImportMsg({ tone: 'danger', title: 'File could not be read', lines: ['The file was not readable as text.', ...lines] });
      });
  };
  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    importFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDropHover(false);
    importFiles(Array.from(e.dataTransfer?.files ?? []));
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!dropHover) setDropHover(true);
  };
  /** Shortcuts fire only from the stage, sliders and empty space; text fields and buttons keep their own keys. */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName ?? '';
    const editing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range') || !!el?.isContentEditable;
    const interactive = tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'LABEL' || (tag === 'INPUT' && (el as HTMLInputElement).type === 'range' && e.key !== ' ');
    const action = studioKeyAction({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, editing, interactive });
    if (!action) return;
    if (action === 'undo') {
      if (!undo) return;
      e.preventDefault();
      undoLast();
      return;
    }
    if (action === 'redo') {
      if (!redo) return;
      e.preventDefault();
      redoLast();
      return;
    }
    if (!draftTl) return;
    e.preventDefault();
    transport(action);
  };
  const stem = safeFileStem(pack.name);
  const exportPack = () => downloadText(`${stem}.avatar.json`, serializeAvatarPack(pack), 'application/json');
  const exportSvg = () => downloadText(`${stem}.svg`, renderAvatarSvg(pack.geometry, basePose(scrub), pack.name), 'image/svg+xml');
  const exportSheet = () => sheetSvg && downloadText(`${stem}-${safeFileStem(draftTl?.name ?? 'timeline', 'timeline')}-sheet.svg`, sheetSvg, 'image/svg+xml');
  const copyPack = () => {
    const text = serializeAvatarPack(pack);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => setImportMsg({ tone: 'info', title: 'Pack copied as JSON', lines: ['Paste it into another copy of this app to import it.'] }))
        .catch(() => setImportText(text));
    } else setImportText(text);
  };
  const resetPack = () => {
    setUndo({ label: 'reset', pack });
    savePack({ ...DEFAULT_PACK, geometry: DEFAULT_GEOMETRY });
    closeTimeline();
    setPending(null);
    setImportMsg({ tone: 'info', title: 'Pack reset', lines: ['Geometry is back to the default companion. Saved expressions and timelines were removed. Use Undo to bring them back.'] });
  };
  const renamePack = () => {
    const name = normalizeName(packName, DEFAULT_PACK.name);
    if (name !== pack.name) commit(`rename to "${name}"`, { ...pack, name });
    setPackName(name);
  };
  const exports = useMemo(() => exportPreviews(pack, basePose(scrub), draftTl, sheetSvg), [pack, basePose, scrub, draftTl, sheetSvg]);
  const exportActions: Record<string, (() => void) | undefined> = { json: exportPack, 'svg-pose': exportSvg, 'svg-sheet': exportSheet };
  const pendingPreview = useMemo(() => (pending ? previewImport(pack, pending.pack) : null), [pending, pack]);

  const pose = poseAt(scrub);
  const band = voiceBand(target);
  const voiceNote = hostVoice ? ` Voice: ${voiceSourceLabel} amplitude attached, ${band}.` : target > 0 ? ` Voice: simulated level, ${band}.` : '';
  const statusText = reducedMotion
    ? `Reduced motion: timelines hold their nearest keyframe instead of tweening and idle motion is off. Showing ${describeExpression(pose)}.${voiceNote}`
    : running
      ? `Playing "${draftTl?.name}" at ${scrub} ms: ${describeExpression(pose)}.${voiceNote}`
      : `Still: ${describeExpression(pose)}.${idleOn ? ' Idle preview is on.' : ''}${voiceNote}`;
  const currentSummary = summarizePack(pack);

  return (
    <div className={cx('avatar-studio', className)} onKeyDown={onKeyDown}>
      {reducedMotion && (
        <Notice tone="info" title="Reduced motion is on">
          Timeline playback and idle motion are disabled and poses never tween; the scrubber shows each keyframe as a still. Turn reduced motion off in Settings to animate.
        </Notice>
      )}

      <div className="avs-layout">
        <div className="stack">
          <Panel
            className="avs-stage-panel"
            title="Stage"
            eyebrow="Canvas"
            actions={
              <>
                {hostVoice ? <Badge tone="info">{voiceSourceLabel} voice{target > 0 ? '' : ' · quiet'}</Badge> : target > 0 ? <Badge tone="warn">Simulated voice</Badge> : null}
                <Badge tone={reducedMotion ? 'muted' : running ? 'ok' : 'warn'}>{reducedMotion ? 'Still' : running ? 'Playing' : 'Paused'}</Badge>
                <Button
                  size="sm"
                  icon={playing ? Pause : Play}
                  onClick={() => setPlaying((p) => !p)}
                  disabled={!canPlay}
                  aria-pressed={playing}
                  title={!draftTl ? 'Open a timeline to play it' : reducedMotion ? 'Disabled while reduced motion is on' : undefined}
                >
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Button size="sm" icon={ArrowCounterClockwise} onClick={() => seekTo(0)} disabled={!draftTl}>
                  Rewind
                </Button>
              </>
            }
          >
            <div ref={wrapRef} className="avs-stage" style={{ ['--avs-glow' as string]: hsl(pack.geometry.glowHue, 80, 60, 0.18) }}>
              <canvas ref={canvasRef} className="avs-canvas" role="img" aria-label={`Avatar preview: ${describeExpression(pose)}`} aria-describedby={statusId} />
            </div>
            <p id={statusId} className="field-hint avs-status" role="status" aria-live="polite">
              {statusText}
            </p>
            {draftTl && neighbors && (
              <>
                <Field label={`Time in "${draftTl.name}"`} hint={`${scrub} of ${draftTl.duration} ms${draftTl.loop ? ', looping' : ''}.`}>
                  {(id, describedBy) => <RangeRow id={id} describedBy={describedBy} value={Math.min(scrub, draftTl.duration)} min={0} max={draftTl.duration} step={10} unit=" ms" onChange={seekTo} />}
                </Field>
                <div className="avs-transport" role="group" aria-label="Keyframe navigation">
                  <Button size="sm" icon={CaretLeft} onClick={() => transport('prevKey')} disabled={neighbors.prev === null} aria-label="Previous keyframe">
                    Previous
                  </Button>
                  <span className="field-hint avs-transport-pos">
                    {neighbors.at !== null
                      ? `Keyframe ${neighbors.at + 1} of ${draftTl.keyframes.length}`
                      : neighbors.prev === null
                        ? 'Before keyframe 1'
                        : neighbors.next === null
                          ? `After keyframe ${draftTl.keyframes.length}`
                          : `Between keyframes ${neighbors.prev + 1} and ${neighbors.next + 1}`}
                  </span>
                  <Button size="sm" icon={CaretRight} onClick={() => transport('nextKey')} disabled={neighbors.next === null} aria-label="Next keyframe">
                    Next
                  </Button>
                </div>
              </>
            )}
            <Switch
              label="Preview idle life"
              description="Seeded blink and gentle breathing on top of the pose, for judging how the avatar feels at rest. Off under reduced motion and never exported."
              checked={idleOn}
              disabled={reducedMotion}
              onChange={(v) => setRawIdle(v)}
            />
          </Panel>

          <Panel title="Voice reaction" eyebrow="Scope 134 · injected only">
            <p className="field-hint">
              The mouth and glow open with a speech amplitude the host passes in, smoothed with a quick attack and a slower release. The studio never opens the microphone.
            </p>
            {hostVoice ? (
              <div className="avs-meter-row">
                <label htmlFor={`${statusId}-meter`}>{voiceSourceLabel} amplitude</label>
                <meter id={`${statusId}-meter`} className="avs-meter" min={0} max={1} value={target} aria-valuetext={`${Math.round(target * 100)} percent, ${band}`} />
                <output className="avs-value">{Math.round(target * 100)}%</output>
              </div>
            ) : (
              <p className="field-hint">No audio source is attached, so the slider below only simulates a level for previewing. It is not a microphone reading.</p>
            )}
            <Field label="Simulated level (preview only)" hint={hostVoice ? 'Disabled while a host amplitude is attached.' : undefined}>
              {(id, describedBy) => <RangeRow id={id} describedBy={describedBy} value={Math.round(simLevel * 100)} min={0} max={100} step={1} unit="%" disabled={hostVoice} onChange={(v) => setSimLevel(v / 100)} />}
            </Field>
          </Panel>

          <Panel title="Quality profile" eyebrow="Scope 136 · manual">
            <Segmented<QualityProfile['id']> label="Quality profile" value={quality.id} onChange={(id) => setRawQuality(id)} options={QUALITY_PROFILES.map((q) => ({ value: q.id, label: q.name, hint: q.blurb }))} />
            <p className="field-hint">{quality.blurb} Profiles are chosen by hand; this build does not detect hardware.</p>
          </Panel>

          <Panel title="Not in this build" eyebrow="Honest gates">
            <ul className="avs-gates" aria-label="Avatar scopes that are not implemented">
              {AVATAR_GATES.map((g) => (
                <li key={g.id}>
                  <Badge tone={g.status === 'unavailable' ? 'danger' : g.status === 'injected' ? 'info' : 'warn'}>{g.status}</Badge>
                  <span>
                    <strong>{g.name}</strong>
                    <span className="field-hint">{g.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
            <ul className="avs-gates" aria-label="Export formats">
              {AVATAR_EXPORTS.map((x) => (
                <li key={x.id}>
                  <Badge tone={x.status === 'available' ? 'ok' : 'danger'}>{x.status}</Badge>
                  <span>
                    <strong>{x.name}</strong>
                    <span className="field-hint">{x.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="stack avs-controls">
          <Panel title="Geometry" eyebrow="Scope 129">
            <Segmented label="Head shape" value={pack.geometry.headShape} onChange={(headShape) => setGeometry({ headShape })} options={HEAD_SHAPES.map((h) => ({ value: h.id, label: h.name }))} />
            <Segmented label="Eye style" value={pack.geometry.eyeStyle} onChange={(eyeStyle) => setGeometry({ eyeStyle })} options={EYE_STYLES.map((h) => ({ value: h.id, label: h.name }))} />
            <Segmented label="Mouth style" value={pack.geometry.mouthStyle} onChange={(mouthStyle) => setGeometry({ mouthStyle })} options={MOUTH_STYLES.map((h) => ({ value: h.id, label: h.name }))} />
            {GEOMETRY_SLIDERS.map((sl) => (
              <Field key={sl.key} label={sl.label} className="avs-field">
                {(id, describedBy) => (
                  <RangeRow
                    id={id}
                    describedBy={describedBy}
                    value={pack.geometry[sl.key]}
                    min={GEOMETRY_LIMITS[sl.key].min}
                    max={GEOMETRY_LIMITS[sl.key].max}
                    step={GEOMETRY_LIMITS[sl.key].step}
                    unit={sl.unit}
                    onChange={(v) => setGeometry({ [sl.key]: v })}
                    thumb={sl.key.endsWith('Hue') ? hsl(pack.geometry[sl.key], 85, 60) : undefined}
                  />
                )}
              </Field>
            ))}
            <Switch label="Antenna" checked={pack.geometry.antenna} onChange={(antenna) => setGeometry({ antenna })} />
            <Switch label="Visor" checked={pack.geometry.visor} onChange={(visor) => setGeometry({ visor })} />
            <Switch label="Cheeks" checked={pack.geometry.cheeks} onChange={(cheeks) => setGeometry({ cheeks })} />
            <div className="row wrap">
              <Button size="sm" onClick={() => savePack({ ...pack, geometry: DEFAULT_GEOMETRY })}>
                Default geometry
              </Button>
            </div>
          </Panel>

          <Panel title="Expressions" eyebrow="Scope 130">
            <ul className="avs-list" aria-label="Built-in expressions">
              {BUILT_IN_EXPRESSIONS.map((p) => (
                <li key={p.id}>
                  <button type="button" className={cx('avs-item', activeExprId === p.id && 'on')} aria-pressed={activeExprId === p.id} onClick={() => loadExpression(p)}>
                    <span className="avs-item-name">{p.name}</span>
                    <span className="avs-item-meta">{describeExpression(p.expression)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {pack.expressions.length > 0 ? (
              <ul className="avs-list" aria-label="Your expressions">
                {pack.expressions.map((p) => (
                  <li key={p.id}>
                    <button type="button" className={cx('avs-item', activeExprId === p.id && 'on')} aria-pressed={activeExprId === p.id} onClick={() => loadExpression(p)}>
                      <span className="avs-item-name">{p.name}</span>
                      <span className="avs-item-meta">{describeExpression(p.expression)}</span>
                    </button>
                    <IconButton icon={Trash} label={`Delete expression ${p.name}`} size={14} onClick={() => deleteExpression(p.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">No saved expressions yet. Adjust the sliders, name the pose and save it to this pack.</p>
            )}
            {EXPRESSION_SLIDERS.map((sl) => (
              <Field key={sl.key} label={sl.label} className="avs-field">
                {(id, describedBy) => (
                  <RangeRow
                    id={id}
                    describedBy={describedBy}
                    value={draftExpr[sl.key]}
                    min={EXPRESSION_LIMITS[sl.key].min}
                    max={EXPRESSION_LIMITS[sl.key].max}
                    step={EXPRESSION_LIMITS[sl.key].step}
                    unit={sl.key === 'headTilt' ? '°' : ''}
                    onChange={(v) => setExpr({ [sl.key]: v })}
                  />
                )}
              </Field>
            ))}
            <Field
              label="Save pose as"
              error={exprError}
              hint={
                exprName.trim()
                  ? nameCheck.ok
                    ? (nameCheck.note ?? `New pose "${nameCheck.name}". ${pack.expressions.length} of ${AVATAR_LIMITS.expressions} slots used.`)
                    : nameCheck.reason
                  : `${pack.expressions.length} of ${AVATAR_LIMITS.expressions} slots used. Built-in names are reserved; saving with one of your existing names replaces that pose.`
              }
            >
              {(id, describedBy) => (
                <div className="row">
                  <input
                    id={id}
                    className="input"
                    type="text"
                    maxLength={AVATAR_LIMITS.nameLength}
                    value={exprName}
                    placeholder="Expression name"
                    aria-describedby={describedBy}
                    onChange={(e) => {
                      setExprName(e.target.value);
                      if (exprError) setExprError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveExpression();
                      }
                    }}
                  />
                  <Button size="sm" variant="primary" icon={FloppyDisk} onClick={saveExpression}>
                    Save
                  </Button>
                </div>
              )}
            </Field>
          </Panel>

          <Panel
            title="Timelines"
            eyebrow="Scope 131"
            actions={
              <Button size="sm" icon={Plus} onClick={newTimeline}>
                New
              </Button>
            }
          >
            <ul className="avs-list" aria-label="Built-in timelines">
              {BUILT_IN_TIMELINES.map((t) => (
                <li key={t.id}>
                  <button type="button" className="avs-item" onClick={() => openTimeline(t)}>
                    <span className="avs-item-name">{t.name}</span>
                    <span className="avs-item-meta">
                      {t.keyframes.length} keyframes · {t.duration} ms{t.loop ? ' · loop' : ''} · opens as a copy
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {pack.timelines.length > 0 && (
              <ul className="avs-list" aria-label="Your timelines">
                {pack.timelines.map((t) => (
                  <li key={t.id}>
                    <button type="button" className={cx('avs-item', draftTl?.id === t.id && 'on')} aria-pressed={draftTl?.id === t.id} onClick={() => openTimeline(t)}>
                      <span className="avs-item-name">{t.name}</span>
                      <span className="avs-item-meta">
                        {t.keyframes.length} keyframes · {t.duration} ms{t.loop ? ' · loop' : ''}
                      </span>
                    </button>
                    <IconButton icon={Trash} label={`Delete timeline ${t.name}`} size={14} onClick={() => deleteTimeline(t.id)} />
                  </li>
                ))}
              </ul>
            )}

            {draftTl ? (
              <div className="avs-timeline" role="group" aria-label={`Editing timeline ${draftTl.name}`}>
                <Field label="Timeline name">
                  {(id) => <input id={id} className="input" type="text" maxLength={AVATAR_LIMITS.nameLength} value={draftTl.name} onChange={(e) => setDraftTl({ ...draftTl, name: e.target.value })} onBlur={() => patchTimeline({})} />}
                </Field>
                <Field label="Duration" hint={`${AVATAR_LIMITS.minDurationMs} to ${AVATAR_LIMITS.maxDurationMs} ms. Keyframes past the end are dropped.`}>
                  {(id, describedBy) => <CommitNumber id={id} describedBy={describedBy} value={draftTl.duration} min={AVATAR_LIMITS.minDurationMs} max={AVATAR_LIMITS.maxDurationMs} step={10} onCommit={(n) => patchTimeline({ duration: n })} />}
                </Field>
                <Switch label="Loop" checked={draftTl.loop} onChange={(loop) => patchTimeline({ loop })} />
                <ol className="avs-keyframes" aria-label="Keyframes">
                  {draftTl.keyframes.map((k, i) => (
                    <li key={i} className="avs-keyframe">
                      <CommitNumber id={`${statusId}-kf-at-${i}`} label={`Keyframe ${i + 1} time in milliseconds`} className="avs-kf-at" value={k.at} min={0} max={draftTl.duration} step={10} onCommit={(n) => editKeyframe(i, { at: n })} />
                      <label className="sr-only" htmlFor={`${statusId}-kf-ex-${i}`}>
                        Keyframe {i + 1} expression
                      </label>
                      <select id={`${statusId}-kf-ex-${i}`} className="input" value={k.expressionId} onChange={(e) => editKeyframe(i, { expressionId: e.target.value })}>
                        {allExpressions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor={`${statusId}-kf-ease-${i}`}>
                        Keyframe {i + 1} easing
                      </label>
                      <select id={`${statusId}-kf-ease-${i}`} className="input avs-kf-ease" value={k.ease} title={EASE_OPTIONS.find((z) => z.id === k.ease)?.hint} onChange={(e) => editKeyframe(i, { ease: e.target.value as Ease })}>
                        {EASE_OPTIONS.map((z) => (
                          <option key={z.id} value={z.id} title={z.hint}>
                            {z.name}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" onClick={() => seekTo(k.at)} aria-label={`Show keyframe ${i + 1} on the stage`}>
                        Show
                      </Button>
                      <IconButton icon={Trash} label={`Remove keyframe ${i + 1}`} size={14} onClick={() => removeKeyframe(i)} />
                    </li>
                  ))}
                </ol>
                {tlError && (
                  <p className="field-error" role="alert">
                    {tlError}
                  </p>
                )}
                <div className="row wrap">
                  <Button size="sm" icon={Plus} onClick={addKeyframe}>
                    Keyframe at {scrub} ms
                  </Button>
                  <Button size="sm" variant="primary" icon={FloppyDisk} onClick={saveTimeline}>
                    Save timeline
                  </Button>
                  <Button size="sm" onClick={closeTimeline}>
                    Close
                  </Button>
                </div>

                {report && (
                  <div className="avs-review" aria-label="Timeline review">
                    <div className="row wrap">
                      {report.seam !== null && <Badge tone={report.seam > SEAM_WARN ? 'warn' : 'ok'}>{`Loop seam ${Math.round(report.seam * 100)}%`}</Badge>}
                      <Badge tone={report.warnings.length ? 'warn' : 'ok'}>{report.warnings.length ? `${report.warnings.length} note${report.warnings.length === 1 ? '' : 's'}` : 'No notes'}</Badge>
                    </div>
                    {report.warnings.length > 0 && (
                      <ul className="avs-import-lines">
                        {report.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {sheetSvg && (
                  <figure className="avs-sheet">
                    <img src={dataUri(sheetSvg)} alt={`Contact sheet of ${draftTl.name}: eight frames from 0 to ${draftTl.duration} ms`} />
                    <figcaption className="field-hint">Eight evenly spaced frames, drawn from the keyframes only. The same timeline always gives the same sheet.</figcaption>
                    <Button size="sm" icon={DownloadSimple} onClick={exportSheet}>
                      Export contact sheet SVG
                    </Button>
                  </figure>
                )}
              </div>
            ) : (
              <p className="field-hint">
                Open a built-in timeline (it opens as an editable copy) or create a new one. {pack.timelines.length} of {AVATAR_LIMITS.timelines} saved.
              </p>
            )}
          </Panel>

          <Panel title="Pack" eyebrow="Scope 132 · portable JSON">
            <p className="field-hint">
              Current pack: {currentSummary.expressions} expressions, {currentSummary.timelines} timelines, {currentSummary.keyframes} keyframes, {Math.ceil(currentSummary.bytes / 102.4) / 10} KB of {AVATAR_LIMITS.packBytes / 1024} KB.
            </p>
            <Field label="Pack name">
              {(id) => (
                <input
                  id={id}
                  className="input"
                  type="text"
                  maxLength={AVATAR_LIMITS.nameLength}
                  value={packName}
                  onChange={(e) => setPackName(e.target.value)}
                  onBlur={renamePack}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      renamePack();
                    }
                  }}
                />
              )}
            </Field>
            <div className="row wrap avs-history" role="group" aria-label="Edit history">
              {undo ? (
                <Button size="sm" icon={ArrowCounterClockwise} onClick={undoLast} title="Ctrl+Z">
                  Undo {undo.label}
                </Button>
              ) : (
                <Button size="sm" icon={ArrowCounterClockwise} disabled title="Nothing to undo">
                  Undo
                </Button>
              )}
              {redo ? (
                <Button size="sm" icon={ArrowClockwise} onClick={redoLast} title="Ctrl+Y">
                  Redo {redo.label}
                </Button>
              ) : (
                <Button size="sm" icon={ArrowClockwise} disabled title="Nothing to redo">
                  Redo
                </Button>
              )}
              <span className="field-hint">
                {history.past.length} step{history.past.length === 1 ? '' : 's'} back, {history.future.length} forward. History lives in this window only.
              </span>
            </div>
            <ul className="avs-exports" aria-label="Export preview">
              {exports.map((x) => (
                <li key={x.id} className={x.status === 'available' && x.fileName ? 'ok' : 'off'}>
                  <span className="avs-export-name">
                    <strong>{x.name}</strong>
                    <span className="field-hint">{x.fileName && x.bytes !== null ? `${x.fileName}, ${formatKb(x.bytes)}` : x.reason}</span>
                  </span>
                  {x.status === 'available' ? (
                    <Button size="sm" icon={DownloadSimple} onClick={exportActions[x.id]} disabled={!x.fileName}>
                      Export
                    </Button>
                  ) : (
                    <Badge tone="danger">unavailable</Badge>
                  )}
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <Button size="sm" icon={Copy} onClick={copyPack}>
                Copy JSON
              </Button>
              <Button size="sm" onClick={resetPack}>
                Reset pack
              </Button>
            </div>
            <Field label="Import pack" hint={`Paste pack JSON or choose a .json file up to ${AVATAR_LIMITS.packBytes / 1024} KB. Every value is checked and clamped; unknown fields are dropped. You review the result before anything is saved.`}>
              {(id, describedBy) => (
                <div className={cx('stack avs-drop', dropHover && 'over')} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDropHover(false)}>
                  <textarea id={id} className="input avs-import" rows={4} value={importText} aria-describedby={describedBy} spellCheck={false} onChange={(e) => setImportText(e.target.value)} placeholder='{"version":1,"name":"…","geometry":{…}}' />
                  <div className="row wrap">
                    <Button size="sm" variant="primary" icon={UploadSimple} onClick={() => stageImport(importText, 'pasted text')} disabled={!importText.trim()}>
                      Review pasted JSON
                    </Button>
                    <label className="avs-file">
                      <UploadSimple size={14} aria-hidden /> Choose file
                      <input type="file" accept=".json,application/json" multiple className="sr-only" onChange={importFile} />
                    </label>
                  </div>
                  <p className="field-hint avs-drop-hint">Drop a pack JSON file here. Images, 3D models, archives, audio and video are named and refused, never read.</p>
                </div>
              )}
            </Field>
            {pending && (
              <div className="avs-pending" role="group" aria-label="Review import">
                <Notice tone={pending.warnings.length ? 'warn' : 'info'} title={`Ready to import "${pending.pack.name}" from ${pending.source}`}>
                  {pending.pack.expressions.length} expressions, {pending.pack.timelines.length} timelines. Nothing has been saved yet.
                </Notice>
                {pending.warnings.length > 0 && (
                  <ul className="avs-import-lines">
                    {pending.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {pendingPreview && (
                  <ul className="avs-import-lines" aria-label="Import preview">
                    <li>
                      Replace: {pendingPreview.replace.removedExpressions} expressions and {pendingPreview.replace.removedTimelines} timelines removed, {pendingPreview.replace.incomingExpressions} and {pendingPreview.replace.incomingTimelines} imported.{' '}
                      {pendingPreview.replace.geometryChanges.length ? `Geometry changes: ${pendingPreview.replace.geometryChanges.join(', ')}.` : 'Geometry is identical.'}
                      {pendingPreview.replace.renames ? ` Pack name becomes "${pending.pack.name}".` : ''}
                    </li>
                    <li>
                      Add: {pendingPreview.merge.addedExpressions} expressions and {pendingPreview.merge.addedTimelines} timelines added, {pendingPreview.merge.skipped} skipped as duplicates or over the limit. Geometry and name are kept.
                    </li>
                    {pendingPreview.merge.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    <li>Either choice is one undo step.</li>
                  </ul>
                )}
                <div className="row wrap">
                  <Button size="sm" variant="primary" onClick={() => finishImport('replace')}>
                    Replace current pack
                  </Button>
                  <Button size="sm" onClick={() => finishImport('merge')}>
                    Add to current pack
                  </Button>
                  <Button size="sm" onClick={() => setPending(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {importMsg && (
              <>
                <Notice tone={importMsg.tone} title={importMsg.title} />
                <ul className="avs-import-lines">
                  {importMsg.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </>
            )}
          </Panel>

          <Panel title="Keyboard shortcuts" eyebrow="Studio" as="aside">
            <p className="field-hint">Shortcuts work while focus is on the stage, a slider or empty space. Text fields and buttons keep their own keys, and sliders keep their arrow keys.</p>
            <dl className="avs-keys">
              {STUDIO_SHORTCUTS.map((s) => (
                <div key={s.action} className="avs-key">
                  <dt>
                    <kbd>{s.keys}</kbd>
                  </dt>
                  <dd>{s.what}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
