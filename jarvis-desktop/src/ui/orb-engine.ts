/**
 * The one companion renderer. Every placement (shell, Today, Assistant, Studio preview, onboarding) registers its own
 * visible <canvas> here; a single hidden WebGL context draws each placement in turn and copies the pixels into that
 * placement's canvas. So the large Studio preview and the 32px shell mark are the same implementation.
 *
 * Budget rules: device-pixel ratio is capped, small idle placements run at 30 fps, still motion and reduced motion draw
 * one frame per change with no loop, nothing draws while the window is hidden or a placement is off screen, and the
 * loop stops entirely when no placement needs another frame. React never re-renders per frame.
 *
 * Fallbacks: if WebGL is unavailable or the context is lost, a Canvas 2D painter draws a simpler orb until the context
 * is restored. "Classic character" draws the saved avatar pack with the existing pack painter.
 */
import { ORB_FRAGMENT, ORB_VERTEX } from './orb-shader';
import { easeTargets, hueToRgb, placementDpr, placementFps, stateTargets, type CompanionAppearance, type StateTargets } from './appearance';
import { AVATAR_PREF_KEY, BUILT_IN_EXPRESSIONS, NEUTRAL_EXPRESSION, applyIdle, applyVoiceLevel, drawAvatar, findExpression, idleLayer, packFromStorage, type AvatarPack, type Expression } from './avatar-editor';
import { readPref } from './prefs';

export type OrbParams = {
  appearance: CompanionAppearance;
  /** Real companion state id (idle, listening, transcribing, thinking, speaking, alert). */
  state: string;
  /** Measured microphone level 0..1, or null when no audio source is attached. */
  level: number | null;
  reducedMotion: boolean;
  seed: number;
};

export type OrbPlacement = {
  canvas: HTMLCanvasElement;
  cssSize: number;
  visible: boolean;
  params: () => OrbParams;
};

type Live = OrbPlacement & { cur: StateTargets; lastDraw: number; lastTick: number; dirty: boolean; ctx: CanvasRenderingContext2D | null };

export type OrbBackend = 'webgl' | 'canvas2d' | 'none';
export type OrbQuality = 'full' | 'reduced';
export type OrbStats = { backend: OrbBackend; placements: number; visible: number; running: boolean; frames: number; lastFrameMs: number; contextLosses: number; quality: OrbQuality; qualityReason: string | null; renderer: string | null };

/** Software WebGL (no GPU acceleration) is far slower; the governor starts in reduced quality there. */
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;
/** Average frame interval (ms) over the window below that switches to reduced quality. */
const SLOW_FRAME_MS = 42;
const FRAME_WINDOW = 40;

const FORM_INDEX: Record<string, number> = { core: 0, lattice: 1, ribbon: 2, frost: 3 };
/** Placements this large or larger also draw the particle ring and waveform line. */
export const RING_MIN_SIZE = 96;

type GLState = {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
};

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Companion shader did not compile; using the 2D renderer.', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

const UNIFORMS = ['uRes', 'uTime', 'uForm', 'uTint', 'uTint2', 'uRing', 'uRingOn', 'uEnergy', 'uSwirl', 'uSweep', 'uPulse', 'uAlert', 'uLevel', 'uDark', 'uSeed'];

class OrbEngine {
  private placements = new Set<Live>();
  private glState: GLState | null = null;
  private glFailed = false;
  private raf = 0;
  private frames = 0;
  private lastFrameMs = 0;
  private contextLosses = 0;
  private packCache: { at: number; pack: AvatarPack } | null = null;
  private quality: OrbQuality = 'full';
  private qualityReason: string | null = null;
  private renderer: string | null = null;
  private intervals: number[] = [];
  private lastNow = 0;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.invalidateAll();
    });
    // Theme or motion changes on <html> change how the orb is lit and whether it animates.
    if (typeof MutationObserver === 'function') new MutationObserver(() => this.invalidateAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    // A saved character pack changed in another window or in Studio: redraw character placements.
    window.addEventListener('storage', () => {
      this.packCache = null;
      this.invalidateAll();
    });
  }

  add(p: OrbPlacement): () => void {
    const live: Live = Object.assign(p, { cur: stateTargets(p.params().state), lastDraw: 0, lastTick: 0, dirty: true, ctx: null }) as Live;
    this.placements.add(live);
    this.kick();
    return () => {
      this.placements.delete(live);
      if (this.placements.size === 0) this.stop();
    };
  }

  /** A placement's inputs changed (state, appearance, size, theme): draw it on the next frame. */
  invalidate(p: OrbPlacement) {
    const live = p as Live;
    live.dirty = true;
    this.kick();
  }

  invalidateAll() {
    for (const p of this.placements) p.dirty = true;
    this.kick();
  }

  forgetPack() {
    this.packCache = null;
    this.invalidateAll();
  }

  stats(): OrbStats {
    let visible = 0;
    for (const p of this.placements) if (p.visible) visible++;
    return { backend: this.backend(), placements: this.placements.size, visible, running: this.raf !== 0, frames: this.frames, lastFrameMs: this.lastFrameMs, contextLosses: this.contextLosses, quality: this.quality, qualityReason: this.qualityReason, renderer: this.renderer };
  }

  private backend(): OrbBackend {
    if (this.placements.size === 0) return 'none';
    return this.glState ? 'webgl' : 'canvas2d';
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastNow = 0;
  }

  private kick() {
    if (this.raf || document.hidden || typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private ensureGL(): GLState | null {
    if (this.glState) return this.glState;
    if (this.glFailed) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true, powerPreference: 'low-power' }) as WebGLRenderingContext | null;
    if (!gl) {
      this.glFailed = true;
      return null;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, ORB_VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, ORB_FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      this.glFailed = true;
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.glFailed = true;
      return null;
    }
    gl.useProgram(program);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 120) : null;
    if (this.renderer && SOFTWARE_GL.test(this.renderer)) this.reduceQuality('Software WebGL renderer');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u: GLState['u'] = {};
    for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLosses++;
      this.glState = null;
      this.invalidateAll();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.glFailed = false;
      this.glState = null;
      this.invalidateAll();
    });
    this.glState = { gl, canvas, program, u };
    return this.glState;
  }

  private pack(): AvatarPack {
    const now = Date.now();
    if (!this.packCache || now - this.packCache.at > 2000) this.packCache = { at: now, pack: packFromStorage(readPref<unknown>(AVATAR_PREF_KEY, null)) };
    return this.packCache.pack;
  }

  /** Lower frame rate and internal resolution. One way only: quality returns to full on the next launch. */
  private reduceQuality(reason: string) {
    if (this.quality === 'reduced') return;
    this.quality = 'reduced';
    this.qualityReason = reason;
    this.invalidateAll();
  }

  private frame = (now: number) => {
    this.raf = 0;
    // Governor: frames that keep arriving late mean the GPU (or software GL) cannot keep up.
    if (this.lastNow && now - this.lastNow < 1000) {
      this.intervals.push(now - this.lastNow);
      if (this.intervals.length > FRAME_WINDOW) this.intervals.shift();
      if (this.quality === 'full' && this.intervals.length === FRAME_WINDOW && this.intervals.reduce((a, b) => a + b, 0) / FRAME_WINDOW > SLOW_FRAME_MS) this.reduceQuality('Frames were arriving slowly');
    }
    this.lastNow = now;
    const t0 = performance.now();
    let again = false;
    const dark = document.documentElement.dataset.theme === 'dark';
    for (const p of this.placements) {
      if (!p.visible || !p.canvas.isConnected) continue;
      const prm = p.params();
      const lowPower = document.documentElement.dataset.motion === 'reduced';
      const fps = placementFps({ motion: prm.appearance.motion, reducedMotion: prm.reducedMotion || lowPower, state: prm.state, cssSize: p.cssSize, lowPower: this.quality === 'reduced' });
      const dt = p.lastTick ? now - p.lastTick : 0;
      p.lastTick = now;
      const target = stateTargets(prm.state);
      p.cur = fps === 0 ? target : easeTargets(p.cur, target, dt);
      const due = p.dirty || (fps > 0 && now - p.lastDraw >= 1000 / fps - 4);
      if (due) {
        this.draw(p, prm, now, dark, fps === 0);
        p.lastDraw = now;
        p.dirty = false;
      }
      if (fps > 0) again = true;
    }
    this.frames++;
    this.lastFrameMs = performance.now() - t0;
    if (again) this.kick();
  };

  private ensureCanvas(p: Live): { w: number; h: number; dpr: number; ctx: CanvasRenderingContext2D | null } {
    const dpr = placementDpr(window.devicePixelRatio, p.cssSize) * (this.quality === 'reduced' && p.cssSize > 100 ? 0.7 : 1);
    const px = Math.max(8, Math.round(p.cssSize * dpr));
    if (p.canvas.width !== px || p.canvas.height !== px) {
      p.canvas.width = px;
      p.canvas.height = px;
    }
    if (!p.ctx) p.ctx = p.canvas.getContext('2d');
    return { w: px, h: px, dpr, ctx: p.ctx };
  }

  private draw(p: Live, prm: OrbParams, now: number, dark: boolean, still: boolean) {
    const { w, h, dpr, ctx } = this.ensureCanvas(p);
    if (!ctx) return;
    const scale = prm.appearance.motion === 'calm' ? 0.55 : 1;
    // A still frame uses a fixed, pleasing moment instead of the clock, so it never looks caught mid-flicker.
    const time = still ? 7.3 + prm.seed * 0.01 : (now / 1000) * scale + prm.seed;
    const level = prm.level === null ? 0 : Math.max(0, Math.min(1, prm.level));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (prm.appearance.form === 'character') {
      this.drawCharacter(ctx, w, h, dpr, prm, time, level, still);
      return;
    }
    const g = this.ensureGL();
    if (g) {
      const { gl, canvas, u } = g;
      if (canvas.width < w || canvas.height < h) {
        canvas.width = Math.max(canvas.width, w);
        canvas.height = Math.max(canvas.height, h);
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const form = prm.appearance.form;
      const [r, gg, b] = hueToRgb(prm.appearance.tint, form === 'frost' ? 0.6 : 0.95, form === 'frost' ? 0.56 : 0.62);
      // Ultraviolet depth sits about 65 degrees from the energy hue; ribbons spread a little wider.
      const [r2, g2, b2] = hueToRgb(prm.appearance.tint + (form === 'ribbon' ? 80 : 65), 0.85, 0.66);
      gl.uniform3f(u.uTint, r, gg, b);
      gl.uniform3f(u.uTint2, r2, g2, b2);
      gl.uniform1f(u.uRing, p.cur.ring);
      gl.uniform1f(u.uRingOn, p.cssSize >= RING_MIN_SIZE ? 1 : 0);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uForm, FORM_INDEX[prm.appearance.form] ?? 0);
      gl.uniform1f(u.uEnergy, p.cur.energy);
      gl.uniform1f(u.uSwirl, p.cur.swirl);
      gl.uniform1f(u.uSweep, p.cur.sweep);
      gl.uniform1f(u.uPulse, p.cur.pulse);
      gl.uniform1f(u.uAlert, p.cur.alert);
      gl.uniform1f(u.uLevel, level);
      gl.uniform1f(u.uDark, dark ? 1 : 0);
      gl.uniform1f(u.uSeed, prm.seed % 17);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.drawImage(canvas, 0, canvas.height - h, w, h, 0, 0, w, h);
      return;
    }
    paintFallbackOrb(ctx, w, h, prm.appearance, p.cur, time, level, dark);
  }

  private drawCharacter(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, prm: OrbParams, time: number, level: number, still: boolean) {
    const pack = this.pack();
    const pick = (id: string): Expression => findExpression(id, pack.expressions)?.expression ?? BUILT_IN_EXPRESSIONS.find((e) => e.id === id)?.expression ?? NEUTRAL_EXPRESSION;
    const byState: Record<string, string> = { idle: 'builtin:neutral', listening: 'builtin:listening', transcribing: 'builtin:thinking', thinking: 'builtin:thinking', speaking: 'builtin:speaking', alert: 'builtin:alert' };
    let e = pick(byState[prm.state] ?? 'builtin:neutral');
    if (prm.level !== null) e = applyVoiceLevel(e, level);
    if (!still) e = applyIdle(e, idleLayer(time * 1000, prm.seed));
    const css = w / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAvatar(ctx, css, css, pack.geometry, e, typeof Path2D === 'function' ? Path2D : undefined);
  }
}

/** Simpler orb drawn with Canvas 2D gradients, used when WebGL is unavailable or its context was lost. */
export function paintFallbackOrb(ctx: CanvasRenderingContext2D, w: number, h: number, a: CompanionAppearance, cur: StateTargets, time: number, level: number, dark: boolean) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.4 * (1 + 0.011 * Math.sin(time * 1.05) + 0.03 * level);
  const hue = cur.alert > 0.5 ? 30 : a.tint;
  if (!dark) {
    const sh = ctx.createRadialGradient(cx, cy + R * 0.98, 0, cx, cy + R * 0.98, R * 0.8);
    sh.addColorStop(0, 'rgba(0,0,0,0.16)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(0, cy + R * 0.98);
    ctx.scale(1, 0.2);
    ctx.translate(0, -(cy + R * 0.98));
    ctx.fillStyle = sh;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  const base = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  if (a.form === 'core' || a.form === 'lattice') {
    base.addColorStop(0, `hsl(${hue} 30% 18%)`);
    base.addColorStop(1, `hsl(${hue + 60} 30% 5%)`);
  } else if (a.form === 'ribbon') {
    base.addColorStop(0, dark ? `hsl(${hue} 15% 22%)` : '#f4f5f8');
    base.addColorStop(1, dark ? `hsl(${hue} 15% 8%)` : '#c9ccd4');
  } else {
    base.addColorStop(0, '#fbfaf7');
    base.addColorStop(0.7, '#e3e2dd');
    base.addColorStop(1, '#bdbcb6');
  }
  ctx.fillStyle = base;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  const ox = Math.sin(time * (0.3 + cur.swirl)) * R * 0.12;
  const oy = Math.cos(time * (0.25 + cur.swirl)) * R * 0.1;
  const core = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * (0.55 + 0.25 * cur.energy + 0.2 * level));
  core.addColorStop(0, `hsla(${hue} 75% 70% / ${0.35 + 0.5 * cur.energy})`);
  core.addColorStop(1, `hsla(${hue} 75% 60% / 0)`);
  ctx.fillStyle = core;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  if (a.form === 'ribbon') {
    ctx.lineWidth = Math.max(1, R * 0.05);
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = `hsla(${hue + k * 18} 80% 72% / 0.75)`;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const x = cx - R + (i / 40) * R * 2;
        const y = cy + Math.sin(i / 6 + time * (0.6 + cur.swirl) + k * 2.1) * R * 0.18 + (k - 1) * R * 0.22;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  const spec = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.45, 0, cx - R * 0.38, cy - R * 0.45, R * 0.32);
  spec.addColorStop(0, 'rgba(255,255,255,0.9)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  const rim = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(1, dark ? `hsla(${hue} 70% 75% / 0.55)` : 'rgba(40,42,38,0.22)');
  ctx.fillStyle = rim;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
}

let engine: OrbEngine | null = null;

/** The shared renderer, created on first use in a browser window. Null outside a DOM (server rendering, tests). */
export function orbEngine(): OrbEngine | null {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  if (!engine) engine = new OrbEngine();
  return engine;
}

export function orbStats(): OrbStats {
  return engine ? engine.stats() : { backend: 'none', placements: 0, visible: 0, running: false, frames: 0, lastFrameMs: 0, contextLosses: 0, quality: 'full', qualityReason: null, renderer: null };
}
