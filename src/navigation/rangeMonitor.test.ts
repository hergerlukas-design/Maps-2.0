import { beforeEach, describe, expect, it } from 'vitest';
import {
  isReachable,
  RangeMonitor,
  remainingRangeKm,
  type RangeSnapshot,
} from './rangeMonitor';

/** Builds a snapshot for a trip of `routeKm` with `enteredKm` of range. */
function snapshotAt(
  drivenKm: number,
  enteredKm: number,
  routeKm: number,
): RangeSnapshot {
  return {
    distanceDrivenM: drivenKm * 1000,
    remainingRangeKm: remainingRangeKm(enteredKm, drivenKm * 1000),
    remainingRouteM: Math.max(0, (routeKm - drivenKm) * 1000),
  };
}

describe('remainingRangeKm', () => {
  it('subtracts the distance driven from the manually entered range', () => {
    expect(remainingRangeKm(400, 120_000)).toBe(280);
  });

  it('never goes negative', () => {
    expect(remainingRangeKm(50, 200_000)).toBe(0);
  });

  it('applies a pessimism factor when asked', () => {
    expect(remainingRangeKm(400, 100_000, 1.2)).toBe(280);
  });
});

describe('isReachable', () => {
  it('keeps a reserve in hand', () => {
    expect(isReachable(30, 10_000)).toBe(true);
    expect(isReachable(30, 20_000)).toBe(false);
  });
});

/**
 * Most cases care only about the ask/snooze cycle. A trip longer than the
 * entered range also emits a one-off `cannot_reach_destination` notice, which
 * has its own test below.
 */
function asks(events: ReturnType<RangeMonitor['update']>) {
  return events.filter((event) => event.type === 'ask');
}

describe('RangeMonitor', () => {
  let monitor: RangeMonitor;

  beforeEach(() => {
    monitor = new RangeMonitor({ thresholdKm: 200, reAskIntervalKm: 50 });
  });

  it('stays quiet while range comfortably exceeds the threshold', () => {
    // 800 km trip, 600 km of range: a stop is needed, but not yet.
    expect(asks(monitor.update(snapshotAt(0, 600, 800)))).toEqual([]);
    expect(asks(monitor.update(snapshotAt(100, 600, 800)))).toEqual([]);
    expect(monitor.currentPhase).toBe('idle');
  });

  it('asks exactly once when the threshold is crossed', () => {
    monitor.update(snapshotAt(390, 600, 800));
    const events = asks(monitor.update(snapshotAt(401, 600, 800)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ask', reason: 'threshold' });

    // Still in `asking`: further ticks must not stack up more prompts.
    expect(monitor.update(snapshotAt(405, 600, 800))).toEqual([]);
    expect(monitor.update(snapshotAt(410, 600, 800))).toEqual([]);
  });

  it('re-asks only after the configured interval has been driven', () => {
    monitor.update(snapshotAt(401, 600, 800));
    monitor.decline(snapshotAt(401, 600, 800));
    expect(monitor.currentPhase).toBe('snoozed');

    // 49 km later: still snoozed.
    expect(monitor.update(snapshotAt(450, 600, 800))).toEqual([]);

    // 50 km later: ask again.
    const events = asks(monitor.update(snapshotAt(451, 600, 800)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ask', reason: 're_ask' });
  });

  it('reports how far it is until the next prompt', () => {
    expect(monitor.kmUntilNextAsk(snapshotAt(0, 600, 800))).toBe(400);
    monitor.update(snapshotAt(401, 600, 800));
    monitor.decline(snapshotAt(401, 600, 800));
    expect(monitor.kmUntilNextAsk(snapshotAt(421, 600, 800))).toBe(30);
  });

  it('honours a custom re-ask interval', () => {
    const custom = new RangeMonitor({ thresholdKm: 200, reAskIntervalKm: 20 });
    custom.update(snapshotAt(401, 600, 800));
    custom.decline(snapshotAt(401, 600, 800));
    expect(asks(custom.update(snapshotAt(415, 600, 800)))).toEqual([]);
    expect(asks(custom.update(snapshotAt(422, 600, 800)))).toHaveLength(1);
  });

  it('overrides a snooze once the range becomes critical', () => {
    monitor.update(snapshotAt(401, 600, 800));
    monitor.decline(snapshotAt(401, 600, 800));

    // Critical defaults to 35 % of the threshold, i.e. 70 km left.
    const events = asks(monitor.update(snapshotAt(535, 600, 800)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ask', reason: 'critical' });
    expect(monitor.currentPhase).toBe('critical');
  });

  it('goes quiet once a stop has been planned, and re-arms on resume', () => {
    monitor.update(snapshotAt(401, 600, 800));
    monitor.acceptStop();
    expect(asks(monitor.update(snapshotAt(410, 600, 800)))).toEqual([]);
    expect(monitor.currentPhase).toBe('stop_planned');

    // Refuelled: the driver enters a fresh range and drives on.
    monitor.resume();
    expect(monitor.currentPhase).toBe('idle');
    const events = monitor.update({
      distanceDrivenM: 500_000,
      remainingRangeKm: 150,
      remainingRouteM: 300_000,
    });
    expect(events.some((e) => e.type === 'ask')).toBe(true);
  });

  it('never asks when the destination is already within range', () => {
    // 100 km trip, 150 km of range — no stop needed, even below the threshold.
    expect(asks(monitor.update(snapshotAt(0, 150, 100)))).toEqual([]);
    expect(asks(monitor.update(snapshotAt(50, 150, 100)))).toEqual([]);
    expect(monitor.currentPhase).toBe('idle');
  });

  it('warns at the start that the range cannot cover the whole route', () => {
    const events = monitor.update(snapshotAt(0, 300, 800));
    const warning = events.find((e) => e.type === 'cannot_reach_destination');
    expect(warning).toBeDefined();
    expect(warning).toMatchObject({ shortfallKm: 500 });

    // Not repeated on every tick.
    const later = monitor.update(snapshotAt(10, 300, 800));
    expect(later.some((e) => e.type === 'cannot_reach_destination')).toBe(false);
  });

  it('re-arms the threshold when the setting is raised mid-trip', () => {
    monitor.update(snapshotAt(401, 600, 800));
    monitor.decline(snapshotAt(401, 600, 800));

    // Driver raises the threshold to 250 km; 199 km are left, so ask again now
    // rather than waiting out the remaining snooze distance.
    monitor.reconfigure({ thresholdKm: 250, reAskIntervalKm: 50 });
    monitor.resume();
    const events = asks(monitor.update(snapshotAt(410, 600, 800)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ask', reason: 'threshold' });
  });
});
