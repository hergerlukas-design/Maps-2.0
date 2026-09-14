import { isNative } from './index';

/**
 * Bildschirm während der Fahrt anlassen.
 *
 * Im Browser gibt die Screen-Wake-Lock-Schnittstelle die Sperre automatisch
 * frei, sobald die Seite nicht mehr sichtbar ist — sie muss deshalb bei
 * jedem Sichtbarwerden neu geholt werden. Nativ hält das Fenster-Merkmal
 * `FLAG_KEEP_SCREEN_ON` durch, solange die App vorn ist; das Nachholen
 * entfällt, schadet aber auch nicht.
 */
export interface ScreenKeeper {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  readonly supported: boolean;
}

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

class BrowserKeeper implements ScreenKeeper {
  readonly supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  private sentinel: WakeLockSentinelLike | null = null;

  async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    if (this.sentinel && !this.sentinel.released) return true;
    try {
      const api = (
        navigator as unknown as {
          wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
        }
      ).wakeLock;
      this.sentinel = await api.request('screen');
      return true;
    } catch {
      // Abgelehnt (Energiesparmodus, keine Nutzergeste) — die Navigation läuft
      // weiter, der Bildschirm wird nur dunkel.
      this.sentinel = null;
      return false;
    }
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {});
  }
}

class NativeKeeper implements ScreenKeeper {
  readonly supported = true;

  async acquire(): Promise<boolean> {
    try {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await KeepAwake.keepAwake();
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    try {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await KeepAwake.allowSleep();
    } catch {
      // Nichts zu retten — der Bildschirm geht dann eben nach Zeit aus.
    }
  }
}

let keeper: ScreenKeeper | null = null;

export function screenKeeper(): ScreenKeeper {
  keeper ??= isNative ? new NativeKeeper() : new BrowserKeeper();
  return keeper;
}
