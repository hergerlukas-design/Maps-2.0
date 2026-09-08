import { useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { signIn, signInWithMagicLink, signOut, signUp } from '@/services/supabase/auth';
import { Sheet } from '@/components/ui/Sheet';

interface AccountPanelProps {
  open: boolean;
  user: User | null;
  accountsAvailable: boolean;
  onClose: () => void;
}

type Mode = 'signin' | 'signup' | 'magic';

/**
 * Sign-in, sign-up and sign-out.
 *
 * An account is optional throughout the app — planning and navigating work
 * without one — so this panel explains what signing in actually buys rather than
 * presenting itself as a gate.
 */
export function AccountPanel({ open, user, accountsAvailable, onClose }: AccountPanelProps) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result =
      mode === 'magic'
        ? await signInWithMagicLink(email)
        : mode === 'signup'
          ? await signUp(email, password)
          : await signIn(email, password);
    setMessage(result.message);
    setBusy(false);
    if (result.ok && mode !== 'magic') {
      setPassword('');
      // A successful password sign-in has nothing left to show here.
      if (mode === 'signin') onClose();
    }
  };

  return (
    <Sheet open={open} title="Konto" onClose={onClose}>
      <div className="space-y-4 px-4 pb-6">
        {!accountsAvailable && (
          <p className="rounded-xl border border-warn-600/50 bg-warn-600/10 px-3 py-2.5 text-sm text-warn-500">
            Kein Supabase-Projekt konfiguriert. Route, Navigation und Einstellungen
            funktionieren trotzdem — die Einstellungen bleiben dann nur auf diesem Gerät.
          </p>
        )}

        {user ? (
          <>
            <div className="rounded-2xl bg-ink-850/70 p-4">
              <p className="text-xs tracking-wide text-ink-400 uppercase">Angemeldet als</p>
              <p className="mt-0.5 truncate text-sm font-semibold text-ink-100">{user.email}</p>
            </div>
            <p className="text-xs leading-relaxed text-ink-400">
              Fahrzeugprofile, Einstellungen, Favoriten und der Fahrtverlauf werden mit
              diesem Konto synchronisiert.
            </p>
            <button
              type="button"
              onClick={async () => {
                await signOut();
                onClose();
              }}
              className="touch-target w-full rounded-2xl bg-alert-600/25 px-4 text-sm font-semibold text-alert-500 active:bg-alert-600/40"
            >
              Abmelden
            </button>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-400">
              Mit einem Konto stehen Fahrzeugprofile, Einstellungen und Favoriten auf allen
              Geräten zur Verfügung. Ohne Konto lässt sich die App genauso nutzen.
            </p>

            <div className="flex gap-1.5 rounded-xl bg-ink-850 p-1">
              {(
                [
                  ['signin', 'Anmelden'],
                  ['signup', 'Registrieren'],
                  ['magic', 'Per Link'],
                ] as Array<[Mode, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setMessage(null);
                  }}
                  className={`touch-target flex-1 rounded-lg text-xs font-semibold transition-colors ${
                    mode === value ? 'bg-ink-700 text-ink-100' : 'text-ink-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-3">
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="E-Mail"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={!accountsAvailable}
                className="touch-target w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100 placeholder:text-ink-500 disabled:opacity-50"
              />
              {mode !== 'magic' && (
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder="Passwort (min. 6 Zeichen)"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={!accountsAvailable}
                  className="touch-target w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100 placeholder:text-ink-500 disabled:opacity-50"
                />
              )}
              <button
                type="submit"
                disabled={busy || !accountsAvailable}
                className="touch-target w-full rounded-2xl bg-route-500 px-4 text-sm font-bold text-ink-950 active:bg-route-600 disabled:bg-ink-700 disabled:text-ink-400"
              >
                {busy
                  ? 'Bitte warten …'
                  : mode === 'magic'
                    ? 'Anmeldelink senden'
                    : mode === 'signup'
                      ? 'Konto erstellen'
                      : 'Anmelden'}
              </button>
            </form>
          </>
        )}

        {message && <p className="text-xs text-ink-300">{message}</p>}
      </div>
    </Sheet>
  );
}
