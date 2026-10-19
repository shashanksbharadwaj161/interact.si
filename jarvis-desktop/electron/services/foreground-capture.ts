/** A cold Windows helper can take seconds. A late result must never reattach an app after close/lock. */
export class ForegroundCapture<T> {
  private revision = 0;
  private pending = false;
  constructor(private readonly waitMs = 6000) {}
  get busy(): boolean { return this.pending; }

  cancel(): void { this.revision++; this.pending = false; }

  async capture(read: () => Promise<T | null>): Promise<{target: T | null} | null> {
    if (this.pending) return null;
    this.pending = true;
    const revision = ++this.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), this.waitMs);});
      const target = await Promise.race([Promise.resolve().then(read).catch(() => null), timeout]);
      return revision === this.revision ? {target} : null;
    } finally {
      clearTimeout(timer);
      if (revision === this.revision) this.pending = false;
    }
  }
}
