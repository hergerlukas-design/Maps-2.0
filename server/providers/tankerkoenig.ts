import type { FuelKind, FuelStop, Position } from '../../shared/types.js';
import { config } from '../lib/config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchWithTimeout, RateLimiter } from '../lib/limiter.js';

/* Raw Tankerkönig `list.php` response (type=all). */
interface TkStation {
  id: string;
  name: string;
  brand: string;
  street: string;
  place: string;
  lat: number;
  lng: number;
  dist: number;
  diesel: number | null;
  e5: number | null;
  e10: number | null;
  isOpen: boolean;
  houseNumber?: string;
  postCode?: number | string;
}

interface TkListResponse {
  ok: boolean;
  license?: string;
  data?: string;
  status?: string;
  message?: string;
  stations?: TkStation[];
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'upstream' | 'rate_limited',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const cache = new TtlCache<FuelStop[]>(config.tankerkoenig.cacheTtlMs, 400);
// Tankerkönig asks for gentle usage; three parallel circle queries is plenty.
const limiter = new RateLimiter(3, 120);

function priceOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toFuelStop(station: TkStation): FuelStop {
  const address: FuelStop['address'] = {};
  if (station.street) address.street = station.street;
  if (station.houseNumber) address.houseNumber = station.houseNumber;
  if (station.postCode != null) address.postcode = String(station.postCode);
  if (station.place) address.city = station.place;

  return {
    id: `tankerkoenig:${station.id}`,
    kind: 'fuel',
    name: station.name?.trim() || station.brand?.trim() || 'Tankstelle',
    ...(station.brand ? { brand: station.brand } : {}),
    location: { lng: station.lng, lat: station.lat },
    address,
    source: 'tankerkoenig',
    isOpen: station.isOpen,
    prices: {
      e5: priceOrNull(station.e5),
      e10: priceOrNull(station.e10),
      diesel: priceOrNull(station.diesel),
    },
  };
}

/** Rounded cache key: nearby requests reuse the same 5-minute-old prices. */
function cacheKey(point: Position, radiusKm: number): string {
  return `${point[1].toFixed(2)},${point[0].toFixed(2)},${radiusKm.toFixed(1)}`;
}

async function fetchCircle(
  point: Position,
  radiusKm: number,
): Promise<{ stops: FuelStop[]; cached: boolean }> {
  const apiKey = config.tankerkoenig.apiKey;
  if (!apiKey) {
    throw new ProviderError(
      'Tankerkönig-API-Key fehlt (TANKERKOENIG_API_KEY). Kraftstoffpreise sind deaktiviert.',
      'not_configured',
    );
  }

  const key = cacheKey(point, radiusKm);
  const result = await cache.wrap(key, () =>
    limiter.run(async () => {
      const params = new URLSearchParams({
        lat: point[1].toFixed(6),
        lng: point[0].toFixed(6),
        rad: radiusKm.toFixed(1),
        sort: 'dist',
        type: 'all',
        apikey: apiKey,
      });
      const response = await fetchWithTimeout(
        `${config.tankerkoenig.baseUrl}/json/list.php?${params.toString()}`,
        { timeoutMs: 10_000, headers: { accept: 'application/json' } },
      );
      if (response.status === 429) {
        throw new ProviderError('Tankerkönig-Ratenlimit erreicht.', 'rate_limited');
      }
      if (!response.ok) {
        throw new ProviderError(
          `Tankerkönig antwortete mit ${response.status}.`,
          'upstream',
        );
      }
      const body = (await response.json()) as TkListResponse;
      if (!body.ok) {
        throw new ProviderError(
          body.message ?? 'Tankerkönig meldete einen Fehler.',
          'upstream',
        );
      }
      return (body.stations ?? []).map(toFuelStop);
    }),
  );

  return { stops: result.value, cached: result.cached };
}

/**
 * Queries every corridor point and merges the results. A station near two
 * overlapping circles appears twice upstream; we keep the entry that actually
 * carries a price for the requested grade.
 */
export async function searchFuelStops(
  points: Position[],
  radiusKm: number,
  fuel: FuelKind,
): Promise<{ stops: FuelStop[]; cached: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const results = await Promise.allSettled(
    points.map((point) => fetchCircle(point, radiusKm)),
  );

  const byId = new Map<string, FuelStop>();
  let anyFresh = false;
  let succeeded = 0;

  for (const result of results) {
    if (result.status === 'rejected') {
      const reason = result.reason;
      if (reason instanceof ProviderError && reason.kind === 'not_configured') {
        throw reason;
      }
      warnings.push(
        reason instanceof Error ? reason.message : 'Teilabfrage fehlgeschlagen.',
      );
      continue;
    }
    succeeded++;
    if (!result.value.cached) anyFresh = true;
    for (const stop of result.value.stops) {
      const existing = byId.get(stop.id);
      if (!existing || (existing.prices[fuel] == null && stop.prices[fuel] != null)) {
        byId.set(stop.id, stop);
      }
    }
  }

  if (succeeded === 0) {
    throw new ProviderError(
      warnings[0] ?? 'Keine Antwort von Tankerkönig.',
      'upstream',
    );
  }

  return { stops: [...byId.values()], cached: !anyFresh, warnings };
}
