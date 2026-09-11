import { useRef, useState } from 'react';
import type { LngLat } from '@shared/types';
import type { PlaceRef } from '@/types/domain';
import { hasMapbox } from '@/config/env';
import { usePlaceSearch } from '@/hooks/usePlaceSearch';

interface SearchBarProps {
  /** Das gewählte Ziel, falls eines gesetzt ist. */
  destination: PlaceRef | null;
  proximity: LngLat | null;
  onSelect: (place: PlaceRef) => void;
  onClear: () => void;
  onOpenSettings: () => void;
}

/**
 * Die schwebende Suchleiste über der Karte.
 *
 * Die Karte ist die Hauptfläche; gesucht wird in einer Leiste darüber, und die
 * Vorschläge legen sich nur so weit darüber, wie sie Platz brauchen. Das ersetzt
 * das frühere bildschirmfüllende Formular, das die Karte dauerhaft verdeckte.
 */
export function SearchBar({
  destination,
  proximity,
  onSelect,
  onClear,
  onOpenSettings,
}: SearchBarProps) {
  const search = usePlaceSearch(proximity);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const showResults = focused && (search.loading || search.results.length > 0);
  const text = destination && !focused ? destination.name : search.query;

  return (
    <div className="pointer-events-auto px-3" style={{ paddingTop: 'calc(0.5rem + var(--safe-top))' }}>
      <div className="flex items-center gap-2">
        <div className="panel flex min-w-0 flex-1 items-center gap-2 rounded-full py-1 pr-2 pl-3.5">
          <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>

          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            autoComplete="off"
            enterKeyHint="search"
            placeholder={hasMapbox ? 'Ziel suchen' : 'Mapbox-Token fehlt'}
            disabled={!hasMapbox}
            value={text}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                inputRef.current?.blur();
                return;
              }
              // Die Eingabetaste liegt auf der Tastatur direkt unter den
              // Vorschlägen — sie soll den ersten übernehmen, nicht nichts tun.
              if (event.key === 'Enter') {
                const first = search.results[0];
                if (!first) return;
                event.preventDefault();
                search.accept(first);
                onSelect(first);
                setFocused(false);
                inputRef.current?.blur();
              }
            }}
            onFocus={() => {
              setFocused(true);
              // Beim Antippen den bisherigen Zieltext übernehmen, damit man ihn
              // ändern statt neu tippen kann.
              if (destination && search.query === '') search.setQuery(destination.name);
            }}
            // Ein Tippen auf einen Vorschlag muss vor dem Schließen ankommen.
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            className="touch-target min-w-0 flex-1 bg-transparent text-[0.95rem] text-ink-100
                       placeholder:text-ink-400 focus:outline-none disabled:opacity-60"
            aria-label="Ziel suchen"
          />

          {(text.length > 0 || destination) && (
            <button
              type="button"
              onClick={() => {
                search.clear();
                onClear();
                setFocused(false);
              }}
              aria-label="Ziel löschen"
              className="touch-target grid shrink-0 place-items-center rounded-full text-ink-400 active:text-ink-100"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Einstellungen"
          className="panel touch-target grid shrink-0 place-items-center rounded-full px-3 text-ink-300 active:text-ink-100"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6h.1A2 2 0 1 1 13 3v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {showResults && (
        <ul className="panel mt-2 max-h-[52vh] overflow-y-auto rounded-2xl py-1">
          {search.loading && search.results.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-400">Suche …</li>
          )}
          {search.results.map((place) => (
            <li key={place.id}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  search.accept(place);
                  onSelect(place);
                  setFocused(false);
                  // Den Fokus ausdrücklich abgeben, sonst bleibt auf dem
                  // Telefon die Bildschirmtastatur stehen und verdeckt das
                  // Sheet mit der Start-Schaltfläche. `setFocused` ist nur
                  // React-State und nimmt dem Feld den DOM-Fokus nicht.
                  inputRef.current?.blur();
                }}
                className="flex w-full items-start gap-3 px-4 py-2.5 text-left active:bg-ink-800"
              >
                <svg viewBox="0 0 24 24" className="mt-0.5 size-5 shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink-100">{place.name}</span>
                  {place.address && (
                    <span className="block truncate text-xs text-ink-400">{place.address}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {focused && search.error && search.results.length === 0 && !search.loading && (
        <p className="panel mt-2 rounded-2xl px-4 py-2.5 text-sm text-ink-400">{search.error}</p>
      )}
    </div>
  );
}
