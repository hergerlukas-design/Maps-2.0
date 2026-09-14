import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';

import type { GpsFix } from '@/navigation/engine';
import { isNative } from './index';

/*
 * Das Plugin liefert nur native Quelltexte und Typen, kein JavaScript-Modul —
 * die Brücke wird deshalb von Hand angemeldet. Im Browser gibt `registerPlugin`
 * einen Platzhalter zurück, dessen Aufrufe scheitern; angefasst wird er dort
 * ohnehin nie, weil `isNative` die Auswahl trifft.
 */
const BackgroundGeolocation =
  registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export type LocationErrorKind = 'denied' | 'unavailable' | 'timeout' | 'error';

export interface LocationError {
  kind: LocationErrorKind;
  /** Deutschsprachiger Text für die Oberfläche. */
  message: string;
}

export interface LocationTracker {
  start(onFix: (fix: GpsFix) => void, onError: (error: LocationError) => void): Promise<void>;
  stop(): Promise<void>;
  /** Einzelabfrage für „Mein Standort" in der Planung. */
  getCurrent(): Promise<GpsFix | null>;
  /**
   * Läuft die Ortung weiter, wenn der Bildschirm aus ist oder eine andere App
   * im Vordergrund steht? Im Browser nicht — die Oberfläche weist darauf hin.
   */
  readonly runsInBackground: boolean;
}

/* ------------------------------------------------------------------ *
 * Browser
 * ------------------------------------------------------------------ */

function fromBrowser(position: GeolocationPosition): GpsFix {
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

function describeBrowserError(error: GeolocationPositionError): LocationError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        kind: 'denied',
        message:
          'Standortzugriff wurde verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben.',
      };
    case error.POSITION_UNAVAILABLE:
      return {
        kind: 'unavailable',
        message: 'Kein GPS-Signal. In Tunneln und Tiefgaragen ist das normal.',
      };
    case error.TIMEOUT:
      return { kind: 'timeout', message: 'Standortbestimmung hat zu lange gedauert.' };
    default:
      return { kind: 'error', message: 'Standort konnte nicht bestimmt werden.' };
  }
}

class BrowserTracker implements LocationTracker {
  readonly runsInBackground = false;
  private watchId: number | null = null;

  async start(
    onFix: (fix: GpsFix) => void,
    onError: (error: LocationError) => void,
  ): Promise<void> {
    if (!('geolocation' in navigator)) {
      onError({ kind: 'unavailable', message: 'Dieses Gerät stellt keinen Standort bereit.' });
      return;
    }
    if (this.watchId != null) return;

    this.watchId = navigator.geolocation.watchPosition(
      (position) => onFix(fromBrowser(position)),
      (error) => onError(describeBrowserError(error)),
      {
        enableHighAccuracy: true,
        // Never serve a cached fix: at 130 km/h a 10-second-old position is
        // 360 m wrong.
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  }

  async stop(): Promise<void> {
    if (this.watchId == null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  async getCurrent(): Promise<GpsFix | null> {
    if (!('geolocation' in navigator)) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(fromBrowser(position)),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      );
    });
  }
}

/* ------------------------------------------------------------------ *
 * Android
 * ------------------------------------------------------------------ */

/**
 * Die native Ortung läuft als Vordergrunddienst weiter.
 *
 * Das ist der eigentliche Grund für die native Hülle: Android friert eine App
 * ohne einen solchen Dienst ein, sobald der Bildschirm ausgeht oder eine
 * andere App nach vorn kommt. Im Browser endet die Navigation dann; hier läuft
 * sie weiter, sichtbar an einer dauerhaften Benachrichtigung.
 */
class NativeTracker implements LocationTracker {
  readonly runsInBackground = true;
  private watcherId: string | null = null;
  private lastFix: GpsFix | null = null;

  private toFix(location: {
    latitude: number;
    longitude: number;
    accuracy: number;
    bearing: number | null;
    speed: number | null;
    time: number | null;
  }): GpsFix {
    return {
      position: [location.longitude, location.latitude],
      accuracyM: Number.isFinite(location.accuracy) ? location.accuracy : 50,
      headingDeg:
        location.bearing != null && Number.isFinite(location.bearing) ? location.bearing : null,
      speedMps:
        location.speed != null && Number.isFinite(location.speed) ? location.speed : null,
      // `time` ist laut Schnittstelle optional; ohne Zeitstempel wäre die
      // Tempoableitung in der Engine wertlos, also die eigene Uhr nehmen.
      timestamp: location.time ?? Date.now(),
    };
  }

  async start(
    onFix: (fix: GpsFix) => void,
    onError: (error: LocationError) => void,
  ): Promise<void> {
    if (this.watcherId != null) return;
    this.watcherId = await BackgroundGeolocation.addWatcher(
      {
        // Sobald diese Nachricht gesetzt ist, läuft die Ortung auch im
        // Hintergrund — Android verlangt dafür die sichtbare Benachrichtigung.
        backgroundTitle: 'Navigation läuft',
        backgroundMessage: 'Reichweite verfolgt die Route weiter.',
        requestPermissions: true,
        // Veraltete Ortungen sind für die Navigation wertlos: Bei Tempo 130
        // liegt eine zehn Sekunden alte Position 360 m daneben.
        stale: false,
        distanceFilter: 0,
      },
      (location, error) => {
        if (error) {
          onError(
            error.code === 'NOT_AUTHORIZED'
              ? {
                  kind: 'denied',
                  message:
                    'Standortzugriff wurde verweigert. Bitte in den Android-Einstellungen für diese App erlauben.',
                }
              : { kind: 'error', message: 'Standort konnte nicht bestimmt werden.' },
          );
          return;
        }
        if (!location) return;
        const fix = this.toFix(location);
        this.lastFix = fix;
        onFix(fix);
      },
    );
  }

  async stop(): Promise<void> {
    const id = this.watcherId;
    this.watcherId = null;
    if (id == null) return;
    await BackgroundGeolocation.removeWatcher({ id });
  }

  /**
   * Das Plugin kennt keine Einzelabfrage. Läuft die Navigation bereits, ist
   * die letzte Ortung die beste Antwort; sonst wird kurz ein Beobachter
   * aufgesetzt und nach der ersten Ortung wieder entfernt.
   */
  async getCurrent(): Promise<GpsFix | null> {
    if (this.lastFix) return this.lastFix;

    return new Promise<GpsFix | null>((resolve) => {
      let settled = false;
      let id: string | null = null;

      const finish = (fix: GpsFix | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (id != null) void BackgroundGeolocation.removeWatcher({ id });
        resolve(fix);
      };

      const timer = setTimeout(() => finish(null), 10_000);

      void BackgroundGeolocation.addWatcher(
        // Ohne `backgroundMessage` bleibt es bei der Ortung im Vordergrund —
        // für eine einzelne Abfrage wäre eine Benachrichtigung unangemessen.
        { requestPermissions: true, stale: false },
        (location, error) => {
          if (error || !location) {
            if (error) finish(null);
            return;
          }
          finish(this.toFix(location));
        },
      ).then(
        (watcherId) => {
          id = watcherId;
          // Kam die Ortung schneller als die Zusage, sofort wieder abräumen.
          if (settled) void BackgroundGeolocation.removeWatcher({ id: watcherId });
        },
        () => finish(null),
      );
    });
  }
}

let tracker: LocationTracker | null = null;

/** Die zur Laufzeit passende Ortung. */
export function locationTracker(): LocationTracker {
  tracker ??= isNative ? new NativeTracker() : new BrowserTracker();
  return tracker;
}
