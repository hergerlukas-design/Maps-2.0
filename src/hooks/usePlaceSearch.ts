import { useCallback, useEffect, useRef, useState } from 'react';
import type { LngLat } from '@shared/types';
import type { PlaceRef } from '@/types/domain';
import { searchPlaces } from '@/services/mapbox/geocoding';
import { distanceM, toPosition } from '@/lib/geo';
import { hasMapbox } from '@/config/env';

const DEBOUNCE_MS = 280;

/**
 * Sortiert Treffer nach Luftlinie zum aktuellen Standort.
 *
 * Der `proximity`-Parameter von Mapbox ist nur eine Gewichtung, keine
 * Sortierung: Bei einem Straßennamen, den es in mehreren Städten gibt, kann ein
 * weit entfernter Treffer trotzdem oben stehen. In einer Navigations-App fährt
 * man aber fast immer zu etwas in der Nähe, deshalb wird hier hart nach
 * Entfernung sortiert.
 *
 * Ohne bekannten Standort bleibt die Reihenfolge von Mapbox unangetastet.
 */
function byDistance(places: PlaceRef[], from: LngLat | null): PlaceRef[] {
  if (!from) return places;
  const origin = toPosition(from);
  return places
    .map((place) => ({
      ...place,
      distanceM: distanceM(origin, toPosition(place.location)),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

export interface PlaceSearchState {
  query: string;
  results: PlaceRef[];
  loading: boolean;
  error: string | null;
  setQuery: (value: string) => void;
  clear: () => void;
  /** Übernimmt einen Treffer: setzt den Text und leert die Vorschlagsliste. */
  accept: (place: PlaceRef) => void;
}

/**
 * Adresssuche mit Entprellung und Abbruch der vorherigen Anfrage.
 *
 * Beides ist keine Feinpolitur: Mapbox rechnet pro Geocoding-Anfrage ab, und
 * ohne diese beiden Maßnahmen kostet das Tippen von „Hannoversche Straße"
 * zwanzig Anfragen statt einer.
 */
export function usePlaceSearch(proximity: LngLat | null): PlaceSearchState {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<PlaceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** Unterdrückt die Suche für den Text, den eine Auswahl selbst gesetzt hat. */
  const acceptedRef = useRef<string | null>(null);

  const setQuery = useCallback((value: string) => {
    acceptedRef.current = null;
    setQueryState(value);
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    acceptedRef.current = null;
    setQueryState('');
    setResults([]);
    setError(null);
    setLoading(false);
  }, []);

  const accept = useCallback((place: PlaceRef) => {
    abortRef.current?.abort();
    acceptedRef.current = place.name;
    setQueryState(place.name);
    setResults([]);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || acceptedRef.current === query) {
      setResults([]);
      setLoading(false);
      return;
    }
    if (!hasMapbox) {
      setError('Kein Mapbox-Token konfiguriert.');
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      searchPlaces(trimmed, { proximity, signal: controller.signal })
        .then((places) => {
          if (controller.signal.aborted) return;
          setResults(byDistance(places, proximity));
          setLoading(false);
          setError(places.length === 0 ? 'Keine Treffer.' : null);
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
  }, [query, proximity]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { query, results, loading, error, setQuery, clear, accept };
}
