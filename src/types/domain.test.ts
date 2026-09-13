import { describe, expect, it } from 'vitest';

import { remainingWaypoints, type StopWaypoint } from './domain';

const at = (kind: StopWaypoint['kind'], id: string, reachedAt?: number): StopWaypoint => ({
  id,
  kind,
  name: id,
  location: { lng: 8, lat: 50 },
  ...(reachedAt == null ? {} : { reachedAt }),
});

describe('remainingWaypoints', () => {
  it('lässt den Startpunkt weg, auch wenn er nicht als erreicht markiert ist', () => {
    // Genau dieser Fall: beim Losfahren trägt der Startpunkt kein `reachedAt`.
    // Stand er in der Liste, führte die erste Neuberechnung zurück dorthin.
    const waypoints = [at('origin', 'start'), at('destination', 'ziel')];
    expect(remainingWaypoints(waypoints).map((w) => w.id)).toEqual(['ziel']);
  });

  it('lässt den Startpunkt auch nach einer Neuberechnung weg', () => {
    // Nach einer Neuberechnung trägt er ein `reachedAt` — beides muss greifen.
    const waypoints = [at('origin', 'hier', 1), at('fuel', 'tanke'), at('destination', 'ziel')];
    expect(remainingWaypoints(waypoints).map((w) => w.id)).toEqual(['tanke', 'ziel']);
  });

  it('lässt bereits angefahrene Zwischenstopps weg, spätere nicht', () => {
    const waypoints = [
      at('origin', 'start'),
      at('fuel', 'tanke', 1),
      at('rest_area', 'rastplatz'),
      at('destination', 'ziel'),
    ];
    expect(remainingWaypoints(waypoints).map((w) => w.id)).toEqual(['rastplatz', 'ziel']);
  });

  it('behält die Fahrtreihenfolge', () => {
    const waypoints = [
      at('origin', 'start'),
      at('charging', 'a'),
      at('toilets', 'b'),
      at('destination', 'ziel'),
    ];
    expect(remainingWaypoints(waypoints).map((w) => w.id)).toEqual(['a', 'b', 'ziel']);
  });
});
