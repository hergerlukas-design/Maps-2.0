import { useCallback, useEffect, useRef, useState } from 'react';

/** Wie oft im Hintergrund nach einer neuen Fassung gesehen wird. */
const CHECK_INTERVAL_MS = 30 * 60_000;

export interface AppUpdateState {
  /** Eine neue Fassung ist geladen und wartet auf die Übernahme. */
  updateReady: boolean;
  /** Übernimmt die neue Fassung und lädt die Seite neu. */
  applyUpdate: () => void;
  /** Blendet den Hinweis aus, ohne zu aktualisieren. */
  dismiss: () => void;
}

/**
 * Erkennt eine bereitstehende neue Fassung der App.
 *
 * Ohne das bleibt eine neue Fassung im Zustand „waiting" stehen: Der alte
 * Service Worker bedient die Seite weiter, und erst ein geleerter Cache bringt
 * die Aktualisierung. Genau das war der Fall.
 *
 * Die Übernahme erfolgt bewusst nicht von selbst — ein Neuladen während der
 * Navigation würde die laufende Fahrt verwerfen. Der Aufrufer entscheidet also,
 * wann gefragt wird.
 */
export function useAppUpdate(): AppUpdateState {
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const waitingRef = useRef<ServiceWorker | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;

    let cancelled = false;

    const markWaiting = (worker: ServiceWorker | null) => {
      if (!worker || cancelled) return;
      waitingRef.current = worker;
      setUpdateReady(true);
      setDismissed(false);
    };

    const watch = (registration: ServiceWorkerRegistration) => {
      registrationRef.current = registration;

      // Beim Laden kann bereits eine Fassung warten — etwa weil beim letzten
      // Besuch niemand auf den Hinweis reagiert hat.
      if (registration.waiting && navigator.serviceWorker.controller) {
        markWaiting(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `controller` unterscheidet Aktualisierung von Erstinstallation:
          // Beim ersten Besuch gibt es nichts zu melden.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            markWaiting(installing);
          }
        });
      });
    };

    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (cancelled) return;
        watch(registration);
      })
      .catch((error: unknown) => {
        console.warn('[pwa] Service Worker konnte nicht registriert werden:', error);
      });

    // Regelmäßig und beim Zurückkehren nachsehen: Ein Gerät, das tagelang im
    // Hintergrund liegt, bekäme sonst nie mit, dass es etwas Neues gibt.
    const check = () => void registrationRef.current?.update().catch(() => {});
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waiting = waitingRef.current;
    if (!waiting) {
      window.location.reload();
      return;
    }
    // Sobald der neue Worker übernimmt, wird einmal neu geladen. `once`
    // verhindert eine Schleife, falls der Wechsel mehrfach gemeldet wird.
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => window.location.reload(),
      { once: true },
    );
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  return { updateReady: updateReady && !dismissed, applyUpdate, dismiss };
}
