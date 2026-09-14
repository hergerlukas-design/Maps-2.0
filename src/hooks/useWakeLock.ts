import { useCallback, useEffect, useState } from 'react';
import { screenKeeper } from '@/platform/keepAwake';

/**
 * Keeps the screen on while navigating.
 *
 * Im Browser gibt die Screen-Wake-Lock-Schnittstelle die Sperre frei, sobald
 * die Seite verdeckt wird — sie muss deshalb bei `visibilitychange` neu geholt
 * werden, sonst schläft der Bildschirm nach dem ersten App-Wechsel wieder ein.
 * Nativ ist das nicht nötig, schadet aber nicht; die Fallunterscheidung steckt
 * in `@/platform/keepAwake`.
 */
export function useWakeLock(enabled: boolean) {
  const [active, setActive] = useState(false);
  const [keeper] = useState(() => screenKeeper());

  const acquire = useCallback(async () => {
    setActive(await keeper.acquire());
  }, [keeper]);

  const release = useCallback(async () => {
    setActive(false);
    await keeper.release();
  }, [keeper]);

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

  return { active, supported: keeper.supported };
}
