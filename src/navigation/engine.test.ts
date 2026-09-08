import { describe, expect, it, vi } from 'vitest';
import type { Position } from '@shared/types';
import { measureLine, pointAtDistance } from '@/lib/geo';
import type { NavRoute, RouteStep } from '@/services/mapbox/directions';
import { NavigationEngine, type GpsFix } from './engine';

/* ------------------------------------------------------------------ *
 * A synthetic route: three straight legs heading east, with one
 * intermediate waypoint, so leg arrival can be exercised too.
 * ------------------------------------------------------------------ */

function buildRoute(options: { waypointAfterSteps?: number } = {}): NavRoute {
  const coordinates: Position[] = [];
  // ~22 km of line, one vertex every ~111 m.
  for (let i = 0; i <= 200; i++) coordinates.push([8 + i * 0.001, 50]);
  const line = measureLine(coordinates);

  const stepCount = 4;
  const stepLength = line.totalLengthM / stepCount;
  const steps: RouteStep[] = [];
  for (let i = 0; i < stepCount; i++) {
    const startAlongM = stepLength * i;
    const endAlongM = stepLength * (i + 1);
    const legIndex =
      options.waypointAfterSteps != null && i >= options.waypointAfterSteps ? 1 : 0;
    steps.push({
      index: i,
      legIndex,
      distanceM: stepLength,
      // 30 m/s ≈ 108 km/h, a plausible motorway pace.
      durationS: stepLength / 30,
      instruction: `Schritt ${i + 1}`,
      maneuver: i === 0 ? { type: 'depart' } : { type: 'turn', modifier: 'right' },
      name: `Straße ${i + 1}`,
      location: pointAtDistance(line, endAlongM),
      geometry: [],
      startAlongM,
      endAlongM,
      banners: [
        { distanceAlongGeometry: stepLength, primary: { text: `Weit: Schritt ${i + 1}` } },
        { distanceAlongGeometry: 400, primary: { text: `Nah: Schritt ${i + 1}` } },
      ],
      voice: [
        { distanceAlongGeometry: 1000, announcement: `In 1 km Schritt ${i + 1}` },
        { distanceAlongGeometry: 100, announcement: `Jetzt Schritt ${i + 1}` },
      ],
      lanes: null,
    });
  }

  const legs =
    options.waypointAfterSteps != null
      ? [
          {
            index: 0,
            distanceM: stepLength * options.waypointAfterSteps,
            durationS: (stepLength * options.waypointAfterSteps) / 30,
            summary: 'Leg 1',
            endAlongM: stepLength * options.waypointAfterSteps,
            stepRange: [0, options.waypointAfterSteps] as [number, number],
          },
          {
            index: 1,
            distanceM: line.totalLengthM - stepLength * options.waypointAfterSteps,
            durationS: (line.totalLengthM - stepLength * options.waypointAfterSteps) / 30,
            summary: 'Leg 2',
            endAlongM: line.totalLengthM,
            stepRange: [options.waypointAfterSteps, stepCount] as [number, number],
          },
        ]
      : [
          {
            index: 0,
            distanceM: line.totalLengthM,
            durationS: line.totalLengthM / 30,
            summary: 'Leg 1',
            endAlongM: line.totalLengthM,
            stepRange: [0, stepCount] as [number, number],
          },
        ];

  return {
    distanceM: line.totalLengthM,
    durationS: line.totalLengthM / 30,
    typicalDurationS: null,
    geometry: coordinates,
    line,
    steps,
    legs,
    waypoints: [
      { name: 'Start', location: coordinates[0]! },
      { name: 'Ziel', location: coordinates.at(-1)! },
    ],
    profile: 'driving-traffic',
    requestedAt: 0,
  };
}

/** A fix exactly on the route, `alongM` metres in. */
function fixAt(route: NavRoute, alongM: number, overrides: Partial<GpsFix> = {}): GpsFix {
  return {
    position: pointAtDistance(route.line, alongM),
    accuracyM: 5,
    headingDeg: 90,
    speedMps: 30,
    timestamp: 1_000_000 + alongM * 10,
    ...overrides,
  };
}

/**
 * Drives the engine from its current progress to `targetAlongM` in realistic
 * increments. The engine deliberately refuses to teleport (see the look-ahead
 * window test), so a test that jumps kilometres in one fix would be testing
 * that guard rather than the behaviour it is after.
 */
function driveTo(
  engine: NavigationEngine,
  route: NavRoute,
  targetAlongM: number,
  stepM = 250,
) {
  let along = engine.progress;
  let state = engine.update(fixAt(route, along));
  while (along < targetAlongM) {
    along = Math.min(targetAlongM, along + stepM);
    state = engine.update(fixAt(route, along));
  }
  return state;
}

/** A fix offset perpendicular to the route by roughly `offsetM` metres. */
function offsetFix(route: NavRoute, alongM: number, offsetM: number): GpsFix {
  const on = pointAtDistance(route.line, alongM);
  const degPerMetre = 1 / 111_320;
  return {
    ...fixAt(route, alongM),
    position: [on[0], on[1] + offsetM * degPerMetre],
  };
}

describe('NavigationEngine', () => {
  it('tracks progress and shrinks the remaining distance', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);

    const start = engine.update(fixAt(route, 0));
    expect(start.progressM).toBeLessThan(10);
    expect(start.remainingDistanceM).toBeCloseTo(route.line.totalLengthM, 0);

    const halfway = route.line.totalLengthM / 2;
    const middle = driveTo(engine, route, halfway);
    expect(middle.progressM).toBeCloseTo(halfway, 0);
    expect(middle.remainingDistanceM).toBeCloseTo(halfway, 0);
  });

  it('never rewinds progress when GPS noise pulls backwards', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    driveTo(engine, route, 5000);
    const back = engine.update(fixAt(route, 4900));
    expect(back.progressM).toBeCloseTo(5000, 0);
  });

  it('advances through steps and counts down to the maneuver', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    const firstStepEnd = route.steps[0]!.endAlongM;

    const early = driveTo(engine, route, firstStepEnd - 2000);
    expect(early.currentStepIndex).toBe(0);
    expect(early.maneuver?.distanceToManeuverM).toBeCloseTo(2000, 0);

    const past = driveTo(engine, route, firstStepEnd + 10);
    expect(past.currentStepIndex).toBe(1);
  });

  it('picks the near banner only once close to the turn', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    const stepEnd = route.steps[0]!.endAlongM;

    expect(driveTo(engine, route, stepEnd - 3000).maneuver?.primaryText).toBe(
      'Weit: Schritt 1',
    );
    expect(driveTo(engine, route, stepEnd - 200).maneuver?.primaryText).toBe(
      'Nah: Schritt 1',
    );
  });

  it('speaks each voice instruction exactly once', () => {
    const route = buildRoute();
    const onVoice = vi.fn();
    const engine = new NavigationEngine(route, { onVoice });
    const stepEnd = route.steps[0]!.endAlongM;

    driveTo(engine, route, stepEnd - 2000);
    expect(onVoice).not.toHaveBeenCalled();

    driveTo(engine, route, stepEnd - 900);
    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(onVoice.mock.calls[0]![0]).toBe('In 1 km Schritt 1');

    // Same distance band again: must not repeat.
    driveTo(engine, route, stepEnd - 800);
    expect(onVoice).toHaveBeenCalledTimes(1);

    driveTo(engine, route, stepEnd - 50);
    expect(onVoice).toHaveBeenCalledTimes(2);
    expect(onVoice.mock.calls[1]![0]).toBe('Jetzt Schritt 1');
  });

  it('only reports off-route after a sustained deviation', () => {
    const route = buildRoute();
    const onOffRoute = vi.fn();
    const engine = new NavigationEngine(route, { onOffRoute });

    driveTo(engine, route, 1000);
    expect(engine.update(offsetFix(route, 1100, 200)).isOffRoute).toBe(false);
    expect(engine.update(offsetFix(route, 1200, 200)).isOffRoute).toBe(false);
    expect(engine.update(offsetFix(route, 1300, 200)).isOffRoute).toBe(true);
    expect(onOffRoute).toHaveBeenCalledTimes(1);
  });

  it('does not call a deviation off-route when GPS accuracy is poor', () => {
    const route = buildRoute();
    const onOffRoute = vi.fn();
    const engine = new NavigationEngine(route, { onOffRoute });

    for (let i = 0; i < 5; i++) {
      const fix = offsetFix(route, 1000 + i * 100, 60);
      // A 60 m deviation cannot be distinguished from a 200 m-accuracy fix.
      engine.update({ ...fix, accuracyM: 200 });
    }
    expect(onOffRoute).not.toHaveBeenCalled();
  });

  it('recovers from off-route once back on the line', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    driveTo(engine, route, 1000);
    for (let i = 0; i < 4; i++) engine.update(offsetFix(route, 1000 + i * 100, 300));
    expect(engine.update(fixAt(route, 1500)).isOffRoute).toBe(false);
  });

  it('fires the waypoint callback when an intermediate stop is reached', () => {
    const route = buildRoute({ waypointAfterSteps: 2 });
    const onWaypointReached = vi.fn();
    const engine = new NavigationEngine(route, { onWaypointReached });
    const waypointAtM = route.legs[0]!.endAlongM;

    driveTo(engine, route, waypointAtM - 1000);
    expect(onWaypointReached).not.toHaveBeenCalled();

    driveTo(engine, route, waypointAtM);
    expect(onWaypointReached).toHaveBeenCalledWith(0);

    // Not fired twice.
    driveTo(engine, route, waypointAtM + 500);
    expect(onWaypointReached).toHaveBeenCalledTimes(1);
  });

  it('reports the distance to the end of the current leg', () => {
    const route = buildRoute({ waypointAfterSteps: 2 });
    const engine = new NavigationEngine(route);
    const waypointAtM = route.legs[0]!.endAlongM;
    const state = driveTo(engine, route, waypointAtM - 3000);
    expect(state.currentLegIndex).toBe(0);
    expect(state.distanceToLegEndM).toBeCloseTo(3000, 0);
  });

  it('announces arrival once and stays arrived', () => {
    const route = buildRoute();
    const onArrived = vi.fn();
    const engine = new NavigationEngine(route, { onArrived });

    driveTo(engine, route, route.line.totalLengthM - 500);
    expect(onArrived).not.toHaveBeenCalled();

    expect(driveTo(engine, route, route.line.totalLengthM).hasArrived).toBe(true);
    expect(onArrived).toHaveBeenCalledTimes(1);
    expect(engine.update(fixAt(route, route.line.totalLengthM)).hasArrived).toBe(true);
    expect(onArrived).toHaveBeenCalledTimes(1);
  });

  it('estimates a remaining duration consistent with the planned pace', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    const state = engine.update(fixAt(route, 0, { speedMps: 30 }));
    // The whole route is planned at 30 m/s, so the estimate should land close.
    expect(state.remainingDurationS).toBeGreaterThan(route.durationS * 0.85);
    expect(state.remainingDurationS).toBeLessThan(route.durationS * 1.15);
  });

  it('falls back to the road bearing for the puck when standing still', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    driveTo(engine, route, 1000);

    // A single zero-speed sample must not flip the puck — speed is smoothed so
    // one bad reading at motorway pace is ignored.
    expect(
      engine.update(fixAt(route, 1000, { speedMps: 0, headingDeg: 270 })).courseDeg,
    ).toBeCloseTo(270, 0);

    // Genuinely stopped: after a dozen seconds at a standstill the smoothed
    // speed decays and the puck aligns with the road instead of a stale heading.
    let state = engine.update(fixAt(route, 1000, { speedMps: 0, headingDeg: 270 }));
    for (let i = 0; i < 14; i++) {
      state = engine.update(fixAt(route, 1000, { speedMps: 0, headingDeg: 270 }));
    }
    expect(state.speedMps).toBeLessThan(1.5);
    expect(state.courseDeg).toBeCloseTo(90, 0);
  });

  it('refuses to jump further ahead than the look-ahead window allows', () => {
    // A single fix 10 km down the route is not a driver, it is a bad match. The
    // window caps how far one update can advance progress.
    const route = buildRoute();
    const engine = new NavigationEngine(route, {}, { lookAheadM: 3000 });
    engine.update(fixAt(route, 0));
    const jumped = engine.update(fixAt(route, 10_000));
    expect(jumped.progressM).toBeLessThan(3500);
  });

  it('resumes at a seeded progress after a reroute', () => {
    const route = buildRoute();
    const engine = new NavigationEngine(route);
    engine.seedProgress(10_000);
    expect(engine.progress).toBe(10_000);
    const state = engine.update(fixAt(route, 10_100));
    // Seeding also moves the snapping window, so the next fix matches at once.
    expect(state.progressM).toBeCloseTo(10_100, 0);
    expect(state.currentStepIndex).toBeGreaterThan(0);
  });
});
