import { useCallback, useEffect, useRef, useState } from 'react';
import type { GpsFix } from '@/navigation/engine';

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

function toFix(position: GeolocationPosition): GpsFix {
  const { coords } = position;
  return {
    position: [coords.longitude, coords.latitude],
    accuracyM: Number.isFinite(coords.accuracy) ? coords.accuracy : 50,
    headingDeg:
      coords.heading != null && Number.isFinite(coords.heading) ? coords.heading : null,
    speedMps: coords.speed != null && Number.isFinite(coords.speed) ? coords.speed : null,
    timestamp: position.timestamp,
  };
}

function describeError(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Standortzugriff wurde verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben.';
    case error.POSITION_UNAVAILABLE:
      return 'Kein GPS-Signal. In Tunneln und Tiefgaragen ist das normal.';
    case error.TIMEOUT:
      return 'Standortbestimmung hat zu lange gedauert.';
    default:
      return 'Standort konnte nicht bestimmt werden.';
  }
}

/**
 * Continuous position tracking for the drive.
 *
 * `watchPosition` with `enableHighAccuracy` is the only browser API that gives
 * road-level accuracy, and it is also the app's biggest battery cost — hence the
 * explicit start/stop rather than tracking from mount.
 */
export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    fix: null,
    error: null,
    staleForS: 0,
  });

  const watchIdRef = useRef<number | null>(null);
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
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setState((prev) => ({ ...prev, status: 'idle' }));
  }, []);

  const start = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setState({
        status: 'unavailable',
        fix: null,
        error: 'Dieses Gerät stellt keinen Standort bereit.',
        staleForS: 0,
      });
      return;
    }
    if (watchIdRef.current != null) return;

    setState((prev) => ({ ...prev, status: 'requesting', error: null }));

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const fix = toFix(position);
        lastFixAtRef.current = Date.now();
        setState({ status: 'tracking', fix, error: null, staleForS: 0 });
        for (const listener of listenersRef.current) listener(fix);
      },
      (error) => {
        setState((prev) => ({
          ...prev,
          // A timeout mid-drive is a temporary signal loss, not a hard failure:
          // keep tracking so the watch can recover on its own.
          status:
            error.code === error.PERMISSION_DENIED
              ? 'denied'
              : prev.status === 'tracking'
                ? 'tracking'
                : 'error',
          error: describeError(error),
        }));
      },
      {
        enableHighAccuracy: true,
        // Never serve a cached fix: at 130 km/h a 10-second-old position is
        // 360 m wrong.
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  }, []);

  /** One-shot position, used to prefill "Mein Standort" in the planner. */
  const getCurrent = useCallback(async (): Promise<GpsFix | null> => {
    if (!('geolocation' in navigator)) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(toFix(position)),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      );
    });
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
    const listeners = listenersRef.current;
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      listeners.clear();
    };
  }, []);

  return { ...state, start, stop, subscribe, getCurrent };
}
