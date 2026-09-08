import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './client';

export interface AuthResult {
  ok: boolean;
  message: string;
}

/** Sign-in with e-mail + password. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase ist nicht konfiguriert.' };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: translateAuthError(error.message) };
  return { ok: true, message: 'Angemeldet.' };
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase ist nicht konfiguriert.' };
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) return { ok: false, message: translateAuthError(error.message) };
  // With e-mail confirmation on, `session` is null until the link is clicked.
  return data.session
    ? { ok: true, message: 'Konto erstellt und angemeldet.' }
    : { ok: true, message: 'Konto erstellt. Bitte die E-Mail zur Bestätigung öffnen.' };
}

/** Passwordless sign-in; the link returns to the app shell. */
export async function signInWithMagicLink(email: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase ist nicht konfiguriert.' };
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) return { ok: false, message: translateAuthError(error.message) };
  return { ok: true, message: 'Anmeldelink verschickt. Bitte E-Mail prüfen.' };
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** Subscribes to auth changes; returns the unsubscribe function. */
export function onAuthChange(handler: (user: User | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    handler(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}

/** Supabase returns English messages; the UI is German throughout. */
function translateAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('invalid login credentials')) {
    return 'E-Mail oder Passwort ist falsch.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Die E-Mail-Adresse ist noch nicht bestätigt.';
  }
  if (lower.includes('user already registered')) {
    return 'Für diese E-Mail existiert bereits ein Konto.';
  }
  if (lower.includes('password should be at least')) {
    return 'Das Passwort ist zu kurz (mindestens 6 Zeichen).';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Zu viele Versuche. Bitte einen Moment warten.';
  }
  return message;
}
