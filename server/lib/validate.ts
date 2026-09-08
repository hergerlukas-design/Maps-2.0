import type { CorridorRequest, Position } from '../../shared/types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

export interface ParsedCorridor {
  points: Position[];
  radiusKm: number;
  limit: number;
}

/** Upper bound on corridor points per request, to keep upstream fan-out sane. */
export const MAX_CORRIDOR_POINTS = 24;

export function parseCorridor(
  body: unknown,
  maxRadiusKm: number,
): ParsedCorridor {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Request-Body muss ein JSON-Objekt sein.');
  }
  const raw = body as Partial<CorridorRequest>;

  if (!Array.isArray(raw.points) || raw.points.length === 0) {
    throw new ValidationError('`points` muss mindestens eine Koordinate enthalten.');
  }
  if (raw.points.length > MAX_CORRIDOR_POINTS) {
    throw new ValidationError(
      `\`points\` darf höchstens ${MAX_CORRIDOR_POINTS} Koordinaten enthalten.`,
    );
  }
  const points: Position[] = [];
  for (const point of raw.points) {
    if (!isPosition(point)) {
      throw new ValidationError('`points` enthält eine ungültige [lng, lat]-Koordinate.');
    }
    points.push([point[0], point[1]]);
  }

  const radius = typeof raw.radiusKm === 'number' ? raw.radiusKm : NaN;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new ValidationError('`radiusKm` muss eine positive Zahl sein.');
  }

  const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? raw.limit : 40;

  return {
    points,
    radiusKm: Math.min(maxRadiusKm, radius),
    limit: Math.min(200, Math.max(1, Math.round(limit))),
  };
}

/**
 * Drops corridor points whose circles are already covered by an earlier point.
 * Sampling the route at slightly-under-2r spacing plus this filter keeps the
 * upstream fan-out to the minimum that still covers the whole corridor.
 */
export function dedupeCorridorPoints(
  points: Position[],
  radiusKm: number,
): Position[] {
  const minSeparationKm = radiusKm * 1.2;
  const kept: Position[] = [];
  for (const point of points) {
    const tooClose = kept.some(
      (other) => haversineKm(other, point) < minSeparationKm,
    );
    if (!tooClose) kept.push(point);
  }
  return kept.length > 0 ? kept : points.slice(0, 1);
}

export function haversineKm(a: Position, b: Position): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
