import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'reichweite:theme';

export function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Wendet das gewählte Thema an und löst „System" auf.
 *
 * Das Attribut wird immer auf einen konkreten Wert gesetzt, nie auf `system` —
 * so muss das CSS nur einen Fall kennen, statt zusätzlich
 * `prefers-color-scheme` zu spiegeln.
 *
 * Das Thema wird bewusst nur lokal gespeichert und nicht mit dem Konto
 * abgeglichen: Ob hell oder dunkel passt, hängt am Gerät und an der Tageszeit,
 * nicht am Nutzer.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (value: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
    // Die Statusleiste des Browsers soll zur Fläche darunter passen.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1120' : '#ffffff');
  }, [resolved]);

  const setPreference = (value: ThemePreference) => {
    setPreferenceState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Privater Modus: Die Wahl gilt dann nur für diese Sitzung.
    }
  };

  return { preference, resolved, setPreference };
}
