// Selected screen bytes stay in main-process memory, one selection at a time. Expiry actively releases bytes even idle.
export class ScreenContext<T> {
  private value: {token: string; data: T; expires: number} | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private ttl = 300_000, private clock = () => Date.now(), private later = setTimeout, private stop = clearTimeout, private expired: (token: string) => void = () => {}) {}
  put(token: string, data: T): void {
    this.clear();
    this.value = {token, data, expires: this.clock() + this.ttl};
    this.timer = this.later(() => {if (this.value?.token !== token) return; this.clear(); this.expired(token);}, this.ttl);
    this.timer.unref?.();
  }
  take(token: string): T | null {
    if (!this.value || this.value.token !== token) return null;
    const found = this.value;
    this.clear();
    return found.expires > this.clock() ? found.data : null;
  }
  discard(token: string): boolean {
    if (this.value?.token !== token) return false;
    this.clear(); return true;
  }
  clear(): void { if (this.timer) this.stop(this.timer); this.timer = null; this.value = null; }
  get size(): number { return this.value ? 1 : 0; }
}

/** A late screenshot must not resurrect a cancelled picker, or race a second capture. */
export class SelectionGate {
  private generation = 0;
  private active: number | null = null;
  begin(): number | null { if (this.active !== null) return null; this.active = ++this.generation; return this.active; }
  current(ticket: number): boolean { return this.active === ticket && this.generation === ticket; }
  finish(ticket: number): void { if (this.active === ticket) this.active = null; }
  cancel(): void { this.generation++; this.active = null; }
}
