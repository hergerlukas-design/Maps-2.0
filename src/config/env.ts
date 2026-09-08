/**
 * Client-side configuration. Only `VITE_`-prefixed variables reach the browser
 * bundle; the Tankerkönig / GoingElectric / Open Charge Map keys deliberately
 * stay on the server and are used through `/api/*`.
 */

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const env = {
  mapboxToken: optional(import.meta.env.VITE_MAPBOX_TOKEN),
  mapboxStyle:
    optional(import.meta.env.VITE_MAPBOX_STYLE) ?? 'mapbox://styles/mapbox/navigation-night-v1',
  mapboxStyleDay:
    optional(import.meta.env.VITE_MAPBOX_STYLE_DAY) ?? 'mapbox://styles/mapbox/navigation-day-v1',
  supabaseUrl: optional(import.meta.env.VITE_SUPABASE_URL),
  supabaseAnonKey: optional(import.meta.env.VITE_SUPABASE_ANON_KEY),
  apiBase: optional(import.meta.env.VITE_API_BASE) ?? '/api',
  /** Restricts geocoding results; Tankerkönig only covers Germany anyway. */
  geocodingCountries: optional(import.meta.env.VITE_GEOCODING_COUNTRIES) ?? 'de,at,ch',
} as const;

export const hasMapbox = env.mapboxToken !== null;
export const hasSupabase = env.supabaseUrl !== null && env.supabaseAnonKey !== null;
