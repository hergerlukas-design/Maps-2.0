/**
 * Types shared between the browser app and the Express API layer.
 * Keep this file dependency-free so it can be compiled by both tsconfigs.
 */

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export interface LngLat {
  lng: number;
  lat: number;
}

/** GeoJSON-style `[lng, lat]` pair, the order Mapbox and Turf both use. */
export type Position = [number, number];

/* ------------------------------------------------------------------ *
 * Vehicles & fuel
 * ------------------------------------------------------------------ */

export type VehicleKind = 'combustion' | 'electric' | 'hybrid';

/** The three fuel grades Tankerkönig reports. */
export type FuelKind = 'e5' | 'e10' | 'diesel';

export const FUEL_KINDS: readonly FuelKind[] = ['e5', 'e10', 'diesel'];

export const FUEL_LABELS: Record<FuelKind, string> = {
  e5: 'Super E5',
  e10: 'Super E10',
  diesel: 'Diesel',
};

export type ConnectorType =
  | 'ccs'
  | 'chademo'
  | 'type2'
  | 'type2_socket'
  | 'tesla_supercharger'
  | 'schuko'
  | 'other';

export const CONNECTOR_LABELS: Record<ConnectorType, string> = {
  ccs: 'CCS',
  chademo: 'CHAdeMO',
  type2: 'Typ 2 (Kabel)',
  type2_socket: 'Typ 2 (Dose)',
  tesla_supercharger: 'Tesla Supercharger',
  schuko: 'Schuko',
  other: 'Sonstige',
};

/* ------------------------------------------------------------------ *
 * Stops (fuel stations, chargers, rest areas, toilets)
 * ------------------------------------------------------------------ */

export type StopKind = 'fuel' | 'charging' | 'rest_area' | 'toilets';

export type StopSource =
  | 'tankerkoenig'
  | 'goingelectric'
  | 'openchargemap'
  | 'overpass';

export interface StopAddress {
  street?: string;
  houseNumber?: string;
  postcode?: string;
  city?: string;
}

interface StopBase {
  /** Stable id, prefixed with the source (e.g. `tankerkoenig:4429…`). */
  id: string;
  kind: StopKind;
  name: string;
  brand?: string;
  location: LngLat;
  address?: StopAddress;
  source: StopSource;
  /** `null` when the source does not report opening state. */
  isOpen?: boolean | null;
}

export interface FuelStop extends StopBase {
  kind: 'fuel';
  /** Price in EUR per litre; `null` when the grade is not sold/reported. */
  prices: Partial<Record<FuelKind, number | null>>;
}

export interface ChargingConnector {
  type: ConnectorType;
  powerKw: number | null;
  count: number;
  /** `null` when the source has no live availability. */
  available?: number | null;
}

export interface ChargingStop extends StopBase {
  kind: 'charging';
  connectors: ChargingConnector[];
  maxPowerKw: number | null;
  operator?: string;
}

export interface AmenityStop extends StopBase {
  kind: 'rest_area' | 'toilets';
  wheelchair?: boolean | null;
  /** `true` when a fee is charged, `false` when free, `null` when unknown. */
  fee?: boolean | null;
  openingHours?: string;
}

export type Stop = FuelStop | ChargingStop | AmenityStop;

/* ------------------------------------------------------------------ *
 * Route-relative ranking (computed in the browser against the live route)
 * ------------------------------------------------------------------ */

export interface RouteRelation {
  /** Metres from the route origin to the point where the stop is closest. */
  distanceAlongRouteM: number;
  /** Straight-line metres between the stop and that closest route point. */
  offsetFromRouteM: number;
  /** Metres of route left to drive before reaching the stop's projection. */
  distanceAheadM: number;
  /** Rough extra driving distance for the detour (there and back). */
  detourM: number;
}

export interface RankedStop<T extends Stop = Stop> {
  stop: T;
  relation: RouteRelation;
  /** Lower is better. Combines price/power with detour cost. */
  score: number;
  /** Human-readable reason the stop scored where it did. */
  scoreNote?: string;
}

/* ------------------------------------------------------------------ *
 * API request / response contracts
 * ------------------------------------------------------------------ */

/** A sampled route corridor: the points the API searches around. */
export interface CorridorRequest {
  /** Sampled route points, ordered from origin to destination. */
  points: Position[];
  /** Search radius around each point, in kilometres. */
  radiusKm: number;
  /** Cap on returned stops. */
  limit?: number;
}

export interface FuelSearchRequest extends CorridorRequest {
  fuel: FuelKind;
}

export interface ChargingSearchRequest extends CorridorRequest {
  connectors?: ConnectorType[];
  minPowerKw?: number;
}

export interface AmenitySearchRequest extends CorridorRequest {
  kinds: Array<'rest_area' | 'toilets'>;
}

export interface SearchMeta {
  sources: StopSource[];
  /** Number of corridor points actually queried after de-duplication. */
  queriedPoints: number;
  /** True when every upstream response came from the server-side cache. */
  cached: boolean;
  /** Non-fatal problems (missing key, upstream timeout, partial results). */
  warnings: string[];
}

export interface SearchResponse<T extends Stop = Stop> {
  stops: T[];
  meta: SearchMeta;
}

export interface ApiErrorBody {
  error: {
    code:
      | 'bad_request'
      | 'not_configured'
      | 'upstream_error'
      | 'rate_limited'
      | 'internal';
    message: string;
    /** Present when the caller can retry after a delay, in seconds. */
    retryAfter?: number;
  };
}

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

export interface PushConfigResponse {
  /** VAPID public key, or `null` when push is not configured on the server. */
  publicKey: string | null;
}

export interface PushSubscribeRequest {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number | null;
  };
  userId?: string;
}

/** Payload the service worker receives in a `push` event. */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  /** Deep-link path opened when the notification is clicked. */
  url?: string;
  actions?: Array<{ action: string; title: string }>;
  data?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Server capability probe (drives the UI's "was fehlt noch?" hints)
 * ------------------------------------------------------------------ */

export interface CapabilitiesResponse {
  fuelPrices: boolean;
  charging: { goingelectric: boolean; openchargemap: boolean };
  amenities: boolean;
  push: boolean;
}
