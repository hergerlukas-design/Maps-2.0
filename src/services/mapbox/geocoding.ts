import type { LngLat, Position } from '@shared/types';
import type { PlaceRef } from '@/types/domain';
import { env } from '@/config/env';
import { fetchJson } from '@/lib/http';
import type { MapboxGeocodingResponse } from './types';

const GEOCODING_BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

export interface GeocodeOptions {
  /** Bias results towards this point (usually the current location). */
  proximity?: LngLat | null;
  limit?: number;
  signal?: AbortSignal;
}

function centerOf(feature: {
  center?: Position;
  geometry?: { coordinates: Position };
}): Position | null {
  return feature.center ?? feature.geometry?.coordinates ?? null;
}

/** Forward geocoding for the start/destination inputs. */
export async function searchPlaces(
  query: string,
  options: GeocodeOptions = {},
): Promise<PlaceRef[]> {
  const trimmed = query.trim();
  if (!env.mapboxToken || trimmed.length < 2) return [];

  const params = new URLSearchParams({
    access_token: env.mapboxToken,
    language: 'de',
    limit: String(options.limit ?? 6),
    country: env.geocodingCountries,
    types: 'address,poi,place,locality,neighborhood,postcode,district',
  });
  if (options.proximity) {
    params.set(
      'proximity',
      `${options.proximity.lng.toFixed(5)},${options.proximity.lat.toFixed(5)}`,
    );
  }

  const response = await fetchJson<MapboxGeocodingResponse>(
    `${GEOCODING_BASE}/${encodeURIComponent(trimmed)}.json?${params.toString()}`,
    { timeoutMs: 8000, retries: 0, signal: options.signal ?? null },
  );

  return response.features.flatMap<PlaceRef>((feature) => {
    const center = centerOf(feature);
    if (!center) return [];
    return [
      {
        id: feature.id,
        name: feature.text,
        address: feature.place_name,
        location: { lng: center[0], lat: center[1] },
      },
    ];
  });
}

/** Reverse geocoding, used to label "Mein Standort" with a real address. */
export async function describeLocation(
  location: LngLat,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!env.mapboxToken) return null;
  const params = new URLSearchParams({
    access_token: env.mapboxToken,
    language: 'de',
    limit: '1',
    types: 'address,place,locality',
  });
  try {
    const response = await fetchJson<MapboxGeocodingResponse>(
      `${GEOCODING_BASE}/${location.lng.toFixed(5)},${location.lat.toFixed(5)}.json?${params}`,
      { timeoutMs: 6000, retries: 0, signal: signal ?? null },
    );
    return response.features[0]?.place_name ?? null;
  } catch {
    return null;
  }
}
