import { describe, expect, it } from 'vitest';
import {
  bearing,
  bearingDelta,
  decodePolyline,
  distanceM,
  measureLine,
  pointAtDistance,
  projectOnSegment,
  sampleAlong,
  simplify,
  sliceLine,
  snapToLine,
} from './geo';
import type { Position } from '@shared/types';

/** ~11 km of straight line heading east along the 50th parallel. */
const straight: Position[] = [
  [8.0, 50.0],
  [8.05, 50.0],
  [8.1, 50.0],
  [8.15, 50.0],
];

describe('distanceM', () => {
  it('is zero for identical points', () => {
    expect(distanceM([8, 50], [8, 50])).toBe(0);
  });

  it('matches a known reference distance', () => {
    // Frankfurt → Cologne, ~152 km great-circle.
    const d = distanceM([8.6821, 50.1109], [6.9603, 50.9375]);
    expect(d / 1000).toBeGreaterThan(150);
    expect(d / 1000).toBeLessThan(154);
  });

  it('is symmetric', () => {
    const a: Position = [8.6821, 50.1109];
    const b: Position = [11.5761, 48.1372];
    expect(distanceM(a, b)).toBeCloseTo(distanceM(b, a), 6);
  });
});

describe('bearing', () => {
  it('reads 90° due east and 0° due north', () => {
    expect(bearing([8, 50], [8.1, 50])).toBeCloseTo(90, 1);
    expect(bearing([8, 50], [8, 50.1])).toBeCloseTo(0, 1);
  });

  it('wraps correctly when comparing bearings', () => {
    expect(bearingDelta(350, 10)).toBeCloseTo(20, 6);
    expect(bearingDelta(10, 350)).toBeCloseTo(20, 6);
    expect(bearingDelta(0, 180)).toBeCloseTo(180, 6);
  });
});

describe('projectOnSegment', () => {
  it('clamps to the segment start when the point lies behind it', () => {
    const p = projectOnSegment([7.9, 50.0], [8.0, 50.0], [8.1, 50.0]);
    expect(p.t).toBe(0);
    expect(p.point).toEqual([8.0, 50.0]);
  });

  it('clamps to the segment end when the point lies beyond it', () => {
    const p = projectOnSegment([8.2, 50.0], [8.0, 50.0], [8.1, 50.0]);
    expect(p.t).toBe(1);
  });

  it('finds the perpendicular foot for a point beside the segment', () => {
    const p = projectOnSegment([8.05, 50.01], [8.0, 50.0], [8.1, 50.0]);
    expect(p.t).toBeCloseTo(0.5, 2);
    // 0.01° of latitude is ~1112 m.
    expect(p.distanceM).toBeGreaterThan(1090);
    expect(p.distanceM).toBeLessThan(1130);
  });

  it('handles a degenerate zero-length segment', () => {
    const p = projectOnSegment([8.05, 50.0], [8.0, 50.0], [8.0, 50.0]);
    expect(p.t).toBe(0);
    expect(p.distanceM).toBeGreaterThan(0);
  });
});

describe('measureLine', () => {
  it('accumulates distances monotonically', () => {
    const line = measureLine(straight);
    expect(line.cumulative[0]).toBe(0);
    for (let i = 1; i < line.cumulative.length; i++) {
      expect(line.cumulative[i]!).toBeGreaterThan(line.cumulative[i - 1]!);
    }
    expect(line.totalLengthM).toBeCloseTo(line.cumulative.at(-1)!, 6);
  });
});

describe('snapToLine', () => {
  const line = measureLine(straight);

  it('snaps a point beside the line onto it', () => {
    const snap = snapToLine(line, [8.05, 50.005]);
    expect(snap.offsetM).toBeGreaterThan(500);
    expect(snap.offsetM).toBeLessThan(600);
    expect(snap.alongM).toBeGreaterThan(0);
    expect(snap.segmentBearing).toBeCloseTo(90, 0);
  });

  it('respects the search window so it cannot match a later segment', () => {
    // Restrict the window to the first segment only.
    const snap = snapToLine(line, [8.14, 50.0], 0, 1);
    expect(snap.segmentIndex).toBe(0);
    expect(snap.alongM).toBeCloseTo(line.cumulative[1]!, 0);
  });
});

describe('pointAtDistance', () => {
  const line = measureLine(straight);

  it('returns the endpoints outside the line', () => {
    expect(pointAtDistance(line, -100)).toEqual(straight[0]);
    expect(pointAtDistance(line, line.totalLengthM + 100)).toEqual(straight.at(-1));
  });

  it('round-trips with snapToLine', () => {
    const target = line.totalLengthM * 0.42;
    const point = pointAtDistance(line, target);
    expect(snapToLine(line, point).alongM).toBeCloseTo(target, 0);
  });
});

describe('sliceLine', () => {
  it('returns a sub-line bounded by the requested distances', () => {
    const line = measureLine(straight);
    const slice = sliceLine(line, 1000, 5000);
    const sliced = measureLine(slice);
    expect(sliced.totalLengthM).toBeCloseTo(4000, 0);
  });
});

describe('sampleAlong', () => {
  const line = measureLine(straight);

  it('spaces samples no wider than the requested spacing', () => {
    const points = sampleAlong(line, 0, line.totalLengthM, 2000);
    expect(points.length).toBeGreaterThan(1);
    for (let i = 1; i < points.length; i++) {
      expect(distanceM(points[i - 1]!, points[i]!)).toBeLessThanOrEqual(2001);
    }
  });

  it('never exceeds the point cap', () => {
    const points = sampleAlong(line, 0, line.totalLengthM, 10, 5);
    expect(points).toHaveLength(5);
  });

  it('returns a single point for a zero-length window', () => {
    expect(sampleAlong(line, 500, 500, 1000)).toHaveLength(1);
  });
});

describe('decodePolyline', () => {
  it('decodes a precision-5 polyline', () => {
    // Reference string from the Google encoded-polyline specification.
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(decoded).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('scales by the precision factor', () => {
    // Directions is asked for `polyline6`; the same bytes decoded at precision 6
    // must yield exactly one tenth of the precision-5 values.
    const reference = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const p5 = decodePolyline(reference, 5);
    const p6 = decodePolyline(reference, 6);
    expect(p6).toHaveLength(p5.length);
    for (const [i, coord] of p6.entries()) {
      expect(coord[0]).toBeCloseTo(p5[i]![0] / 10, 9);
      expect(coord[1]).toBeCloseTo(p5[i]![1] / 10, 9);
    }
  });
});

describe('simplify', () => {
  it('drops collinear vertices but keeps the endpoints', () => {
    const dense: Position[] = [];
    for (let i = 0; i <= 100; i++) dense.push([8 + i * 0.001, 50]);
    const result = simplify(dense, 5);
    expect(result.length).toBeLessThan(dense.length);
    expect(result[0]).toEqual(dense[0]);
    expect(result.at(-1)).toEqual(dense.at(-1));
  });

  it('keeps a vertex that deviates beyond the tolerance', () => {
    const withSpike: Position[] = [
      [8.0, 50.0],
      [8.05, 50.01],
      [8.1, 50.0],
    ];
    expect(simplify(withSpike, 50)).toHaveLength(3);
  });
});
