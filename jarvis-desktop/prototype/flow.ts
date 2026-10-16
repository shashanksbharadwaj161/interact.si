/**
 * Flow core: an original particle flow-field renderer for the companion, with an ASCII skin drawn from the same field.
 *
 * One scheduler serves every instance: a single requestAnimationFrame loop that stops when nothing is active, pauses
 * while the page is hidden, caps the frame rate (low at rest, full only while a state is active) and draws one still
 * frame under reduced motion. State input (energy, level, hue) comes from the caller; nothing here invents activity.
 */

export type FlowSkin = 'flow' | 'ascii';
export type FlowState = 'idle' | 'listening' | 'working' | 'done' | 'error';
export type FlowParams = { skin: FlowSkin; state: FlowState; level: number; hue: number; reduced: boolean };

type Particle = { x: number; y: number; px: number; py: number; life: number };
type Instance = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; size: number; dpr: number; params: () => FlowParams; parts: Particle[]; t: number; last: number; energy: number; still: boolean };

const instances = new Set<Instance>();
let raf = 0;

const GLYPHS = ' .·:-=+*#%@';

function seedParticles(n: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.92;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    out.push({ x, y, px: x, py: y, life: Math.random() });
  }
  return out;
}

/** Smooth pseudo-noise from layered sines: cheap, deterministic, no allocation. */
function field(x: number, y: number, t: number): number {
  return Math.sin(x * 2.1 + t * 0.7) * Math.cos(y * 1.7 - t * 0.5) + 0.6 * Math.sin((x + y) * 3.3 + t * 1.1) + 0.4 * Math.cos((x - y) * 4.7 - t * 0.9);
}

function targetEnergy(p: FlowParams): number {
  switch (p.state) {
    case 'listening':
      return 0.45 + 0.55 * p.level;
    case 'working':
      return 0.85;
    case 'done':
      return 0.6;
    case 'error':
      return 0.35;
    default:
      return 0.18;
  }
}

function fpsFor(p: FlowParams): number {
  if (p.reduced) return 0;
  return p.state === 'idle' ? 12 : 60;
}

function draw(inst: Instance, dt: number) {
  const p = inst.params();
  const { ctx, size, dpr } = inst;
  const px = size * dpr;
  inst.energy += (targetEnergy(p) - inst.energy) * Math.min(1, dt / 260);
  const e = inst.energy;
  inst.t += (dt / 1000) * (0.35 + e * 1.4);
  const hue = p.state === 'error' ? 38 : p.hue;
  const hue2 = p.state === 'error' ? 18 : hue + 70;
  const cx = px / 2;
  const R = px * 0.46;

  if (p.skin === 'ascii') {
    ctx.clearRect(0, 0, px, px);
    const cell = Math.max(5, Math.round(px / 22));
    ctx.font = `600 ${cell}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let gy = cell / 2; gy < px; gy += cell) {
      for (let gx = cell / 2; gx < px; gx += cell) {
        const nx = (gx - cx) / R;
        const ny = (gy - cx) / R;
        const d = Math.hypot(nx, ny);
        if (d > 1) continue;
        const v = (field(nx * 1.4, ny * 1.4, inst.t) + 2) / 4;
        const rim = 1 - d;
        const k = Math.min(1, Math.max(0, v * (0.35 + e) * (0.4 + rim * 1.2)));
        const ch = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(k * GLYPHS.length))];
        if (ch === ' ') continue;
        ctx.fillStyle = `hsla(${hue + (1 - d) * 40}, 90%, ${55 + k * 25}%, ${0.35 + k * 0.65})`;
        ctx.fillText(ch, gx, gy);
      }
    }
    return;
  }

  // Trails: fade the previous frame towards transparent, then advect particles through the field.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${0.05 + (1 - e) * 0.05})`;
  ctx.fillRect(0, 0, px, px);
  ctx.globalCompositeOperation = 'lighter';
  const speed = 0.004 + e * 0.012;
  ctx.lineWidth = Math.max(1, dpr * (size < 60 ? 1.1 : 1.4) * (0.9 + e * 0.5));
  for (const q of inst.parts) {
    const a = field(q.x * 1.6, q.y * 1.6, inst.t) * Math.PI;
    q.px = q.x;
    q.py = q.y;
    q.x += Math.cos(a) * speed;
    q.y += Math.sin(a) * speed;
    // A gentle inward pull keeps the form round without a hard wall.
    const d = Math.hypot(q.x, q.y);
    if (d > 0.8) {
      q.x -= (q.x / d) * (d - 0.8) * 0.2;
      q.y -= (q.y / d) * (d - 0.8) * 0.2;
    }
    q.life += dt / 4000;
    if (q.life > 1 || d > 0.98) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.6;
      q.x = q.px = Math.cos(ang) * r;
      q.y = q.py = Math.sin(ang) * r;
      q.life = 0;
      continue;
    }
    const mix = Math.min(1, d * 1.2);
    ctx.strokeStyle = `hsla(${hue + (hue2 - hue) * mix}, 95%, ${60 + (1 - d) * 16}%, ${0.5 + e * 0.45})`;
    ctx.beginPath();
    ctx.moveTo(cx + q.px * R, cx + q.py * R);
    ctx.lineTo(cx + q.x * R, cx + q.y * R);
    ctx.stroke();
  }
  // A soft nucleus whose size follows the energy (and, while listening, the level passed in).
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, R * (0.18 + e * 0.16));
  g.addColorStop(0, `hsla(${hue}, 100%, 88%, ${0.22 + e * 0.35})`);
  g.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  ctx.globalCompositeOperation = 'source-over';
}

function frame(now: number) {
  raf = 0;
  if (document.hidden) return;
  let anyActive = false;
  for (const inst of instances) {
    const p = inst.params();
    const fps = fpsFor(p);
    if (fps === 0) {
      if (!inst.still) {
        // Reduced motion: settle the field for a moment off-screen, then draw a single still frame.
        inst.ctx.clearRect(0, 0, inst.size * inst.dpr, inst.size * inst.dpr);
        for (let i = 0; i < 40; i++) draw(inst, 16);
        inst.still = true;
      }
      continue;
    }
    inst.still = false;
    anyActive = true;
    const dt = now - inst.last;
    if (dt < 1000 / fps - 1) continue;
    inst.last = now;
    draw(inst, Math.min(dt, 64));
  }
  if (anyActive) raf = requestAnimationFrame(frame);
}

function kick() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

/** Registers a canvas. Returns an unsubscribe function. Call `invalidate` after a params change. */
export function addFlow(canvas: HTMLCanvasElement, size: number, params: () => FlowParams): { remove: () => void; invalidate: () => void } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { remove: () => undefined, invalidate: () => undefined };
  const inst: Instance = { canvas, ctx, size, dpr, params, parts: seedParticles(Math.round(70 + size * 1.2)), t: Math.random() * 10, last: 0, energy: 0.2, still: false };
  instances.add(inst);
  kick();
  return {
    remove: () => {
      instances.delete(inst);
    },
    invalidate: () => {
      inst.still = false;
      kick();
    },
  };
}

/** For the prototype's honesty panel: how many loops are running and whether the scheduler is active. */
export function flowStats(): { instances: number; running: boolean } {
  return { instances: instances.size, running: raf !== 0 };
}
