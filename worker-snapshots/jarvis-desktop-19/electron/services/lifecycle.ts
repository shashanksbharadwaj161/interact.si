// Crash recovery marker. A `.running` file exists while the app runs and is removed on clean quit.
// Two consecutive unclean starts enter safe launch (no actions, no tray hotkey/auto features).
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';

export interface LaunchFs {
  read(p: string): Promise<string | null>;
  write(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

export const nodeLaunchFs: LaunchFs = {
  read: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  write: async (p, d) => { await fsp.mkdir(path.dirname(p), {recursive: true}); await fsp.writeFile(p, d, 'utf8'); },
  remove: async (p) => { await fsp.rm(p, {force: true}); },
  exists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
};

export class LaunchGuard {
  private running: string;
  private counter: string;
  safe = false;
  uncleanStarts = 0;

  constructor(dir: string, private fs: LaunchFs = nodeLaunchFs) {
    this.running = path.join(dir, '.running');
    this.counter = path.join(dir, '.unclean');
  }

  async begin(): Promise<{safe: boolean; uncleanStarts: number}> {
    const prev = Number((await this.fs.read(this.counter)) ?? '0') || 0;
    const wasRunning = await this.fs.exists(this.running);
    this.uncleanStarts = wasRunning ? prev + 1 : 0;
    this.safe = this.uncleanStarts >= 2;
    await this.fs.write(this.counter, String(this.uncleanStarts));
    await this.fs.write(this.running, String(Date.now()));
    return {safe: this.safe, uncleanStarts: this.uncleanStarts};
  }

  /** Called on clean quit and when the user chooses to open normally. */
  async end(): Promise<void> {
    // Counter first: an interruption between the two steps still leaves the marker, i.e. one unclean start, not two.
    await this.fs.write(this.counter, '0');
    await this.fs.remove(this.running);
  }
}
