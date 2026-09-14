import { useCallback, useEffect, useRef, useState } from 'react';
import type { GpsFix } from '@/navigation/engine';
import { locationTracker, type LocationError } from '@/platform/location';

export type GeolocationStatus =
  | 'idle'
  | 'requesting'
  | 'tracking'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface GeolocationState {
  status: GeolocationStatus;
  fix: GpsFix | null;
  /** German-language description of the last error, if any. */
  error: string | null;
  /** Seconds since the last fix; grows when the signal is lost. */
  staleForS: number;
}

/**
 * Continuous position tracking for the drive.
 *
 * Woher die Ortungen kommen, entscheidet `@/platform/location`: im Browser
 * `watchPosition`, in der Android-App ein Vordergrunddienst, der auch bei
 * ausgeschaltetem Bildschirm weiterläuft. Der Unterschied ist hier bewusst
 * nicht sichtbar — bis auf `runsInBackground`, das die Oberfläche braucht,
 * um im Browser vor genau dieser Einschränkung zu warnen.
 */
export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    fix: null,
    error: null,
    staleForS: 0,
  });

  const trackerRef = useRef(locationTracker());
  const runningRef = useRef(false);
  const lastFixAtRef = useRef<number | null>(null);
  /** Subscribers that want every fix, not just re-renders. */
  const listenersRef = useRef(new Set<(fix: GpsFix) => void>());

  /**
   * Subscribes to raw fixes. The navigation engine needs every update, but
   * re-rendering the whole tree at 1 Hz would be wasteful, so consumers that
   * only drive imperative code (the map camera, the engine) subscribe here.
   */
  const subscribe = useCallback((listener: (fix: GpsFix) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const stop = useCallback(() => {
    runningRef.current = false;
    void trackerRef.current.stop();
    setState((prev) => ({ ...prev, status: 'idle' }));
  }, []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState((prev) => ({ ...prev, status: 'requesting', error: null }));

    void trackerRef.current.start(
      (fix) => {
        lastFixAtRef.current = Date.now();
        setState({ status: 'tracking', fix, error: null, staleForS: 0 });
        for (const listener of listenersRef.current) listener(fix);
      },
      (error: LocationError) => {
        setState((prev) => ({
          ...prev,
          // A timeout mid-drive is a temporary signal loss, not a hard failure:
          // keep tracking so the watch can recover on its own.
          status:
            error.kind === 'denied'
              ? 'denied'
              : error.kind === 'unavailable' && prev.status !== 'tracking'
                ? 'unavailable'
                : prev.status === 'tracking'
                  ? 'tracking'
                  : 'error',
          error: error.message,
        }));
      },
    );
  }, []);

  /** One-shot position, used to prefill "Mein Standort" in the planner. */
  const getCurrent = useCallback(async (): Promise<GpsFix | null> => {
    return trackerRef.current.getCurrent();
  }, []);

  // Surface signal loss so the UI can say "kein GPS" instead of freezing.
  useEffect(() => {
    if (state.status !== 'tracking') return;
    const timer = setInterval(() => {
      const last = lastFixAtRef.current;
      if (last == null) return;
      setState((prev) => ({ ...prev, staleForS: Math.round((Date.now() - last) / 1000) }));
    }, 2000);
    return () => clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    const tracker = trackerRef.current;
    const listeners = listenersRef.current;
    return () => {
      void tracker.stop();
      listeners.clear();
    };
  }, []);

  return {
    ...state,
    start,
    stop,
    subscribe,
    getCurrent,
    /** Läuft die Ortung weiter, wenn die App nicht im Vordergrund ist? */
    runsInBackground: trackerRef.current.runsInBackground,
  };
}
