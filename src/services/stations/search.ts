import type {
  AmenitySearchRequest,
  AmenityStop,
  ChargingSearchRequest,
  ChargingStop,
  ConnectorType,
  FuelKind,
  FuelSearchRequest,
  FuelStop,
  RankedStop,
  RouteRelation,
  SearchResponse,
  Stop,
  StopKind,
} from '@shared/types';
import { env } from '@/config/env';
import { HttpError, postJson } from '@/lib/http';
import {
  distanceM,
  sampleAlong,
  snapToLine,
  toPosition,
  type MeasuredLine,
} from '@/lib/geo';

/* ------------------------------------------------------------------ *
 * Corridor construction
 * ------------------------------------------------------------------ */

export interface CorridorWindow {
  /** Metres along the route where the search starts (usually "here"). */
  fromM: number;
  /** Metres along the route where the search ends. */
  toM: number;
  radiusKm: number;
}

/**
 * Builds the sample points for a corridor search.
 *
 * Circles are placed at 1.6 × radius so consecutive circles overlap — at
 * exactly 2 × radius the gaps between them would hide stations that sit just
 * off the route between two samples.
 */
export function corridorPoints(line: MeasuredLine, window: CorridorWindow) {
  const spacingM = Math.max(2000, window.radiusKm * 1000 * 1.6);
  return sampleAlong(line, window.fromM, window.toM, spacingM, 24);
}

export class StopSearchError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'rate_limited' | 'upstream' | 'unknown',
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'StopSearchError';
  }
}

function toSearchError(error: unknown): StopSearchError {
  if (error instanceof HttpError) {
    const body = error.body as
      | { error?: { code?: string; message?: string; retryAfter?: number } }
      | undefined;
    const message = body?.error?.message ?? error.message;
    const code = body?.error?.code;
    if (code === 'not_configured') return new StopSearchError(message, 'not_configured');
    if (code === 'rate_limited') {
      return new StopSearchError(message, 'rate_limited', body?.error?.retryAfter);
    }
    return new StopSearchError(message, 'upstream');
  }
  return new StopSearchError(
    error instanceof Error ? error.message : 'Suche fehlgeschlagen.',
    'unknown',
  );
}

/* ------------------------------------------------------------------ *
 * API calls
 * ------------------------------------------------------------------ */

export interface FuelSearchOptions extends CorridorWindow {
  fuel: FuelKind;
  limit?: number;
  signal?: AbortSignal;
}

export async function searchFuel(
  line: MeasuredLine,
  options: FuelSearchOptions,
): Promise<SearchResponse<FuelStop>> {
  const request: FuelSearchRequest = {
    points: corridorPoints(line, options),
    radiusKm: options.radiusKm,
    fuel: options.fuel,
    limit: options.limit ?? 60,
  };
  try {
    return await postJson<SearchResponse<FuelStop>>(
      `${env.apiBase}/stops/fuel`,
      request,
      { timeoutMs: 20_000, retries: 1, signal: options.signal ?? null },
    );
  } catch (error) {
    throw toSearchError(error);
  }
}

export interface ChargingSearchOptions extends CorridorWindow {
  connectors: ConnectorType[];
  minPowerKw: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function searchCharging(
  line: MeasuredLine,
  options: ChargingSearchOptions,
): Promise<SearchResponse<ChargingStop>> {
  const request: ChargingSearchRequest = {
    points: corridorPoints(line, options),
    radiusKm: options.radiusKm,
    connectors: options.connectors,
    minPowerKw: options.minPowerKw,
    limit: options.limit ?? 60,
  };
  try {
    return await postJson<SearchResponse<ChargingStop>>(
      `${env.apiBase}/stops/charging`,
      request,
      { timeoutMs: 20_000, retries: 1, signal: options.signal ?? null },
    );
  } catch (error) {
    throw toSearchError(error);
  }
}

export interface AmenitySearchOptions extends CorridorWindow {
  kinds: Array<'rest_area' | 'toilets'>;
  limit?: number;
  signal?: AbortSignal;
}

export async function searchAmenities(
  line: MeasuredLine,
  options: AmenitySearchOptions,
): Promise<SearchResponse<AmenityStop>> {
  const request: AmenitySearchRequest = {
    points: corridorPoints(line, options),
    radiusKm: options.radiusKm,
    kinds: options.kinds,
    limit: options.limit ?? 60,
  };
  try {
    return await postJson<SearchResponse<AmenityStop>>(
      `${env.apiBase}/stops/amenities`,
      request,
      { timeoutMs: 35_000, retries: 0, signal: options.signal ?? null },
    );
  } catch (error) {
    throw toSearchError(error);
  }
}

/* ------------------------------------------------------------------ *
 * Route-relative ranking
 * ------------------------------------------------------------------ */

export interface RankOptions {
  /** Current position along the route, in metres. */
  progressM: number;
  /** Ignore stops whose projection is behind this point. */
  minAheadM?: number;
  /** Ignore stops further ahead than this. */
  maxAheadM?: number;
  /** Ignore stops further than this from the route. */
  maxOffsetM: number;
  /** EUR per detour kilometre, used to price the detour against fuel savings. */
  detourCostPerKm: number;
  /** Which grade's price to rank fuel stops by. */
  fuel?: FuelKind;
  /** Only used for charging stops. */
  minPowerKw?: number;
}

/**
 * Positions a stop relative to the route: where along the route it is closest,
 * how far off the route it sits, and how much extra driving the detour costs.
 *
 * The snap deliberately searches the whole line rather than a window — a
 * candidate stop can be anywhere, and the corridor is already bounded by the
 * search radius.
 */
export function relateToRoute(
  line: MeasuredLine,
  stop: Stop,
  progressM: number,
): RouteRelation {
  const point = toPosition(stop.location);
  const snap = snapToLine(line, point);
  return {
    distanceAlongRouteM: snap.alongM,
    offsetFromRouteM: snap.offsetM,
    distanceAheadM: snap.alongM - progressM,
    // Leaving the route and rejoining it costs roughly the offset twice; the
    // 1.3 factor accounts for the fact that access roads are rarely direct.
    detourM: snap.offsetM * 2 * 1.3,
  };
}

/**
 * German decimal notation, to match every other number in the UI. `toFixed`
 * would emit `1.799` next to the `1,799 €` the price column shows.
 */
function formatEuro(value: number, digits: number): string {
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Cheapest price for the requested grade, or `null` when not sold. */
function priceOf(stop: FuelStop, fuel: FuelKind): number | null {
  const value = stop.prices[fuel];
  return value != null && Number.isFinite(value) ? value : null;
}

/**
 * Scores a stop; lower is better.
 *
 * For fuel we convert the detour into money (`detourCostPerKm`) and add it to
 * the litre price, so a station 8 km off the route has to be genuinely cheaper
 * to win. For chargers, power is what matters, so a high-power stop tolerates a
 * longer detour. Amenities are ranked purely by how soon you reach them.
 */
function scoreStop(
  stop: Stop,
  relation: RouteRelation,
  options: RankOptions,
): { score: number; note: string } {
  const detourKm = relation.detourM / 1000;

  if (stop.kind === 'fuel') {
    const fuel = options.fuel ?? 'e10';
    const price = priceOf(stop, fuel);
    if (price == null) {
      // Sorts after every station that does report a price, but stays visible.
      return { score: 100 + detourKm, note: 'Kein Preis gemeldet' };
    }
    const detourCost = detourKm * options.detourCostPerKm;
    return {
      score: price + detourCost,
      note:
        detourCost >= 0.005
          ? `${formatEuro(price, 3)} €/l + ${formatEuro(detourCost, 2)} € Umweg`
          : `${formatEuro(price, 3)} €/l, praktisch kein Umweg`,
    };
  }

  if (stop.kind === 'charging') {
    const power = stop.maxPowerKw ?? 0;
    // Normalise power onto a 0…1 penalty against a 300 kW reference.
    const powerPenalty = 1 - Math.min(1, power / 300);
    const detourPenalty = Math.min(1, detourKm / 20);
    const availability =
      stop.connectors.some((c) => (c.available ?? 1) > 0) ? 0 : 0.15;
    return {
      score: powerPenalty * 0.6 + detourPenalty * 0.4 + availability,
      note: power > 0 ? `bis ${Math.round(power)} kW` : 'Leistung unbekannt',
    };
  }

  return {
    score: Math.max(0, relation.distanceAheadM) / 1000 + detourKm,
    note: 'nach Entfernung',
  };
}

/** Filters candidates to the useful window ahead and sorts them by score. */
export function rankStops<T extends Stop>(
  line: MeasuredLine,
  stops: T[],
  options: RankOptions,
): RankedStop<T>[] {
  const minAhead = options.minAheadM ?? 500;
  const maxAhead = options.maxAheadM ?? Number.POSITIVE_INFINITY;

  const ranked: RankedStop<T>[] = [];
  for (const stop of stops) {
    const relation = relateToRoute(line, stop, options.progressM);
    if (relation.offsetFromRouteM > options.maxOffsetM) continue;
    if (relation.distanceAheadM < minAhead) continue;
    if (relation.distanceAheadM > maxAhead) continue;
    if (
      stop.kind === 'charging' &&
      options.minPowerKw != null &&
      options.minPowerKw > 0 &&
      (stop.maxPowerKw ?? 0) < options.minPowerKw
    ) {
      continue;
    }
    const { score, note } = scoreStop(stop, relation, options);
    ranked.push({ stop, relation, score, scoreNote: note });
  }

  ranked.sort((a, b) => a.score - b.score || a.relation.distanceAheadM - b.relation.distanceAheadM);
  return ranked;
}

/**
 * Removes stops that sit almost on top of each other. Overlapping circle
 * queries plus two charging sources produce visible duplicates (the same site
 * listed once per operator), which waste slots in a six-item list.
 */
export function dedupeNearby<T extends Stop>(
  stops: RankedStop<T>[],
  minSeparationM = 60,
): RankedStop<T>[] {
  const kept: RankedStop<T>[] = [];
  for (const candidate of stops) {
    const duplicate = kept.some(
      (other) =>
        other.stop.kind === candidate.stop.kind &&
        distanceM(toPosition(other.stop.location), toPosition(candidate.stop.location)) <
          minSeparationM,
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

export const STOP_KIND_LABELS: Record<StopKind, string> = {
  fuel: 'Tankstelle',
  charging: 'Ladesäule',
  rest_area: 'Rastplatz',
  toilets: 'Toilette',
};
