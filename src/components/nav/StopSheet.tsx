import { useEffect, useState } from 'react';
import type { FuelKind, RankedStop } from '@shared/types';
import { SETTINGS_BOUNDS } from '@/types/domain';
import { STOP_KIND_LABELS } from '@/services/stations/search';
import type { StopPickerState } from '@/hooks/useNavigationSession';
import { StopCard } from './StopCard';

interface StopSheetProps {
  picker: StopPickerState;
  fuel: FuelKind;
  remainingRangeKm: number;
  reAskIntervalKm: number;
  onChoose: (ranked: RankedStop) => void;
  /** "Nein" — snoozes for the configured interval. */
  onDecline: () => void;
  /** Closes a quick search without changing the range monitor's state. */
  onClose: () => void;
  onWiden: (radiusKm: number) => void;
  onHighlight: (stopId: string | null) => void;
}

/**
 * The bottom sheet that answers "möchtest du zum Tanken fahren?".
 *
 * Two distinct exits, because the two cases mean different things: after a range
 * prompt, "Nein danke" snoozes the monitor for the configured interval; after a
 * quick search, closing the sheet is not an answer to anything and must leave the
 * monitor alone.
 */
export function StopSheet({
  picker,
  fuel,
  remainingRangeKm,
  reAskIntervalKm,
  onChoose,
  onDecline,
  onClose,
  onWiden,
  onHighlight,
}: StopSheetProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A new search invalidates the previous selection.
  useEffect(() => {
    setSelectedId(null);
  }, [picker.reason, picker.results]);

  useEffect(() => {
    if (!picker.open) onHighlight(null);
  }, [picker.open, onHighlight]);

  const reason = picker.reason;
  if (!picker.open || !reason) return null;

  // Narrowed once here rather than re-tested inline: the two branches differ in
  // both wording and in what the footer buttons do.
  const rangePrompt = reason.kind === 'range' ? reason : null;
  const critical = rangePrompt?.trigger === 'critical';

  const title = rangePrompt
    ? critical
      ? 'Reichweite kritisch'
      : 'Möchtest du zum Tanken fahren?'
    : `${STOP_KIND_LABELS[reason.kind === 'quick' ? reason.stopKind : 'fuel']} entlang der Route`;

  const subtitle = rangePrompt
    ? `Noch ${Math.round(remainingRangeKm)} km Reichweite. ${
        picker.results.length > 0
          ? `${picker.results.length} Vorschläge im Radius von ${picker.radiusKm} km.`
          : ''
      }`
    : `Ab der aktuellen Position voraus, Radius ${picker.radiusKm} km.`;

  const canWiden = picker.radiusKm < SETTINGS_BOUNDS.searchRadiusKm.max;

  return (
    <div
      className="panel pointer-events-auto flex max-h-[70vh] flex-col rounded-t-[var(--radius-sheet)]"
      role="dialog"
      aria-modal="false"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h2
            className={`text-lg leading-tight font-bold ${
              critical ? 'text-alert-500' : 'text-ink-100'
            }`}
          >
            {title}
          </h2>
          <p className="tabular mt-0.5 text-xs text-ink-400">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="touch-target -mt-1 -mr-1 grid place-items-center rounded-full text-ink-400 active:text-ink-100"
          aria-label="Schließen"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {picker.loading && (
          <div className="space-y-2 py-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-20 animate-pulse rounded-2xl bg-ink-800/70" />
            ))}
          </div>
        )}

        {!picker.loading && picker.error && (
          <div className="rounded-2xl border border-warn-600/50 bg-warn-600/10 px-3 py-3">
            <p className="text-sm text-warn-500">{picker.error}</p>
            {canWiden && (
              <button
                type="button"
                onClick={() =>
                  onWiden(Math.min(SETTINGS_BOUNDS.searchRadiusKm.max, picker.radiusKm + 8))
                }
                className="touch-target mt-2 rounded-xl bg-ink-800 px-3 text-sm font-medium text-ink-100 active:bg-ink-700"
              >
                Radius auf {Math.min(SETTINGS_BOUNDS.searchRadiusKm.max, picker.radiusKm + 8)} km
                erweitern
              </button>
            )}
          </div>
        )}

        {!picker.loading && picker.results.length > 0 && (
          <ul className="space-y-2 py-1">
            {picker.results.map((ranked, index) => (
              <li key={ranked.stop.id}>
                <StopCard
                  ranked={ranked}
                  fuel={fuel}
                  remainingRangeKm={remainingRangeKm}
                  isBest={index === 0}
                  selected={selectedId === ranked.stop.id}
                  onSelect={() => {
                    setSelectedId(ranked.stop.id);
                    onHighlight(ranked.stop.id);
                  }}
                  onHover={() => onHighlight(ranked.stop.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="flex gap-2 border-t border-ink-700/70 px-4 py-3"
        style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
      >
        {rangePrompt ? (
          <button
            type="button"
            onClick={onDecline}
            className="touch-target flex-1 rounded-2xl bg-ink-800 px-4 text-sm font-semibold text-ink-200 active:bg-ink-700"
          >
            Nein danke
            <span className="tabular block text-[0.65rem] font-normal text-ink-400">
              erneut in {reAskIntervalKm} km
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="touch-target flex-1 rounded-2xl bg-ink-800 px-4 text-sm font-semibold text-ink-200 active:bg-ink-700"
          >
            Abbrechen
          </button>
        )}

        <button
          type="button"
          disabled={selectedId === null}
          onClick={() => {
            const chosen = picker.results.find((r) => r.stop.id === selectedId);
            if (chosen) onChoose(chosen);
          }}
          className="touch-target flex-[1.4] rounded-2xl bg-route-500 px-4 text-sm font-bold text-ink-950
                     active:bg-route-600 disabled:bg-ink-700 disabled:text-ink-400"
        >
          {selectedId === null ? 'Stopp auswählen' : 'Dorthin navigieren'}
        </button>
      </div>
    </div>
  );
}
