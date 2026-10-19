import type { MicConsent } from '../ui/audio';

/**
 * Microphone consent whose authority is the main process (settings.voiceInput), not this page's storage. Turning it on
 * asks the main process, which shows a trusted Windows confirmation; the session's permission handler refuses audio
 * while it is off, whatever any page believes. `granted()` returns the last value the main process reported.
 */
export type NativeMicConsent = MicConsent & {
  /** Asks the main process to change the policy; resolves to what is in force afterwards. */
  request(on: boolean): Promise<boolean>;
  /** The main process reported a change (another window turned it on or off). */
  update(allowed: boolean): void;
};

export function nativeMicConsent(o: { initial: boolean; set: (on: boolean) => Promise<boolean> }): NativeMicConsent {
  let allowed = o.initial;
  return {
    granted: () => allowed,
    // A plain grant() is not enough to allow the microphone: only request(true) (with its confirmation) can.
    grant: () => undefined,
    revoke: () => { allowed = false; void o.set(false).catch(() => undefined); },
    async request(on) {
      if (!on) {
        allowed = false;
        await o.set(false).catch(() => undefined);
        return false;
      }
      try {
        allowed = await o.set(true);
      } catch {
        allowed = false;
      }
      return allowed;
    },
    update(next) { allowed = next; },
  };
}

export const isNativeConsent = (c: MicConsent): c is NativeMicConsent => typeof (c as Partial<NativeMicConsent>).request === 'function';
