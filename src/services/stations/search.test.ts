import { describe, expect, it } from 'vitest';
import type { ChargingStop, FuelStop, Position } from '@shared/types';
import { distanceM, measureLine } from '@/lib/geo';
import { corridorPoints, dedupeNearby, rankStops, relateToRoute } from './search';

/** ~22 km of straight route heading east along the 50th parallel. */
const coordinates: Position[] = [];
for (let i = 0; i <= 200; i++) coordinates.push([8 + i * 0.001, 50]);
const line = measureLine(coordinates);

const DEG_PER_M = 1 / 111_320;

function fuelStop(
  id: string,
  atLng: number,
  offsetM: number,
  prices: Partial<Record<'e5' | 'e10' | 'diesel', number | null>>,
): FuelStop {
  return {
    id,
    kind: 'fuel',
    name: id,
    location: { lng: atLng, lat: 50 + offsetM * DEG_PER_M },
    source: 'tankerkoenig',
    isOpen: true,
    prices,
  };
}

function chargingStop(
  id: string,
  atLng: number,
  offsetM: number,
  maxPowerKw: number,
): ChargingStop {
  return {
    id,
    kind: 'charging',
    name: id,
    location: { lng: atLng, lat: 50 + offsetM * DEG_PER_M },
    source: 'goingelectric',
    isOpen: null,
    maxPowerKw,
    connectors: [{ type: 'ccs', powerKw: maxPowerKw, count: 2, available: null }],
  };
}

const BASE = {
  progressM: 0,
  maxOffsetM: 15_000,
  // 0,5 ct/l je Umwegkilometer: Eine Tankstelle 10 km abseits muss mindestens
  // 5 ct/l günstiger sein, um zu gewinnen.
  detourPenaltyCtPerKm: 0.5,
  fuel: 'e10' as const,
};

describe('corridorPoints', () => {
  it('overlaps consecutive circles so nothing in the corridor is missed', () => {
    const radiusKm = 10;
    const points = corridorPoints(line, { fromM: 0, toM: line.totalLengthM, radiusKm });
    for (let i = 1; i < points.length; i++) {
      // Spacing below 2 × radius means the circles overlap rather than abut.
      expect(distanceM(points[i - 1]!, points[i]!)).toBeLessThan(radiusKm * 2000);
    }
  });
});

describe('relateToRoute', () => {
  it('measures how far ahead a stop is and how far off the route it sits', () => {
    const stop = fuelStop('a', 8.05, 500, { e10: 1.7 });
    const relation = relateToRoute(line, stop, 1000);
    expect(relation.offsetFromRouteM).toBeGreaterThan(450);
    expect(relation.offsetFromRouteM).toBeLessThan(550);
    expect(relation.distanceAheadM).toBeCloseTo(relation.distanceAlongRouteM - 1000, 0);
    // The detour is the offset there and back, plus an allowance for access roads.
    expect(relation.detourM).toBeGreaterThan(relation.offsetFromRouteM * 2);
  });
});

describe('rankStops', () => {
  it('prefers the cheaper station when both sit on the route', () => {
    const ranked = rankStops(
      line,
      [
        fuelStop('teuer', 8.05, 20, { e10: 1.879 }),
        fuelStop('guenstig', 8.06, 20, { e10: 1.749 }),
      ],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('guenstig');
  });

  it('lässt einen großen Umweg verlieren, wenn die Ersparnis klein ist', () => {
    // 8 km abseits ergeben ~20,8 km Umweg, also gut 10 ct/l Aufschlag.
    // Eine Ersparnis von 5 ct/l trägt das nicht.
    const ranked = rankStops(
      line,
      [
        fuelStop('billig-weit', 8.05, 8000, { e10: 1.749 }),
        fuelStop('teurer-nah', 8.06, 30, { e10: 1.799 }),
      ],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('teurer-nah');
  });

  it('lässt einen großen Umweg gewinnen, wenn die Ersparnis groß genug ist', () => {
    // Derselbe Umweg, aber 20 ct/l günstiger — das lohnt sich.
    //
    // Genau dieser Fall war vorher unmöglich: Der Aufschlag wurde in Euro auf
    // einen Preis pro Liter addiert, wodurch jeder nennenswerte Umweg jede
    // Preisersparnis überstimmte.
    const ranked = rankStops(
      line,
      [
        fuelStop('billig-weit', 8.05, 8000, { e10: 1.599 }),
        fuelStop('teurer-nah', 8.06, 30, { e10: 1.799 }),
      ],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('billig-weit');
  });

  it('keeps the cheap station when the detour is small enough to pay off', () => {
    const ranked = rankStops(
      line,
      [
        fuelStop('billig-nah', 8.05, 300, { e10: 1.649 }),
        fuelStop('teurer-nah', 8.06, 30, { e10: 1.799 }),
      ],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('billig-nah');
  });

  it('ignoriert den Umweg vollständig, wenn der Aufschlag auf 0 steht', () => {
    const ranked = rankStops(
      line,
      [
        fuelStop('billig-sehr-weit', 8.05, 12_000, { e10: 1.749 }),
        fuelStop('teurer-nah', 8.06, 30, { e10: 1.799 }),
      ],
      { ...BASE, detourPenaltyCtPerKm: 0 },
    );
    expect(ranked[0]?.stop.id).toBe('billig-sehr-weit');
  });

  it('ranks stations without a reported price last but still lists them', () => {
    const ranked = rankStops(
      line,
      [
        fuelStop('ohne-preis', 8.03, 20, { e10: null, diesel: 1.6 }),
        fuelStop('mit-preis', 8.06, 20, { e10: 1.899 }),
      ],
      BASE,
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.stop.id).toBe('mit-preis');
    expect(ranked[1]?.scoreNote).toContain('Kein Preis');
  });

  it('drops stops behind the driver', () => {
    const ranked = rankStops(
      line,
      [
        fuelStop('hinten', 8.01, 20, { e10: 1.5 }),
        fuelStop('vorne', 8.15, 20, { e10: 1.9 }),
      ],
      { ...BASE, progressM: 8000 },
    );
    expect(ranked.map((r) => r.stop.id)).toEqual(['vorne']);
  });

  it('drops stops beyond the search corridor', () => {
    const stops = [fuelStop('weit-weg', 8.05, 20_000, { e10: 1.5 })];
    expect(rankStops(line, stops, { ...BASE, maxOffsetM: 12_000 })).toHaveLength(0);
  });

  it('drops stops further ahead than the window allows', () => {
    const stops = [fuelStop('zu-weit', 8.18, 20, { e10: 1.5 })];
    expect(rankStops(line, stops, { ...BASE, maxAheadM: 5000 })).toHaveLength(0);
  });

  it('prefers the more powerful charger', () => {
    const ranked = rankStops(
      line,
      [chargingStop('langsam', 8.05, 50, 22), chargingStop('schnell', 8.06, 50, 300)],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('schnell');
  });

  it('filters chargers below the minimum power', () => {
    const ranked = rankStops(
      line,
      [chargingStop('langsam', 8.05, 50, 22), chargingStop('schnell', 8.06, 50, 150)],
      { ...BASE, minPowerKw: 50 },
    );
    expect(ranked.map((r) => r.stop.id)).toEqual(['schnell']);
  });

  it('lets a high-power charger win despite a longer detour', () => {
    const ranked = rankStops(
      line,
      [
        chargingStop('nah-langsam', 8.05, 50, 50),
        chargingStop('weit-schnell', 8.06, 4000, 300),
      ],
      BASE,
    );
    expect(ranked[0]?.stop.id).toBe('weit-schnell');
  });
});

describe('dedupeNearby', () => {
  it('collapses two entries for the same site', () => {
    // The same charging park listed by both GoingElectric and Open Charge Map.
    const stops = rankStops(
      line,
      [
        chargingStop('goingelectric:1', 8.05, 40, 150),
        chargingStop('openchargemap:1', 8.05001, 41, 150),
      ],
      BASE,
    );
    expect(stops).toHaveLength(2);
    expect(dedupeNearby(stops)).toHaveLength(1);
  });

  it('keeps genuinely separate stations', () => {
    const stops = rankStops(
      line,
      [chargingStop('a', 8.05, 40, 150), chargingStop('b', 8.08, 40, 150)],
      BASE,
    );
    expect(dedupeNearby(stops)).toHaveLength(2);
  });

  it('never collapses different kinds of stop at one service area', () => {
    const stops = rankStops(
      line,
      [fuelStop('tanke', 8.05, 40, { e10: 1.7 }), chargingStop('lader', 8.05, 40, 150)],
      BASE,
    );
    expect(dedupeNearby(stops)).toHaveLength(2);
  });
});
