import type { AmenityStop, Position } from '../../shared/types.js';
import { config } from '../lib/config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchWithTimeout, RateLimiter } from '../lib/limiter.js';
import { ProviderError } from './tankerkoenig.js';

type AmenityKind = 'rest_area' | 'toilets';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
}

const cache = new TtlCache<AmenityStop[]>(config.overpass.cacheTtlMs, 200);
// Overpass is donated infrastructure: strictly serialised, with a gap between calls.
const limiter = new RateLimiter(1, config.overpass.minIntervalMs);

/**
 * Overpass `around` accepts a list of coordinates, so the whole corridor goes
 * out as a single query instead of one request per sample point. That is the
 * difference between one 2-second call and twenty rate-limited ones.
 */
function buildQuery(
  points: Position[],
  radiusM: number,
  kinds: AmenityKind[],
): string {
  const coords = points
    .map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`)
    .join(',');
  const around = `around:${Math.round(radiusM)},${coords}`;

  const clauses: string[] = [];
  if (kinds.includes('rest_area')) {
    // `services` is a motorway service area (fuel, food); `rest_area` is a
    // lay-by. Drivers asking for "Rastplatz" mean either.
    for (const value of ['rest_area', 'services']) {
      clauses.push(`node(${around})["highway"="${value}"];`);
      clauses.push(`way(${around})["highway"="${value}"];`);
    }
  }
  if (kinds.includes('toilets')) {
    clauses.push(`node(${around})["amenity"="toilets"];`);
    clauses.push(`way(${around})["amenity"="toilets"];`);
  }

  return [
    `[out:json][timeout:${Math.round(config.overpass.timeoutMs / 1000)}];`,
    '(',
    ...clauses,
    ');',
    'out center tags;',
  ].join('\n');
}

function parseBool(value: string | undefined): boolean | null {
  if (value == null) return null;
  const text = value.toLowerCase();
  if (['yes', 'designated', 'true', '1'].includes(text)) return true;
  if (['no', 'false', '0'].includes(text)) return false;
  return null;
}

function parseFee(tags: Record<string, string>): boolean | null {
  const fee = parseBool(tags['fee']);
  if (fee != null) return fee;
  if (tags['charge']) return true;
  return null;
}

function nameFor(tags: Record<string, string>, kind: AmenityKind): string {
  const explicit = tags['name'] ?? tags['operator'] ?? tags['brand'];
  if (explicit) return explicit;
  if (kind === 'toilets') return 'Toilette';
  return tags['highway'] === 'services' ? 'Autohof / Raststätte' : 'Rastplatz';
}

function toAmenityStop(element: OverpassElement): AmenityStop | null {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat == null || lon == null) return null;

  const kind: AmenityKind = tags['amenity'] === 'toilets' ? 'toilets' : 'rest_area';

  const address: AmenityStop['address'] = {};
  if (tags['addr:street']) address.street = tags['addr:street'];
  if (tags['addr:housenumber']) address.houseNumber = tags['addr:housenumber'];
  if (tags['addr:postcode']) address.postcode = tags['addr:postcode'];
  if (tags['addr:city']) address.city = tags['addr:city'];

  const stop: AmenityStop = {
    id: `overpass:${element.type}/${element.id}`,
    kind,
    name: nameFor(tags, kind),
    location: { lng: lon, lat },
    address,
    source: 'overpass',
    isOpen: null,
    wheelchair: parseBool(tags['wheelchair']),
    fee: parseFee(tags),
  };
  if (tags['opening_hours']) stop.openingHours = tags['opening_hours'];
  return stop;
}

export async function searchAmenityStops(
  points: Position[],
  radiusKm: number,
  kinds: AmenityKind[],
): Promise<{ stops: AmenityStop[]; cached: boolean; warnings: string[] }> {
  if (kinds.length === 0) return { stops: [], cached: true, warnings: [] };

  const radiusM = Math.min(25_000, Math.max(200, radiusKm * 1000));
  const query = buildQuery(points, radiusM, kinds);
  const key = `${kinds.slice().sort().join('+')}|${Math.round(radiusM)}|${points
    .map((p) => `${p[1].toFixed(2)},${p[0].toFixed(2)}`)
    .join(';')}`;

  const warnings: string[] = [];
  const result = await cache.wrap(key, () =>
    limiter.run(async () => {
      const response = await fetchWithTimeout(config.overpass.baseUrl, {
        method: 'POST',
        timeoutMs: config.overpass.timeoutMs + 5000,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent':
            'reichweite-nav/0.1 (+https://github.com/hergerlukas-design/Maps-2.0)',
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (response.status === 429 || response.status === 504) {
        throw new ProviderError(
          'Overpass ist gerade überlastet. Bitte in einer Minute erneut versuchen.',
          'rate_limited',
        );
      }
      if (!response.ok) {
        throw new ProviderError(`Overpass antwortete mit ${response.status}.`, 'upstream');
      }
      const body = (await response.json()) as OverpassResponse;
      if (body.remark && /timed out|too many/i.test(body.remark)) {
        throw new ProviderError(`Overpass: ${body.remark}`, 'rate_limited');
      }
      const seen = new Map<string, AmenityStop>();
      for (const element of body.elements ?? []) {
        const stop = toAmenityStop(element);
        if (stop) seen.set(stop.id, stop);
      }
      return [...seen.values()];
    }),
  );

  return { stops: result.value, cached: result.cached, warnings };
}
