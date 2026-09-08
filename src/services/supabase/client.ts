import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, hasSupabase } from '@/config/env';
import type { Database } from './schema';

/**
 * The Supabase client, or `null` when no project is configured.
 *
 * A missing project must not break the app: route planning and navigation work
 * entirely without an account, and only profiles/settings/favourites sync. Every
 * caller therefore has to handle `null`, which is why this is not a throwing
 * getter.
 */
export const supabase: SupabaseClient<Database> | null = hasSupabase
  ? createClient<Database>(env.supabaseUrl!, env.supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Magic links land back on the app shell, which the SPA fallback serves.
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-application-name': 'reichweite-nav' },
      },
    })
  : null;

export function requireSupabase(): SupabaseClient<Database> {
  if (!supabase) {
    throw new Error(
      'Supabase ist nicht konfiguriert (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).',
    );
  }
  return supabase;
}
