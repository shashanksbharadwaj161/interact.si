// Capsule restore: open configured items (each re-authorized), then restore supported window geometry.
// Anything unsupported, unapproved or missing is reported in failed[], never faked.
import type {AppState, Capsule} from '../../src/shared/contracts';
import type {NativeAdapter, WindowInfo} from '../native/adapter';
import type {ActionService} from './actions';
import {checkWindowPolicy} from './policy';

export interface CapsuleDeps {
  state: () => AppState;
  actions: Pick<ActionService, 'openItem'>;
  native: Pick<NativeAdapter, 'listWindows' | 'moveWindow'>;
  selfPids: () => number[];
  activity: (kind: string, summary: string, details?: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  windowWaitMs?: number;
}

export interface RestoreResult { opened: string[]; failed: {target: string; reason: string}[] }

function pickWindow(saved: NonNullable<Capsule['windows']>[number], windows: WindowInfo[], used: Set<number>): WindowInfo | undefined {
  const proc = saved.process.toLowerCase();
  const sameProc = windows.filter((w) => !used.has(w.hwnd) && w.process.toLowerCase() === proc);
  if (saved.title) {
    const t = saved.title.toLowerCase();
    const byTitle = sameProc.find((w) => w.title.toLowerCase().includes(t));
    if (byTitle) return byTitle;
  }
  return sameProc[0];
}

export async function restoreCapsule(deps: CapsuleDeps, id: unknown): Promise<RestoreResult> {
  if (typeof id !== 'string' || id.length > 64) throw new Error('Capsule id is invalid');
  const capsule = deps.state().capsules.find((c) => c.id === id);
  if (!capsule) throw new Error('Capsule not found');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const result: RestoreResult = {opened: [], failed: []};

  for (const item of capsule.items) {
    const r = await deps.actions.openItem(item.kind, item.target);
    if (r.ok) result.opened.push(item.target);
    else result.failed.push({target: item.target, reason: r.reason});
  }

  const pending = [...(capsule.windows ?? [])];
  const used = new Set<number>();
  if (pending.length) {
    const waitMs = result.opened.length ? deps.windowWaitMs ?? 10_000 : 0;
    const deadline = now() + waitMs;
    let lastError = '';
    for (;;) {
      let windows: WindowInfo[] = [];
      try { windows = await deps.native.listWindows(); lastError = ''; } catch (e) { lastError = (e as Error).message; }
      for (let i = pending.length - 1; i >= 0; i--) {
        const saved = pending[i];
        const win = pickWindow(saved, windows, used);
        if (!win) continue;
        pending.splice(i, 1);
        used.add(win.hwnd);
        const name = `${saved.process}${saved.title ? ` "${saved.title}"` : ''}`;
        const why = checkWindowPolicy(win, 'move-window', deps.selfPids());
        if (why) { result.failed.push({target: `window ${name}`, reason: why}); continue; }
        try {
          await deps.native.moveWindow({hwnd: win.hwnd, pid: win.pid}, {x: saved.x, y: saved.y, width: saved.width, height: saved.height});
          result.opened.push(`window ${name}`);
        } catch (e) {
          result.failed.push({target: `window ${name}`, reason: (e as Error).message.slice(0, 200)});
        }
      }
      if (!pending.length || now() >= deadline) break;
      await sleep(500);
    }
    for (const saved of pending) {
      result.failed.push({target: `window ${saved.process}${saved.title ? ` "${saved.title}"` : ''}`, reason: lastError ? `Windows could not be enumerated: ${lastError}` : 'No matching window appeared in time'});
    }
  }

  await deps.activity('capsule', `Restored capsule "${capsule.name.slice(0, 80)}": ${result.opened.length} opened, ${result.failed.length} failed`);
  return result;
}
