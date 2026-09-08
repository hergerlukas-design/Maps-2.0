import { useCallback, useEffect, useRef, useState } from 'react';

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

/**
 * Keeps the screen on while navigating.
 *
 * The Screen Wake Lock API is released automatically whenever the page is
 * hidden, so it has to be re-acquired on `visibilitychange` — otherwise the
 * screen starts sleeping again after the first time the driver switches apps.
 */
export function useWakeLock(enabled: boolean) {
  const [active, setActive] = useState(false);
  const [supported] = useState(() => 'wakeLock' in navigator);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (sentinelRef.current && !sentinelRef.current.released) return;
    try {
      const wakeLock = (
        navigator as unknown as {
          wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
        }
      ).wakeLock;
      const sentinel = await wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setActive(true);
      sentinel.addEventListener('release', () => setActive(false));
    } catch {
      // Denied (battery saver, unsupported, not a user gesture) — navigation
      // still works, the screen just dims.
      setActive(false);
    }
  }, []);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setActive(false);
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) {
      void release();
      return;
    }
    void acquire();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void release();
    };
  }, [enabled, acquire, release]);

  return { active, supported };
}
