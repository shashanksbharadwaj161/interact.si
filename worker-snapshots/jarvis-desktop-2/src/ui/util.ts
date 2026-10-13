import type { Task } from '../shared/contracts';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** Turn any thrown value (including Electron IPC wrappers) into one short readable line. */
export function errMsg(e: unknown, fallback = 'Something went wrong.'): string {
  let m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  m = m.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').replace(/\s+/g, ' ').trim();
  if (!m) m = fallback;
  return m.length > 240 ? `${m.slice(0, 237)}…` : m;
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function parseHttpUrl(value: string): URL | null {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127(\.\d{1,3}){3}$/.test(h);
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(iso: string | undefined): string {
  const d = parse(iso);
  return d ? dateFmt.format(d) : '—';
}

export function fmtDateTime(iso: string | undefined): string {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : '—';
}

export function fmtTime(iso: string | undefined): string {
  const d = parse(iso);
  return d ? timeFmt.format(d) : '';
}

export function relTime(iso: string | undefined, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return '—';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return fmtDateTime(iso);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days} d ago`;
  return fmtDate(iso);
}

export function localDateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dueKey(task: Pick<Task, 'due'>): string | null {
  const m = task.due ? /^\d{4}-\d{2}-\d{2}/.exec(task.due) : null;
  return m ? m[0] : null;
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

export function dueBucket(task: Pick<Task, 'due'>, today = localDateKey()): DueBucket {
  const k = dueKey(task);
  if (!k) return 'none';
  if (k < today) return 'overdue';
  return k === today ? 'today' : 'upcoming';
}

export function fmtDueKey(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  return Number.isNaN(d.getTime()) ? key : dateFmt.format(d);
}

export function fmtBytesGB(gb: number): string {
  return gb > 0 ? `${Math.round(gb * 10) / 10} GB` : 'unknown';
}

export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function normalizeTag(t: string): string {
  return t.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 24);
}

export function safeJson(value: unknown, max = 4000): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}\n… (truncated, ${s.length - max} more characters)` : s;
}
