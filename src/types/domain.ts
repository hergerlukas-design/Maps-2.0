import type {
  ConnectorType,
  FuelKind,
  LngLat,
  Position,
  StopKind,
  VehicleKind,
} from '@shared/types';

/* ------------------------------------------------------------------ *
 * Vehicle profile
 * ------------------------------------------------------------------ */

export interface Vehicle {
  id: string;
  userId: string | null;
  name: string;
  kind: VehicleKind;
  /** Preferred grade; only meaningful for `combustion` and `hybrid`. */
  fuel: FuelKind | null;
  /** Connectors the car can use; only meaningful for `electric` and `hybrid`. */
  connectors: ConnectorType[];
  /** Typical full-tank / full-battery range in km, used to seed the slider. */
  typicalRangeKm: number | null;
  /** Consumption used to convert distance into remaining range. */
  consumption: {
    /** l/100 km for combustion, kWh/100 km for electric. */
    per100km: number | null;
  };
  isDefault: boolean;
  createdAt: string;
}

export function vehicleNeedsFuel(kind: VehicleKind): boolean {
  return kind === 'combustion' || kind === 'hybrid';
}

export function vehicleNeedsCharging(kind: VehicleKind): boolean {
  return kind === 'electric' || kind === 'hybrid';
}

/** Which stop kinds a vehicle can refuel/recharge at, in preference order. */
export function refuelStopKinds(kind: VehicleKind): Array<'fuel' | 'charging'> {
  switch (kind) {
    case 'combustion':
      return ['fuel'];
    case 'electric':
      return ['charging'];
    case 'hybrid':
      return ['fuel', 'charging'];
  }
}

/* ------------------------------------------------------------------ *
 * User settings — every number in the briefing is configurable here
 * ------------------------------------------------------------------ */

export interface Settings {
  /** Ask about refuelling once remaining range drops to this many km. */
  rangeThresholdKm: number;
  /** Corridor radius around the route to search in, in km. */
  searchRadiusKm: number;
  /** After a "Nein", ask again once this many km have been driven. */
  reAskIntervalKm: number;
  /** Max number of stop suggestions shown in the prompt. */
  maxSuggestions: number;
  /**
   * Wie viel Ersparnis ein Kilometer Umweg wert sein muss, in Cent pro Liter.
   *
   * Bei 0,5 muss eine Tankstelle 10 km abseits der Route mindestens 5 ct/l
   * günstiger sein, um vor einer Tankstelle direkt an der Route zu landen.
   */
  detourPenaltyCtPerKm: number;
  /** Prefer chargers with at least this power (kW); 0 disables the filter. */
  minChargingPowerKw: number;
  /** Speak turn instructions out loud. */
  voiceGuidance: boolean;
  /** Keep the screen awake while navigating. */
  keepScreenAwake: boolean;
  /** Send a push notification in addition to the in-app prompt. */
  pushNotifications: boolean;
  /** Avoid toll roads / motorways in route requests. */
  avoid: { tolls: boolean; motorways: boolean; ferries: boolean };
  units: 'metric';
}

export const DEFAULT_SETTINGS: Settings = {
  rangeThresholdKm: 215,
  searchRadiusKm: 12,
  reAskIntervalKm: 50,
  maxSuggestions: 6,
  // Grobe Herleitung: ~0,30 € Fahrzeugkosten je Umwegkilometer, verteilt auf
  // eine Tankfüllung von ~45 Litern, ergibt rund 0,7 ct/l je Kilometer. Etwas
  // darunter angesetzt, weil der Umweg auch Zeit kostet, die hier nicht zählt.
  detourPenaltyCtPerKm: 0.5,
  minChargingPowerKw: 50,
  voiceGuidance: true,
  keepScreenAwake: true,
  pushNotifications: true,
  avoid: { tolls: false, motorways: false, ferries: false },
  units: 'metric',
};

/** Bounds enforced by the settings UI and by `clampSettings`. */
export const SETTINGS_BOUNDS = {
  rangeThresholdKm: { min: 20, max: 600, step: 5 },
  searchRadiusKm: { min: 1, max: 25, step: 1 },
  reAskIntervalKm: { min: 5, max: 200, step: 5 },
  maxSuggestions: { min: 3, max: 12, step: 1 },
  detourPenaltyCtPerKm: { min: 0, max: 5, step: 0.1 },
  minChargingPowerKw: { min: 0, max: 350, step: 10 },
} as const;

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalises settings loaded from storage or Supabase. Anything out of range or
 * non-numeric falls back to the default so a bad row can never break the app.
 */
export function clampSettings(input: Partial<Settings> | null | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  const b = SETTINGS_BOUNDS;
  return {
    ...s,
    rangeThresholdKm: clampNumber(
      s.rangeThresholdKm,
      b.rangeThresholdKm.min,
      b.rangeThresholdKm.max,
      DEFAULT_SETTINGS.rangeThresholdKm,
    ),
    searchRadiusKm: clampNumber(
      s.searchRadiusKm,
      b.searchRadiusKm.min,
      b.searchRadiusKm.max,
      DEFAULT_SETTINGS.searchRadiusKm,
    ),
    reAskIntervalKm: clampNumber(
      s.reAskIntervalKm,
      b.reAskIntervalKm.min,
      b.reAskIntervalKm.max,
      DEFAULT_SETTINGS.reAskIntervalKm,
    ),
    maxSuggestions: Math.round(
      clampNumber(
        s.maxSuggestions,
        b.maxSuggestions.min,
        b.maxSuggestions.max,
        DEFAULT_SETTINGS.maxSuggestions,
      ),
    ),
    detourPenaltyCtPerKm: clampNumber(
      s.detourPenaltyCtPerKm,
      b.detourPenaltyCtPerKm.min,
      b.detourPenaltyCtPerKm.max,
      DEFAULT_SETTINGS.detourPenaltyCtPerKm,
    ),
    minChargingPowerKw: clampNumber(
      s.minChargingPowerKw,
      b.minChargingPowerKw.min,
      b.minChargingPowerKw.max,
      DEFAULT_SETTINGS.minChargingPowerKw,
    ),
    avoid: { ...DEFAULT_SETTINGS.avoid, ...(input?.avoid ?? {}) },
    units: 'metric',
  };
}

/* ------------------------------------------------------------------ *
 * Trip plan (what the user enters before starting navigation)
 * ------------------------------------------------------------------ */

export interface PlaceRef {
  id: string;
  name: string;
  /** Full address line as returned by geocoding. */
  address?: string;
  location: LngLat;
  /** Luftlinie zum Suchzeitpunkt-Standort, falls dieser bekannt war. */
  distanceM?: number;
}

export interface TripPlan {
  origin: PlaceRef;
  destination: PlaceRef;
  /** Manually entered remaining range in km — never read from the car. */
  remainingRangeKm: number;
  vehicle: Vehicle;
}

/* ------------------------------------------------------------------ *
 * Waypoints inserted into a running navigation session
 * ------------------------------------------------------------------ */

export interface StopWaypoint {
  /** The id of the underlying stop, or `destination` for the trip end. */
  id: string;
  kind: StopKind | 'destination' | 'origin';
  name: string;
  location: LngLat;
  /** Set when the user has driven past this waypoint. */
  reachedAt?: number;
}

/* ------------------------------------------------------------------ *
 * Favourites & history
 * ------------------------------------------------------------------ */

export interface FavouriteStop {
  id: string;
  userId: string;
  stopId: string;
  kind: StopKind;
  name: string;
  location: LngLat;
  note: string | null;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  userId: string;
  originName: string;
  destinationName: string;
  originLocation: LngLat;
  destinationLocation: LngLat;
  distanceM: number;
  durationS: number;
  /** Stops actually visited on the trip. */
  stops: Array<{ id: string; kind: StopKind; name: string }>;
  startedAt: string;
  finishedAt: string | null;
}

export type { ConnectorType, FuelKind, LngLat, Position, StopKind, VehicleKind };
