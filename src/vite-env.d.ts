/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN?: string;
  readonly VITE_MAPBOX_STYLE?: string;
  readonly VITE_MAPBOX_STYLE_DAY?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_GEOCODING_COUNTRIES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
