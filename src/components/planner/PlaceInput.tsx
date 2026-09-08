import { useEffect, useId, useRef, useState } from 'react';
import type { LngLat } from '@shared/types';
import type { PlaceRef } from '@/types/domain';
import { searchPlaces } from '@/services/mapbox/geocoding';
import { hasMapbox } from '@/config/env';

interface PlaceInputProps {
  label: string;
  placeholder: string;
  value: PlaceRef | null;
  proximity: LngLat | null;
  onChange: (place: PlaceRef | null) => void;
  /** Offers a "current location" shortcut; only shown when a getter is passed. */
  onUseCurrentLocation?: () => Promise<PlaceRef | null>;
}

const DEBOUNCE_MS = 280;

/**
 * Geocoding autocomplete for the start and destination fields.
 *
 * Requests are debounced and the in-flight one is aborted on each keystroke:
 * Mapbox bills per geocoding request, and typing "Frankfurt" would otherwise
 * cost nine of them.
 */
export function PlaceInput({
  label,
  placeholder,
  value,
  proximity,
  onChange,
  onUseCurrentLocation,
}: PlaceInputProps) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceRef[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the text in sync when the value is set from outside (swap, GPS).
  useEffect(() => {
    if (value) setQuery(value.name);
  }, [value]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    // Do not re-search the text we just filled in from a selection.
    if (value && query === value.name) return;

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      searchPlaces(query, { proximity, signal: controller.signal })
        .then((places) => {
          if (controller.signal.aborted) return;
          setResults(places);
          setLoading(false);
          if (places.length === 0) setError('Keine Treffer.');
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setError(
            cause instanceof Error && /token/i.test(cause.message)
              ? 'Kein Mapbox-Token konfiguriert.'
              : 'Suche fehlgeschlagen.',
          );
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, open, proximity, value]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="relative">
      <label
        htmlFor={listId}
        className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase"
      >
        {label}
      </label>

      <div className="flex gap-2">
        <input
          id={listId}
          type="text"
          inputMode="search"
          autoComplete="off"
          placeholder={hasMapbox ? placeholder : 'Mapbox-Token fehlt'}
          disabled={!hasMapbox}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          // A click on a suggestion must land before the list closes.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="touch-target min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm
                     text-ink-100 placeholder:text-ink-500 disabled:opacity-60"
        />

        {onUseCurrentLocation && (
          <button
            type="button"
            disabled={locating}
            onClick={async () => {
              setLocating(true);
              setError(null);
              const place = await onUseCurrentLocation();
              setLocating(false);
              if (place) {
                onChange(place);
                setQuery(place.name);
                setOpen(false);
              } else {
                setError('Standort nicht verfügbar.');
              }
            }}
            className="touch-target grid shrink-0 place-items-center rounded-xl border border-ink-700
                       bg-ink-850 px-3 text-ink-300 active:bg-ink-800 disabled:opacity-50"
            aria-label="Aktuellen Standort verwenden"
          >
            {locating ? (
              <span className="size-4 animate-spin rounded-full border-2 border-route-500 border-t-transparent" />
            ) : (
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.9}>
                <circle cx="12" cy="12" r="3.5" />
                <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" strokeLinecap="round" />
              </svg>
            )}
          </button>
        )}
      </div>

      {error && !open && <p className="mt-1.5 text-xs text-warn-500">{error}</p>}

      {open && (loading || results.length > 0) && (
        <ul className="panel absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl py-1">
          {loading && <li className="px-3 py-2 text-xs text-ink-400">Suche …</li>}
          {results.map((place) => (
            <li key={place.id}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(place);
                  setQuery(place.name);
                  setOpen(false);
                  setResults([]);
                }}
                className="w-full px-3 py-2 text-left active:bg-ink-800"
              >
                <span className="block truncate text-sm text-ink-100">{place.name}</span>
                {place.address && (
                  <span className="block truncate text-xs text-ink-400">{place.address}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
