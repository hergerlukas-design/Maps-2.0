import type { LngLat, Position } from '@shared/types';
import { env } from '@/config/env';
import { fetchJson, HttpError } from '@/lib/http';
import { decodePolyline, measureLine, type MeasuredLine } from '@/lib/geo';
import type {
  MapboxBannerInstruction,
  MapboxDirectionsResponse,
  MapboxStep,
  MapboxVoiceInstruction,
} from './types';

const DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox';
const POLYLINE_PRECISION = 6;

/* ------------------------------------------------------------------ *
 * Normalised route model used everywhere in the app
 * ------------------------------------------------------------------ */

export interface RouteStep {
  /** Index within the flattened step list of the whole route. */
  index: number;
  /** Index of the leg this step belongs to. */
  legIndex: number;
  distanceM: number;
  durationS: number;
  /** Plain-text instruction, e.g. "Fahren Sie rechts auf die A5". */
  instruction: string;
  /** Maneuver type/modifier, used to pick the turn icon. */
  maneuver: { type: string; modifier?: string; exit?: number };
  /** Road name for this step. */
  name: string;
  ref?: string;
  destinations?: string;
  location: Position;
  geometry: Position[];
  /** Metres from the route start to the beginning of this step. */
  startAlongM: number;
  /** Metres from the route start to the end of this step. */
  endAlongM: number;
  banners: MapboxBannerInstruction[];
  voice: MapboxVoiceInstruction[];
  lanes: Array<{ valid: boolean; active: boolean; indications: string[] }> | null;
}

export interface RouteLeg {
  index: number;
  distanceM: number;
  durationS: number;
  summary: string;
  /** Metres from the route start to the end of this leg (= the waypoint). */
  endAlongM: number;
  stepRange: [start: number, endExclusive: number];
}

export interface NavRoute {
  distanceM: number;
  durationS: number;
  /** Duration ignoring live traffic, when the profile provides it. */
  typicalDurationS: number | null;
  geometry: Position[];
  line: MeasuredLine;
  steps: RouteStep[];
  legs: RouteLeg[];
  /** Waypoint coordinates echoed by the API, snapped to the road network. */
  waypoints: Array<{ name: string; location: Position }>;
  profile: DirectionsProfile;
  requestedAt: number;
}

export type DirectionsProfile = 'driving-traffic' | 'driving';

export interface DirectionsOptions {
  profile?: DirectionsProfile;
  avoid?: { tolls?: boolean; motorways?: boolean; ferries?: boolean };
  /** Bearing of travel at the first waypoint; improves the initial match. */
  originBearing?: number | null;
  signal?: AbortSignal;
  language?: string;
}

export class DirectionsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no_token'
      | 'no_route'
      | 'too_many_waypoints'
      | 'rate_limited'
      | 'upstream',
  ) {
    super(message);
    this.name = 'DirectionsError';
  }
}

/** Mapbox Directions allows at most 25 coordinates per request. */
export const MAX_WAYPOINTS = 25;

function excludeParam(avoid: DirectionsOptions['avoid']): string | null {
  const parts: string[] = [];
  if (avoid?.tolls) parts.push('toll');
  if (avoid?.motorways) parts.push('motorway');
  if (avoid?.ferries) parts.push('ferry');
  return parts.length > 0 ? parts.join(',') : null;
}

function flattenLanes(step: MapboxStep) {
  // Mapbox repeats lane info on every intersection of a step; the lanes that
  // matter for the banner are the ones at the intersection where the turn is.
  const withLanes = step.intersections?.filter((i) => i.lanes && i.lanes.length > 0);
  const last = withLanes?.[withLanes.length - 1];
  if (!last?.lanes) return null;
  return last.lanes.map((lane) => ({
    valid: lane.valid,
    active: lane.active ?? false,
    indications: lane.indications,
  }));
}

/**
 * Requests a route through the given waypoints and normalises it.
 *
 * `waypoints` must contain at least an origin and a destination. Intermediate
 * entries become the fuel/charging stops the user picked, which is how a stop
 * gets folded into the running navigation rather than replacing it.
 */
export async function fetchRoute(
  waypoints: LngLat[],
  options: DirectionsOptions = {},
): Promise<NavRoute> {
  if (!env.mapboxToken) {
    throw new DirectionsError(
      'Kein Mapbox-Token konfiguriert (VITE_MAPBOX_TOKEN).',
      'no_token',
    );
  }
  if (waypoints.length < 2) {
    throw new DirectionsError('Mindestens Start und Ziel werden benötigt.', 'no_route');
  }
  if (waypoints.length > MAX_WAYPOINTS) {
    throw new DirectionsError(
      `Mapbox erlaubt maximal ${MAX_WAYPOINTS} Wegpunkte pro Route.`,
      'too_many_waypoints',
    );
  }

  const profile = options.profile ?? 'driving-traffic';
  const coords = waypoints
    .map((w) => `${w.lng.toFixed(6)},${w.lat.toFixed(6)}`)
    .join(';');

  const params = new URLSearchParams({
    access_token: env.mapboxToken,
    alternatives: 'false',
    geometries: 'polyline6',
    overview: 'full',
    steps: 'true',
    banner_instructions: 'true',
    voice_instructions: 'true',
    voice_units: 'metric',
    roundabout_exits: 'true',
    language: options.language ?? 'de',
    annotations: 'distance,duration',
  });

  const exclude = excludeParam(options.avoid);
  if (exclude) params.set('exclude', exclude);

  if (options.originBearing != null && Number.isFinite(options.originBearing)) {
    // `bearings` needs one entry per waypoint; only the first is constrained.
    const bearings = waypoints.map((_, i) =>
      i === 0 ? `${Math.round(options.originBearing!)},60` : '',
    );
    params.set('bearings', bearings.join(';'));
  }

  let response: MapboxDirectionsResponse;
  try {
    response = await fetchJson<MapboxDirectionsResponse>(
      `${DIRECTIONS_BASE}/${profile}/${coords}?${params.toString()}`,
      { timeoutMs: 15_000, retries: 1, signal: options.signal ?? null },
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      throw new DirectionsError(
        'Mapbox-Ratenlimit erreicht. Bitte kurz warten.',
        'rate_limited',
      );
    }
    throw new DirectionsError(
      error instanceof Error ? error.message : 'Routenabfrage fehlgeschlagen.',
      'upstream',
    );
  }

  if (response.code !== 'Ok' || response.routes.length === 0) {
    throw new DirectionsError(
      response.code === 'NoRoute'
        ? 'Für diese Punkte konnte keine Route berechnet werden.'
        : (response.message ?? 'Keine Route gefunden.'),
      'no_route',
    );
  }

  return normaliseRoute(response, profile);
}

function normaliseRoute(
  response: MapboxDirectionsResponse,
  profile: DirectionsProfile,
): NavRoute {
  const raw = response.routes[0]!;
  const geometry = decodePolyline(raw.geometry, POLYLINE_PRECISION);
  const line = measureLine(geometry);

  const steps: RouteStep[] = [];
  const legs: RouteLeg[] = [];
  let along = 0;

  raw.legs.forEach((leg, legIndex) => {
    const stepStart = steps.length;
    leg.steps.forEach((step) => {
      const stepGeometry = decodePolyline(step.geometry, POLYLINE_PRECISION);
      const startAlongM = along;
      along += step.distance;
      steps.push({
        index: steps.length,
        legIndex,
        distanceM: step.distance,
        durationS: step.duration,
        instruction: step.maneuver.instruction,
        maneuver: {
          type: step.maneuver.type,
          ...(step.maneuver.modifier ? { modifier: step.maneuver.modifier } : {}),
          ...(step.maneuver.exit != null ? { exit: step.maneuver.exit } : {}),
        },
        name: step.name,
        ...(step.ref ? { ref: step.ref } : {}),
        ...(step.destinations ? { destinations: step.destinations } : {}),
        location: step.maneuver.location,
        geometry: stepGeometry,
        startAlongM,
        endAlongM: along,
        banners: step.bannerInstructions ?? [],
        voice: step.voiceInstructions ?? [],
        lanes: flattenLanes(step),
      });
    });
    legs.push({
      index: legIndex,
      distanceM: leg.distance,
      durationS: leg.duration,
      summary: leg.summary,
      endAlongM: along,
      stepRange: [stepStart, steps.length],
    });
  });

  // Cumulative step distances and the decoded polyline length drift by a few
  // metres. Trust the polyline, since every snap is measured against it.
  const scale = along > 0 ? line.totalLengthM / along : 1;
  if (Math.abs(scale - 1) > 0.0001) {
    for (const step of steps) {
      step.startAlongM *= scale;
      step.endAlongM *= scale;
    }
    for (const leg of legs) leg.endAlongM *= scale;
  }

  return {
    distanceM: raw.distance,
    durationS: raw.duration,
    typicalDurationS: raw.duration_typical ?? null,
    geometry,
    line,
    steps,
    legs,
    waypoints: response.waypoints.map((w) => ({ name: w.name, location: w.location })),
    profile,
    requestedAt: Date.now(),
  };
}
