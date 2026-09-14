import { isNative } from './index';

/**
 * Die native Hülle: Statusleiste und Zurück-Taste.
 *
 * Im Browser tut hier alles nichts — die Statusleiste gehört dem System, und
 * eine Zurück-Taste gibt es nicht.
 */

/**
 * Färbt die Schrift der Statusleiste passend zum Thema.
 *
 * Ohne das steht im hellen Thema weiße Schrift auf hellem Grund: die Uhrzeit
 * und der Akkustand sind dann schlicht nicht zu lesen.
 */
export async function applyStatusBarTheme(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // `Style.Dark` bedeutet *dunkler Grund*, also helle Schrift — die
    // Benennung ist entgegen der Erwartung.
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
  } catch {
    // Kein Grund, deswegen die App anzuhalten.
  }
}

/**
 * Hängt sich in die Zurück-Taste.
 *
 * Android beendet die App, wenn niemand die Taste behandelt. Mitten in einer
 * Fahrt wäre das dasselbe Ärgernis wie das versehentliche Neuladen im Browser:
 * Route, Fortschritt und Reichweitenstand sind weg.
 *
 * `handler` gibt zurück, ob es die Taste verbraucht hat. Bei `false` wird die
 * App verlassen.
 */
export function onHardwareBack(handler: () => boolean): () => void {
  if (!isNative) return () => {};

  let remove: (() => void) | null = null;
  let cancelled = false;

  void (async () => {
    try {
      const { App } = await import('@capacitor/app');
      const listener = await App.addListener('backButton', () => {
        if (handler()) return;
        void App.exitApp();
      });
      if (cancelled) void listener.remove();
      else remove = () => void listener.remove();
    } catch {
      // Ohne Brücke bleibt es beim Standardverhalten.
    }
  })();

  return () => {
    cancelled = true;
    remove?.();
  };
}
