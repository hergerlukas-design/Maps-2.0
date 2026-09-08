/**
 * Range monitoring: the piece that decides *when* to ask "möchtest du tanken?".
 *
 * Kept as a pure state machine over (distance driven, remaining range) so its
 * behaviour — the threshold, the 50-km re-ask after a "Nein", not nagging twice
 * for the same trigger — is unit-testable without GPS, timers or a UI.
 */

export type RangeMonitorPhase =
  /** Above the threshold; nothing to do. */
  | 'idle'
  /** Threshold crossed, waiting for the driver to answer. */
  | 'asking'
  /** Driver said "Nein"; we wait out the re-ask interval. */
  | 'snoozed'
  /** Driver picked a stop; monitoring pauses until they are back on the road. */
  | 'stop_planned'
  /** Remaining range no longer covers the rest of the route to any stop. */
  | 'critical';

export interface RangeMonitorConfig {
  /** Ask once remaining range drops to this many km. */
  thresholdKm: number;
  /** After a "Nein", ask again once this many km have been driven. */
  reAskIntervalKm: number;
  /**
   * Below this remaining range the situation is urgent: the prompt is repeated
   * regardless of a snooze, because running dry is worse than being nagged.
   */
  criticalKm?: number;
}

export interface RangeSnapshot {
  /** Metres driven since navigation started. */
  distanceDrivenM: number;
  /** Remaining range in km, derived from the manual entry minus distance driven. */
  remainingRangeKm: number;
  /** Metres of route left to the destination. */
  remainingRouteM: number;
}

export type RangeEvent =
  /** Show the refuel prompt. */
  | { type: 'ask'; reason: 'threshold' | 're_ask' | 'critical'; snapshot: RangeSnapshot }
  /** Remaining range no longer covers the rest of the trip. */
  | { type: 'cannot_reach_destination'; shortfallKm: number; snapshot: RangeSnapshot };

const DEFAULT_CRITICAL_RATIO = 0.35;

export class RangeMonitor {
  private phase: RangeMonitorPhase = 'idle';
  /** Distance driven when the driver last declined, in metres. */
  private snoozedAtM = 0;
  /** Guards against re-firing the threshold trigger on every GPS tick. */
  private thresholdFired = false;
  private destinationWarningFired = false;

  constructor(private config: RangeMonitorConfig) {}

  get currentPhase(): RangeMonitorPhase {
    return this.phase;
  }

  /** Applies a settings change mid-trip without losing the snooze position. */
  reconfigure(config: RangeMonitorConfig): void {
    this.config = config;
    // Raising the threshold above the current range should be able to re-arm
    // the trigger, so drop the latch and let the next update decide.
    this.thresholdFired = false;
  }

  private get criticalKm(): number {
    return (
      this.config.criticalKm ?? Math.max(25, this.config.thresholdKm * DEFAULT_CRITICAL_RATIO)
    );
  }

  /** Km until the next prompt, or `null` when no prompt is pending. */
  kmUntilNextAsk(snapshot: RangeSnapshot): number | null {
    if (this.phase === 'snoozed') {
      const drivenSinceSnoozeKm = (snapshot.distanceDrivenM - this.snoozedAtM) / 1000;
      return Math.max(0, this.config.reAskIntervalKm - drivenSinceSnoozeKm);
    }
    if (this.phase === 'idle') {
      return Math.max(0, snapshot.remainingRangeKm - this.config.thresholdKm);
    }
    return null;
  }

  /**
   * Feeds a new snapshot in and returns the events it triggers. Called on every
   * position update, so it must be cheap and must not fire duplicates.
   */
  update(snapshot: RangeSnapshot): RangeEvent[] {
    const events: RangeEvent[] = [];

    // Warn once when the remaining range cannot cover the rest of the trip,
    // independent of the ask/snooze cycle — this is information, not a question.
    const remainingRouteKm = snapshot.remainingRouteM / 1000;
    if (
      !this.destinationWarningFired &&
      snapshot.remainingRangeKm < remainingRouteKm &&
      remainingRouteKm > 0
    ) {
      this.destinationWarningFired = true;
      events.push({
        type: 'cannot_reach_destination',
        shortfallKm: remainingRouteKm - snapshot.remainingRangeKm,
        snapshot,
      });
    }

    // The destination is within range: no stop is needed, so stop asking.
    if (snapshot.remainingRangeKm >= remainingRouteKm && this.phase !== 'stop_planned') {
      if (this.phase === 'asking') this.phase = 'idle';
      return events;
    }

    if (this.phase === 'stop_planned' || this.phase === 'asking') return events;

    const critical = snapshot.remainingRangeKm <= this.criticalKm;

    if (critical && this.phase !== 'critical') {
      this.phase = 'critical';
      events.push({ type: 'ask', reason: 'critical', snapshot });
      return events;
    }

    if (this.phase === 'snoozed') {
      const drivenSinceSnoozeM = snapshot.distanceDrivenM - this.snoozedAtM;
      if (drivenSinceSnoozeM >= this.config.reAskIntervalKm * 1000) {
        this.phase = 'asking';
        events.push({ type: 'ask', reason: 're_ask', snapshot });
      }
      return events;
    }

    if (
      this.phase === 'idle' &&
      !this.thresholdFired &&
      snapshot.remainingRangeKm <= this.config.thresholdKm
    ) {
      this.thresholdFired = true;
      this.phase = 'asking';
      events.push({ type: 'ask', reason: 'threshold', snapshot });
    }

    return events;
  }

  /** Driver answered "Nein": wait out the configured interval. */
  decline(snapshot: RangeSnapshot): void {
    this.snoozedAtM = snapshot.distanceDrivenM;
    this.phase = 'snoozed';
  }

  /** Driver picked a stop: stop asking until they resume the trip. */
  acceptStop(): void {
    this.phase = 'stop_planned';
  }

  /**
   * Driver refuelled (or skipped the planned stop) and is driving on. The new
   * range re-arms the threshold trigger.
   */
  resume(): void {
    this.phase = 'idle';
    this.thresholdFired = false;
    this.destinationWarningFired = false;
  }

  /** Dismisses the prompt without snoozing — e.g. the driver closed the sheet. */
  dismiss(snapshot: RangeSnapshot): void {
    this.decline(snapshot);
  }
}

/* ------------------------------------------------------------------ *
 * Range arithmetic
 * ------------------------------------------------------------------ */

/**
 * Remaining range from the manually entered value minus distance driven.
 *
 * The briefing is explicit that range is entered by hand and never read from
 * the car, so this is a straight subtraction rather than a consumption model.
 * `consumptionFactor` lets the UI apply a pessimism factor (motorway speeds burn
 * more than the on-board average suggests) without changing the entered number.
 */
export function remainingRangeKm(
  enteredRangeKm: number,
  distanceDrivenM: number,
  consumptionFactor = 1,
): number {
  const usedKm = (distanceDrivenM / 1000) * Math.max(0.5, consumptionFactor);
  return Math.max(0, enteredRangeKm - usedKm);
}

/** Reserve kept in hand so "reachable" never means "arrives on empty". */
export const RANGE_RESERVE_KM = 15;

/**
 * Whether a stop is reachable on the range left, keeping a small reserve.
 * Used to grey out suggestions that are further away than the tank allows.
 */
export function isReachable(
  remainingKm: number,
  distanceToStopM: number,
  reserveKm = RANGE_RESERVE_KM,
): boolean {
  return remainingKm - distanceToStopM / 1000 >= reserveKm;
}
