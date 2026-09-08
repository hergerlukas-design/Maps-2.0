import type { LngLat, Position } from '@shared/types';

export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function toPosition(p: LngLat): Position {
  return [p.lng, p.lat];
}

export function toLngLat(p: Position): LngLat {
  return { lng: p[0], lat: p[1] };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: Position, b: Position): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from north. */
export function bearing(a: Position, b: Position): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, in degrees (0…180). */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/**
 * Local equirectangular projection around `origin`, in metres. Accurate enough
 * for the few-kilometre neighbourhoods we do segment math in, and much cheaper
 * than repeated haversine calls.
 */
function projectMeters(p: Position, origin: Position): [number, number] {
  const latRef = toRad(origin[1]);
  const x = toRad(p[0] - origin[0]) * Math.cos(latRef) * EARTH_RADIUS_M;
  const y = toRad(p[1] - origin[1]) * EARTH_RADIUS_M;
  return [x, y];
}

function unprojectMeters(xy: [number, number], origin: Position): Position {
  const latRef = toRad(origin[1]);
  const lng = origin[0] + toDeg(xy[0] / (EARTH_RADIUS_M * Math.cos(latRef)));
  const lat = origin[1] + toDeg(xy[1] / EARTH_RADIUS_M);
  return [lng, lat];
}

export interface SegmentProjection {
  /** Closest point on the segment. */
  point: Position;
  /** Metres from `point` to the queried point. */
  distanceM: number;
  /** Position along the segment, 0 at `a`, 1 at `b`. */
  t: number;
}

/** Projects `p` onto segment `a`→`b`, clamped to the segment ends. */
export function projectOnSegment(
  p: Position,
  a: Position,
  b: Position,
): SegmentProjection {
  const pa = projectMeters(p, a);
  const ba = projectMeters(b, a);
  const lenSq = ba[0] * ba[0] + ba[1] * ba[1];
  if (lenSq === 0) {
    return { point: a, distanceM: distanceM(p, a), t: 0 };
  }
  const t = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1]) / lenSq));
  const closest = unprojectMeters([ba[0] * t, ba[1] * t], a);
  return { point: closest, distanceM: distanceM(p, closest), t };
}

/* ------------------------------------------------------------------ *
 * Polylines with pre-computed cumulative distances
 * ------------------------------------------------------------------ */

/**
 * A route geometry plus the cumulative distance to each vertex. Building this
 * once turns "how far along the route am I?" into a cheap local search.
 */
export interface MeasuredLine {
  coordinates: Position[];
  /** `cumulative[i]` = metres from the first vertex to vertex `i`. */
  cumulative: number[];
  totalLengthM: number;
}

export function measureLine(coordinates: Position[]): MeasuredLine {
  const cumulative: number[] = new Array(coordinates.length);
  let running = 0;
  for (let i = 0; i < coordinates.length; i++) {
    if (i === 0) {
      cumulative[i] = 0;
      continue;
    }
    running += distanceM(coordinates[i - 1]!, coordinates[i]!);
    cumulative[i] = running;
  }
  return { coordinates, cumulative, totalLengthM: running };
}

export interface LineSnap {
  /** Closest point on the line. */
  point: Position;
  /** Metres between the queried point and the line. */
  offsetM: number;
  /** Metres along the line to the snapped point. */
  alongM: number;
  /** Index of the segment start vertex. */
  segmentIndex: number;
  /** Bearing of the matched segment, in degrees. */
  segmentBearing: number;
}

/**
 * Snaps a point onto a measured line.
 *
 * `searchFrom`/`searchTo` bound the vertex range to test. During navigation we
 * pass a window around the last known position, which keeps each GPS tick O(1)
 * instead of O(route length) and stops the snap from jumping to a later part of
 * the route that happens to pass nearby (cloverleafs, out-and-back legs).
 */
export function snapToLine(
  line: MeasuredLine,
  p: Position,
  searchFrom = 0,
  searchTo = line.coordinates.length - 1,
): LineSnap {
  const coords = line.coordinates;
  const from = Math.max(0, Math.min(searchFrom, coords.length - 2));
  const to = Math.min(coords.length - 1, Math.max(searchTo, from + 1));

  let best: LineSnap = {
    point: coords[from]!,
    offsetM: Number.POSITIVE_INFINITY,
    alongM: line.cumulative[from]!,
    segmentIndex: from,
    segmentBearing: 0,
  };

  for (let i = from; i < to; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const proj = projectOnSegment(p, a, b);
    if (proj.distanceM < best.offsetM) {
      const segLength = line.cumulative[i + 1]! - line.cumulative[i]!;
      best = {
        point: proj.point,
        offsetM: proj.distanceM,
        alongM: line.cumulative[i]! + segLength * proj.t,
        segmentIndex: i,
        segmentBearing: bearing(a, b),
      };
    }
  }
  return best;
}

/** The point `alongM` metres into the line, clamped to its ends. */
export function pointAtDistance(line: MeasuredLine, alongM: number): Position {
  const coords = line.coordinates;
  if (coords.length === 0) throw new Error('pointAtDistance: empty line');
  if (alongM <= 0) return coords[0]!;
  if (alongM >= line.totalLengthM) return coords[coords.length - 1]!;

  // Binary search for the segment containing `alongM`.
  let lo = 0;
  let hi = coords.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line.cumulative[mid]! <= alongM) lo = mid;
    else hi = mid;
  }
  const segStart = line.cumulative[lo]!;
  const segLength = line.cumulative[hi]! - segStart;
  const t = segLength === 0 ? 0 : (alongM - segStart) / segLength;
  const a = coords[lo]!;
  const b = coords[hi]!;
  const ba = projectMeters(b, a);
  return unprojectMeters([ba[0] * t, ba[1] * t], a);
}

/** The slice of the line between two distances along it. */
export function sliceLine(
  line: MeasuredLine,
  fromM: number,
  toM: number,
): Position[] {
  const start = Math.max(0, Math.min(fromM, line.totalLengthM));
  const end = Math.max(start, Math.min(toM, line.totalLengthM));
  const out: Position[] = [pointAtDistance(line, start)];
  for (let i = 0; i < line.coordinates.length; i++) {
    const d = line.cumulative[i]!;
    if (d > start && d < end) out.push(line.coordinates[i]!);
  }
  out.push(pointAtDistance(line, end));
  return out;
}

/**
 * Evenly spaced sample points along a stretch of the route. These become the
 * circle centres for the corridor searches (Tankerkönig, Overpass and the
 * charging APIs all take a centre + radius, not a corridor).
 *
 * `spacingM` should be a bit under twice the search radius so consecutive
 * circles overlap and no station in the corridor is missed.
 */
export function sampleAlong(
  line: MeasuredLine,
  fromM: number,
  toM: number,
  spacingM: number,
  maxPoints = 24,
): Position[] {
  const start = Math.max(0, Math.min(fromM, line.totalLengthM));
  const end = Math.max(start, Math.min(toM, line.totalLengthM));
  const span = end - start;
  if (span <= 0) return [pointAtDistance(line, start)];

  // `ceil` (not `floor`) so the resulting step never exceeds `spacingM`: with
  // `floor`, an 11.1 km span at 2 km spacing would produce 6 points 2.22 km
  // apart, leaving gaps between the search circles.
  const wanted = Math.ceil(span / Math.max(1, spacingM)) + 1;
  const count = Math.min(maxPoints, Math.max(2, wanted));
  const step = count === 1 ? 0 : span / (count - 1);

  const points: Position[] = [];
  for (let i = 0; i < count; i++) {
    points.push(pointAtDistance(line, start + step * i));
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * Bounding boxes
 * ------------------------------------------------------------------ */

export type BBox = [west: number, south: number, east: number, north: number];

export function boundsOf(points: Position[], padRatio = 0): BBox | null {
  if (points.length === 0) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const [lng, lat] of points) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (padRatio > 0) {
    const padLng = Math.max((east - west) * padRatio, 0.002);
    const padLat = Math.max((north - south) * padRatio, 0.002);
    west -= padLng;
    east += padLng;
    south -= padLat;
    north += padLat;
  }
  return [west, south, east, north];
}

/** Degrees of longitude that span `meters` at the given latitude. */
export function metersToLngDegrees(meters: number, atLat: number): number {
  const scale = Math.cos(toRad(atLat));
  return toDeg(meters / (EARTH_RADIUS_M * Math.max(0.01, scale)));
}

export function metersToLatDegrees(meters: number): number {
  return toDeg(meters / EARTH_RADIUS_M);
}

/* ------------------------------------------------------------------ *
 * Encoded polyline (Mapbox returns `polyline6` by default for Directions)
 * ------------------------------------------------------------------ */

/**
 * Decodes a Google/Mapbox encoded polyline. `precision` is 5 for `polyline`
 * and 6 for `polyline6`.
 */
export function decodePolyline(encoded: string, precision = 6): Position[] {
  const factor = 10 ** precision;
  const coordinates: Position[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

/** Drops vertices that sit within `toleranceM` of the line they bridge. */
export function simplify(points: Position[], toleranceM = 8): Position[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = projectOnSegment(points[i]!, points[first]!, points[last]!).distanceM;
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > toleranceM) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
