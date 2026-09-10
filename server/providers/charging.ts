import type {
  ChargingConnector,
  ChargingStop,
  ConnectorType,
  Position,
} from '../../shared/types.js';
import { config } from '../lib/config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchWithTimeout, RateLimiter } from '../lib/limiter.js';
import { ProviderError } from './tankerkoenig.js';

/* ------------------------------------------------------------------ *
 * Connector normalisation
 * ------------------------------------------------------------------ */

/**
 * Both upstreams use free-text plug names. Matching on substrings is the only
 * workable approach — GoingElectric alone returns "Typ2", "Typ 2 Dose",
 * "CCS / SAE", "Tesla Supercharger" and several regional spellings.
 */
export function normaliseConnector(raw: string): ConnectorType {
  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.includes('supercharger') || text.includes('tesla')) {
    return text.includes('ccs') ? 'ccs' : 'tesla_supercharger';
  }
  if (text.includes('chademo')) return 'chademo';
  if (text.includes('ccs') || text.includes('combo')) return 'ccs';
  if (text.includes('schuko') || text.includes('haushalt') || text.includes('domestic')) {
    return 'schuko';
  }
  if (text.includes('typ2') || text.includes('typ 2') || text.includes('type 2')) {
    return text.includes('dose') || text.includes('socket') ? 'type2_socket' : 'type2';
  }
  return 'other';
}

/** Type 2 cable and socket are interchangeable for filtering purposes. */
function connectorMatches(
  connector: ConnectorType,
  wanted: readonly ConnectorType[],
): boolean {
  if (wanted.length === 0) return true;
  if (wanted.includes(connector)) return true;
  const type2 = connector === 'type2' || connector === 'type2_socket';
  return type2 && (wanted.includes('type2') || wanted.includes('type2_socket'));
}

function mergeConnectors(connectors: ChargingConnector[]): ChargingConnector[] {
  const byKey = new Map<string, ChargingConnector>();
  for (const connector of connectors) {
    const key = `${connector.type}:${connector.powerKw ?? 'na'}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += connector.count;
      if (connector.available != null) {
        existing.available = (existing.available ?? 0) + connector.available;
      }
    } else {
      byKey.set(key, { ...connector });
    }
  }
  return [...byKey.values()].sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0));
}

function finalise(
  stop: Omit<ChargingStop, 'maxPowerKw' | 'connectors'> & {
    connectors: ChargingConnector[];
  },
): ChargingStop {
  const connectors = mergeConnectors(stop.connectors);
  const powers = connectors
    .map((c) => c.powerKw)
    .filter((p): p is number => p != null && Number.isFinite(p));
  return {
    ...stop,
    connectors,
    maxPowerKw: powers.length > 0 ? Math.max(...powers) : null,
  };
}

/* ------------------------------------------------------------------ *
 * GoingElectric (preferred: plug type, power and live availability)
 * ------------------------------------------------------------------ */

interface GeChargepoint {
  type: string;
  power: number | string;
  count: number;
}

interface GeLocation {
  ge_id: number | string;
  name: string;
  address?: { city?: string; street?: string; postcode?: string; country?: string };
  coordinates: { lat: number; lng: number };
  network?: string;
  operator?: string;
  chargepoints?: GeChargepoint[];
  /** `true`/`false`/`null`; only set for networks that report status. */
  available?: boolean | null;
  fault_report?: unknown;
}

interface GeResponse {
  status: string;
  error?: string;
  chargelocations?: GeLocation[];
}

const geCache = new TtlCache<ChargingStop[]>(config.goingElectric.cacheTtlMs, 300);
const geLimiter = new RateLimiter(2, 200);

function toNumber(value: number | string | null | undefined): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function geToStop(location: GeLocation): ChargingStop {
  const address: ChargingStop['address'] = {};
  if (location.address?.street) address.street = location.address.street;
  if (location.address?.postcode) address.postcode = location.address.postcode;
  if (location.address?.city) address.city = location.address.city;

  const connectors: ChargingConnector[] = (location.chargepoints ?? []).map((cp) => ({
    type: normaliseConnector(cp.type ?? ''),
    powerKw: toNumber(cp.power),
    count: Math.max(1, Math.round(Number(cp.count) || 1)),
    available: null,
  }));

  return finalise({
    id: `goingelectric:${location.ge_id}`,
    kind: 'charging',
    name: location.name?.trim() || 'Ladestation',
    ...(location.network ? { brand: location.network } : {}),
    location: { lng: location.coordinates.lng, lat: location.coordinates.lat },
    address,
    source: 'goingelectric',
    isOpen: location.available ?? null,
    ...(location.operator ? { operator: location.operator } : {}),
    connectors,
  });
}

async function fetchGoingElectric(
  point: Position,
  radiusKm: number,
): Promise<{ stops: ChargingStop[]; cached: boolean }> {
  const apiKey = config.goingElectric.apiKey;
  if (!apiKey) {
    throw new ProviderError(
      'GoingElectric-API-Key fehlt (GOINGELECTRIC_API_KEY).',
      'not_configured',
    );
  }
  const key = `${point[1].toFixed(2)},${point[0].toFixed(2)},${radiusKm.toFixed(1)}`;
  const result = await geCache.wrap(key, () =>
    geLimiter.run(async () => {
      const params = new URLSearchParams({
        key: apiKey,
        lat: point[1].toFixed(6),
        lng: point[0].toFixed(6),
        radius: radiusKm.toFixed(1),
        orderby: 'distance',
        // Ask for the full record so `chargepoints` is populated.
        verbose: 'true',
      });
      const response = await fetchWithTimeout(
        `${config.goingElectric.baseUrl}/chargepoints/?${params.toString()}`,
        { timeoutMs: 12_000, headers: { accept: 'application/json' } },
      );
      if (response.status === 429) {
        throw new ProviderError('GoingElectric-Ratenlimit erreicht.', 'rate_limited');
      }
      if (!response.ok) {
        throw new ProviderError(
          `GoingElectric antwortete mit ${response.status}.`,
          'upstream',
        );
      }
      const body = (await response.json()) as GeResponse;
      if (body.status !== 'ok') {
        throw new ProviderError(
          body.error ?? 'GoingElectric meldete einen Fehler.',
          'upstream',
        );
      }
      return (body.chargelocations ?? []).map(geToStop);
    }),
  );
  return { stops: result.value, cached: result.cached };
}

/* ------------------------------------------------------------------ *
 * Open Charge Map (fallback; works without a key at reduced quota)
 * ------------------------------------------------------------------ */

interface OcmPoi {
  ID: number;
  UUID?: string;
  AddressInfo?: {
    Title?: string;
    AddressLine1?: string;
    Town?: string;
    Postcode?: string;
    Latitude: number;
    Longitude: number;
  };
  OperatorInfo?: { Title?: string } | null;
  StatusType?: { IsOperational?: boolean | null } | null;
  Connections?: Array<{
    ConnectionType?: { Title?: string } | null;
    PowerKW?: number | null;
    Quantity?: number | null;
    StatusType?: { IsOperational?: boolean | null } | null;
  }>;
}

const ocmCache = new TtlCache<ChargingStop[]>(config.openChargeMap.cacheTtlMs, 300);
const ocmLimiter = new RateLimiter(2, 250);

function ocmToStop(poi: OcmPoi): ChargingStop | null {
  const info = poi.AddressInfo;
  if (!info || !Number.isFinite(info.Latitude) || !Number.isFinite(info.Longitude)) {
    return null;
  }
  const address: ChargingStop['address'] = {};
  if (info.AddressLine1) address.street = info.AddressLine1;
  if (info.Postcode) address.postcode = info.Postcode;
  if (info.Town) address.city = info.Town;

  const connectors: ChargingConnector[] = (poi.Connections ?? []).map((connection) => ({
    type: normaliseConnector(connection.ConnectionType?.Title ?? ''),
    powerKw: toNumber(connection.PowerKW ?? null),
    count: Math.max(1, Math.round(connection.Quantity ?? 1)),
    available: null,
  }));

  return finalise({
    id: `openchargemap:${poi.ID}`,
    kind: 'charging',
    name: info.Title?.trim() || 'Ladestation',
    location: { lng: info.Longitude, lat: info.Latitude },
    address,
    source: 'openchargemap',
    isOpen: poi.StatusType?.IsOperational ?? null,
    ...(poi.OperatorInfo?.Title ? { operator: poi.OperatorInfo.Title } : {}),
    connectors,
  });
}

async function fetchOpenChargeMap(
  point: Position,
  radiusKm: number,
  limit: number,
): Promise<{ stops: ChargingStop[]; cached: boolean }> {
  const key = `${point[1].toFixed(2)},${point[0].toFixed(2)},${radiusKm.toFixed(1)}`;
  const result = await ocmCache.wrap(key, () =>
    ocmLimiter.run(async () => {
      const params = new URLSearchParams({
        output: 'json',
        countrycode: 'DE',
        latitude: point[1].toFixed(6),
        longitude: point[0].toFixed(6),
        distance: radiusKm.toFixed(1),
        distanceunit: 'KM',
        maxresults: String(Math.min(200, limit * 3)),
        compact: 'true',
        verbose: 'false',
      });
      if (config.openChargeMap.apiKey) params.set('key', config.openChargeMap.apiKey);

      const response = await fetchWithTimeout(
        `${config.openChargeMap.baseUrl}/v3/poi?${params.toString()}`,
        {
          timeoutMs: 12_000,
          headers: {
            accept: 'application/json',
            // OCM asks API consumers to identify themselves.
            'user-agent': 'reichweite-nav/0.1 (+https://github.com/hergerlukas-design/Maps-2.0)',
          },
        },
      );
      if (response.status === 429) {
        throw new ProviderError('Open-Charge-Map-Ratenlimit erreicht.', 'rate_limited');
      }
      if (!response.ok) {
        throw new ProviderError(
          `Open Charge Map antwortete mit ${response.status}.`,
          'upstream',
        );
      }
      const body = (await response.json()) as OcmPoi[];
      return body.flatMap((poi) => {
        const stop = ocmToStop(poi);
        return stop ? [stop] : [];
      });
    }),
  );
  return { stops: result.value, cached: result.cached };
}

/* ------------------------------------------------------------------ *
 * Combined search
 * ------------------------------------------------------------------ */

export interface ChargingSearchOptions {
  connectors: ConnectorType[];
  minPowerKw: number;
  limit: number;
}

/**
 * Prefers GoingElectric (richer plug/power data) and falls back to Open Charge
 * Map when no GoingElectric key is configured or the request fails, so an
 * EV driver always gets something.
 */
export async function searchChargingStops(
  points: Position[],
  radiusKm: number,
  options: ChargingSearchOptions,
): Promise<{
  stops: ChargingStop[];
  cached: boolean;
  warnings: string[];
  sources: Array<'goingelectric' | 'openchargemap'>;
}> {
  const warnings: string[] = [];
  const sources: Array<'goingelectric' | 'openchargemap'> = [];
  const byId = new Map<string, ChargingStop>();
  let anyFresh = false;

  // Hinweise und echte Fehlschläge getrennt halten. „Kein GoingElectric-Key
  // konfiguriert" ist eine Information über die gewählte Quelle, keine
  // Fehlerursache — würde man beides in einen Topf werfen, meldete die App bei
  // einem Ausfall von Open Charge Map einen fehlenden Key als Grund und
  // schickte den Nutzer auf die falsche Fährte.
  const failures: string[] = [];

  const collect = async (
    label: 'goingelectric' | 'openchargemap',
    load: (point: Position) => Promise<{ stops: ChargingStop[]; cached: boolean }>,
  ): Promise<boolean> => {
    const results = await Promise.allSettled(points.map(load));
    let succeeded = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        const message =
          reason instanceof Error ? reason.message : 'Teilabfrage fehlgeschlagen.';
        if (!failures.includes(message)) failures.push(message);
        continue;
      }
      succeeded++;
      if (!result.value.cached) anyFresh = true;
      for (const stop of result.value.stops) byId.set(stop.id, stop);
    }
    if (succeeded > 0) sources.push(label);
    return succeeded > 0;
  };

  let ok = false;
  if (config.goingElectric.apiKey) {
    ok = await collect('goingelectric', (point) => fetchGoingElectric(point, radiusKm));
  } else {
    warnings.push(
      'Kein GoingElectric-Key konfiguriert – es wird Open Charge Map verwendet.',
    );
  }
  if (!ok) {
    ok = await collect('openchargemap', (point) =>
      fetchOpenChargeMap(point, radiusKm, options.limit),
    );
  }

  if (!ok) {
    // Die zuletzt versuchte Quelle ist die aussagekräftige Ursache.
    throw new ProviderError(
      failures[failures.length - 1] ?? 'Keine Ladesäulen-Quelle erreichbar.',
      'upstream',
    );
  }

  // Teilausfälle gehören in die Antwort, damit die Oberfläche sie anzeigen
  // kann — sie haben das Ergebnis aber nicht verhindert.
  warnings.push(...failures);

  const filtered = [...byId.values()].filter((stop) => {
    const usable = stop.connectors.filter(
      (connector) =>
        connectorMatches(connector.type, options.connectors) &&
        (options.minPowerKw <= 0 || (connector.powerKw ?? 0) >= options.minPowerKw),
    );
    return usable.length > 0;
  });

  return { stops: filtered, cached: !anyFresh, warnings, sources };
}
