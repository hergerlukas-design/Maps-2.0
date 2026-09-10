import { useEffect, useState } from 'react';
import type { StopWaypoint } from '@/types/domain';

interface TopUpDialogProps {
  /** The stop just reached, or `null` when the dialog is closed. */
  stop: StopWaypoint | null;
  /**
   * Vorbelegung des Feldes: die eingetragene volle Reichweite des Fahrzeugs,
   * ersatzweise der zuletzt selbst eingegebene Wert. Bewusst keine erfundene
   * Zahl — die volle Reichweite ist von Fahrzeug zu Fahrzeug zu verschieden.
   */
  suggestedRangeKm: number | null;
  onConfirm: (rangeKm: number) => void;
  onSkip: () => void;
}

/**
 * Asked after a fuel or charging stop is reached: how much range is there now?
 *
 * Without this the range monitor would keep counting down from the pre-stop
 * figure and never stop asking. Since range is entered by hand, arriving at a
 * station is exactly the moment to ask for a fresh number.
 */
export function TopUpDialog({
  stop,
  suggestedRangeKm,
  onConfirm,
  onSkip,
}: TopUpDialogProps) {
  const [value, setValue] = useState(suggestedRangeKm ?? 0);

  useEffect(() => {
    if (stop && suggestedRangeKm != null) setValue(suggestedRangeKm);
  }, [stop, suggestedRangeKm]);

  if (!stop) return null;

  const charging = stop.kind === 'charging';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/75 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reichweite aktualisieren"
        className="panel relative w-full max-w-md rounded-3xl p-5"
        style={{ marginBottom: 'var(--safe-bottom)' }}
      >
        <h2 className="text-lg font-bold">
          {charging ? 'Geladen?' : 'Getankt?'}
        </h2>
        <p className="mt-1 text-sm text-ink-300">
          <span className="font-semibold text-ink-100">{stop.name}</span> ist erreicht.
          Wie viel Reichweite zeigt das Fahrzeug jetzt an?
        </p>

        <div className="mt-4 flex items-center gap-3">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={2000}
            step={5}
            value={value}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              setValue(Number.isFinite(parsed) ? Math.max(0, Math.min(2000, parsed)) : 0);
            }}
            className="tabular touch-target w-32 rounded-xl border border-ink-700 bg-ink-850 px-3 text-xl font-bold text-ink-100"
            autoFocus
          />
          <span className="text-sm text-ink-400">km</span>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="touch-target flex-1 rounded-2xl bg-ink-800 px-4 text-sm font-semibold text-ink-300 active:bg-ink-700"
          >
            Übersprungen
          </button>
          <button
            type="button"
            onClick={() => onConfirm(value)}
            className="touch-target flex-[1.4] rounded-2xl bg-route-500 px-4 text-sm font-bold text-ink-950 active:bg-route-600"
          >
            Weiterfahren
          </button>
        </div>
      </div>
    </div>
  );
}
