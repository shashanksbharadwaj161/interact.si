import type { ActionRequest } from '../shared/contracts';

export type ActionForm = { type: ActionRequest['type']; target: string; text: string; x: string; y: string; width: string; height: string };
export type ActionOutcome = { kind: 'ran' | 'not-run' | 'rejected' | 'unconfirmed'; value?: unknown; message?: string };
export type ListedWindow = { hwnd: string | null; title: string; process: string; width: number | null; height: number | null; x: number | null; y: number | null; protected: boolean };
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A fulfilled IPC promise does not establish that a native action ran. */
export function actionOutcome(value: unknown, approved: boolean): ActionOutcome {
  if (!approved) return { kind: 'rejected', message: 'You rejected this action. Nothing ran.' };
  if (record(value) && value.executed === true) return { kind: 'ran', value };
  if (record(value) && value.executed === false) return { kind: 'not-run', message: typeof value.reason === 'string' && value.reason.trim() ? value.reason : 'The backend refused this action.' };
  return { kind: 'unconfirmed', message: 'The backend did not confirm whether this action ran. Inspect activity before trying again.' };
}

/** Native list-windows returns an execution envelope, not an array at the top level. */
export function listedWindows(value: unknown): ListedWindow[] | null {
  if (!record(value) || value.executed !== true || !Array.isArray(value.windows)) return null;
  return value.windows.filter(record).map(w => ({
    hwnd: ((typeof w.hwnd === 'number' && Number.isSafeInteger(w.hwnd) && w.hwnd > 0) || (typeof w.hwnd === 'string' && /^[1-9]\d*$/.test(w.hwnd))) ? String(w.hwnd) : null,
    title: typeof w.title === 'string' ? w.title : '',
    process: typeof w.process === 'string' ? w.process : '',
    width: finite(w.width), height: finite(w.height), x: finite(w.x), y: finite(w.y), protected: w.protected === true,
  }));
}

function integer(v: string, low: number, high: number): number | null {
  if (!/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= low && n <= high ? n : null;
}

/** Input actions always identify a target. Full text is retained for approval. */
export function buildAction(f: ActionForm): { action?: ActionRequest; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const action: ActionRequest = { type: f.type };
  const target = f.target.trim();
  if (['launch', 'focus', 'move-window', 'type-text', 'click'].includes(f.type)) {
    if (!target) errors.target = f.type === 'launch' ? 'Enter an app name or path.' : 'Choose a window from List windows, or enter a window title, process name or hwnd:<id>.';
    if (target.length > 500) errors.target = 'The target must be 500 characters or fewer.';
    action.target = target;
  }
  if (f.type === 'open-url') {
    try { const url = new URL(target); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { errors.target = 'Enter a full http:// or https:// address.'; }
    action.target = target;
  }
  if (f.type === 'type-text') {
    if (!f.text) errors.text = 'Enter the text to type.';
    if (f.text.length > 2000) errors.text = 'Text must be 2000 characters or fewer.';
    action.text = f.text;
  }
  if (f.type === 'click' || f.type === 'move-window') {
    for (const field of ['x', 'y'] as const) {
      const n = integer(f[field], -32000, 32000);
      if (n === null) errors[field] = 'Whole number from −32000 to 32000, in pixels.';
      else action[field] = n;
    }
  }
  if (f.type === 'move-window') {
    for (const field of ['width', 'height'] as const) {
      const n = integer(f[field], 1, 20000);
      if (n === null) errors[field] = 'Whole number from 1 to 20000.';
      else action[field] = n;
    }
  }
  return Object.keys(errors).length ? { errors } : { action, errors };
}
