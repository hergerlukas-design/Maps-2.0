import type { Position } from '@shared/types';
import { distanceM, snapToLine, type MeasuredLine } from '@/lib/geo';
import type { NavRoute, RouteStep } from '@/services/mapbox/directions';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface GpsFix {
  position: Position;
  /** Horizontal accuracy in metres, as reported by the Geolocation API. */
  accuracyM: number;
  /** Course over ground in degrees, or `null` when standing still. */
  headingDeg: number | null;
  /** Ground speed in m/s, or `null` when unavailable. */
  speedMps: number | null;
  timestamp: number;
}

export interface EngineOptions {
  /**
   * Snapping window ahead of the last match, in metres. Wide enough to absorb a
   * lost signal in a tunnel, narrow enough that a road running parallel further
   * along the route cannot steal the match.
   */
  lookAheadM?: number;
  /** Snapping window behind the last match, in metres. */
  lookBehindM?: number;
  /**
   * Off-route once the snapped offset exceeds this. Compared against the GPS
   * accuracy so a poor fix in a city canyon does not trigger a reroute.
   */
  offRouteToleranceM?: number;
  /** Consecutive off-route fixes required before reporting `offRoute`. */
  offRouteFixes?: number;
  /** Distance to the final waypoint at which the trip counts as finished. */
  arrivalRadiusM?: number;
}

const DEFAULTS = {
  lookAheadM: 3000,
  lookBehindM: 300,
  offRouteToleranceM: 45,
  offRouteFixes: 3,
  arrivalRadiusM: 40,
} satisfies Required<EngineOptions>;

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface ManeuverView {
  step: RouteStep;
  /** Metres until this step's maneuver point. */
  distanceToManeuverM: number;
  /** Primary banner text for the current distance, falling back to the step. */
  primaryText: string;
  secondaryText: string | null;
  /** The step after this one, for the "then …" hint. */
  next: RouteStep | null;
  lanes: RouteStep['lanes'];
}

export interface NavState {
  /** Position snapped onto the route — what the puck is drawn at. */
  snapped: Position;
  /** The raw fix, kept so the UI can show real accuracy. */
  raw: Position;
  /** Metres travelled along the route. */
  progressM: number;
  /** Metres of route remaining. */
  remainingDistanceM: number;
  /** Seconds of driving remaining, adjusted by observed speed. */
  remainingDurationS: number;
  /** Course to draw the puck at: GPS heading when moving, else the road. */
  courseDeg: number;
  /** Smoothed speed in m/s. */
  speedMps: number;
  /** `null` once the route is complete. */
  maneuver: ManeuverView | null;
  currentStepIndex: number;
  currentLegIndex: number;
  /** Metres until the end of the current leg (i.e. the next waypoint). */
  distanceToLegEndM: number;
  offRouteM: number;
  isOffRoute: boolean;
  hasArrived: boolean;
  updatedAt: number;
}

export interface EngineEvents {
  /** A voice instruction became due. */
  onVoice?: (announcement: string, step: RouteStep) => void;
  /** The driver reached an intermediate waypoint (a fuel/charging stop). */
  onWaypointReached?: (legIndex: number) => void;
  /** The final destination was reached. */
  onArrived?: () => void;
  /** Sustained deviation from the route; the caller decides whether to reroute. */
  onOffRoute?: (offsetM: number) => void;
}

/**
 * Turn-by-turn state machine.
 *
 * Deliberately framework-free: it takes GPS fixes and produces a `NavState`, so
 * the whole navigation behaviour can be unit-tested by replaying a synthetic
 * track without a map, a browser or a network.
 */
export class NavigationEngine {
  private readonly options: Required<EngineOptions>;
  private readonly line: MeasuredLine;

  private progressM = 0;
  private lastSnapIndex = 0;
  private stepIndex = 0;
  private smoothedSpeedMps = 0;
  private offRouteStreak = 0;
  private arrived = false;
  private lastFixAt: number | null = null;
  private lastProgressM = 0;

  /** Voice announcements already spoken, keyed `stepIndex:distanceAlongGeometry`. */
  private readonly spokenVoice = new Set<string>();
  private readonly reachedLegs = new Set<number>();

  constructor(
    readonly route: NavRoute,
    private readonly events: EngineEvents = {},
    options: EngineOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.line = route.line;
  }

  /** Current progress, so a rerouted engine can resume where the old one was. */
  get progress(): number {
    return this.progressM;
  }

  /**
   * Seeds progress after a reroute. The new route starts at the driver's
   * position, so progress restarts at zero, but a route that merely inserted a
   * waypoint can carry the old progress across.
   */
  seedProgress(progressM: number): void {
    this.progressM = Math.max(0, Math.min(progressM, this.line.totalLengthM));
    this.lastProgressM = this.progressM;
    this.lastSnapIndex = this.vertexIndexAt(this.progressM);
    this.stepIndex = this.stepIndexAt(this.progressM);
  }

  update(fix: GpsFix): NavState {
    const window = this.searchWindow();
    const snap = snapToLine(this.line, fix.position, window[0], window[1]);

    // Progress is monotonic: GPS noise must never rewind the route. A genuine
    // backwards move (wrong turn, U-turn) shows up as off-route instead, which
    // triggers a reroute rather than a rewinding progress bar.
    const advanced = snap.alongM > this.progressM;
    if (advanced) {
      this.progressM = snap.alongM;
      this.lastSnapIndex = snap.segmentIndex;
    }

    this.updateSpeed(fix);
    this.updateOffRoute(fix, snap.offsetM);
    this.advanceStep();

    const maneuver = this.buildManeuver();
    if (maneuver) this.fireVoice(maneuver);
    this.checkLegArrival();

    const remainingDistanceM = Math.max(0, this.line.totalLengthM - this.progressM);
    const hasArrived = this.checkArrival(fix, remainingDistanceM);

    const currentStep = this.route.steps[this.stepIndex];
    const courseDeg =
      fix.headingDeg != null && this.smoothedSpeedMps > 1.5
        ? fix.headingDeg
        : snap.segmentBearing;

    return {
      snapped: this.isOffRoute() ? fix.position : snap.point,
      raw: fix.position,
      progressM: this.progressM,
      remainingDistanceM,
      remainingDurationS: this.estimateRemainingDuration(remainingDistanceM),
      courseDeg,
      speedMps: this.smoothedSpeedMps,
      maneuver,
      currentStepIndex: this.stepIndex,
      currentLegIndex: currentStep?.legIndex ?? this.route.legs.length - 1,
      distanceToLegEndM: this.distanceToLegEnd(),
      offRouteM: snap.offsetM,
      isOffRoute: this.isOffRoute(),
      hasArrived,
      updatedAt: fix.timestamp,
    };
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private searchWindow(): [number, number] {
    const coords = this.line.coordinates;
    const behind = this.vertexIndexAt(this.progressM - this.options.lookBehindM);
    const ahead = this.vertexIndexAt(this.progressM + this.options.lookAheadM);
    return [
      Math.max(0, Math.min(behind, this.lastSnapIndex)),
      Math.min(coords.length - 1, Math.max(ahead, this.lastSnapIndex + 1)),
    ];
  }

  private vertexIndexAt(alongM: number): number {
    const cumulative = this.line.cumulative;
    const target = Math.max(0, Math.min(alongM, this.line.totalLengthM));
    let lo = 0;
    let hi = cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! <= target) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private stepIndexAt(alongM: number): number {
    const steps = this.route.steps;
    for (let i = 0; i < steps.length; i++) {
      if (alongM < steps[i]!.endAlongM) return i;
    }
    return Math.max(0, steps.length - 1);
  }

  private advanceStep(): void {
    const steps = this.route.steps;
    // Only ever move forward, and only one step per check, so a long GPS gap
    // still fires each step's arrival logic in order.
    while (
      this.stepIndex < steps.length - 1 &&
      this.progressM >= steps[this.stepIndex]!.endAlongM
    ) {
      this.stepIndex++;
    }
  }

  private updateSpeed(fix: GpsFix): void {
    const reported =
      fix.speedMps != null && Number.isFinite(fix.speedMps) && fix.speedMps >= 0
        ? fix.speedMps
        : null;

    // Desktop browsers and some Android devices leave `speed` null, so fall
    // back to how far along the route we moved since the previous fix.
    let derived: number | null = null;
    if (this.lastFixAt != null) {
      const dtS = (fix.timestamp - this.lastFixAt) / 1000;
      if (dtS >= 0.5 && dtS <= 30) {
        derived = Math.max(0, (this.progressM - this.lastProgressM) / dtS);
      }
    }
    this.lastFixAt = fix.timestamp;
    this.lastProgressM = this.progressM;

    const observed = reported ?? derived;
    if (observed == null) return;

    // Exponential smoothing: responsive enough for ETA, stable enough that the
    // puck's heading does not flicker at low speed.
    this.smoothedSpeedMps =
      this.smoothedSpeedMps === 0
        ? observed
        : this.smoothedSpeedMps * 0.7 + observed * 0.3;
  }

  private updateOffRoute(fix: GpsFix, offsetM: number): void {
    // A 60 m accuracy fix cannot prove a 45 m deviation.
    const tolerance = Math.max(
      this.options.offRouteToleranceM,
      Number.isFinite(fix.accuracyM) ? fix.accuracyM * 1.5 : 0,
    );
    if (offsetM > tolerance) {
      this.offRouteStreak++;
      if (this.offRouteStreak === this.options.offRouteFixes) {
        this.events.onOffRoute?.(offsetM);
      }
    } else {
      this.offRouteStreak = 0;
    }
  }

  private isOffRoute(): boolean {
    return this.offRouteStreak >= this.options.offRouteFixes;
  }

  private buildManeuver(): ManeuverView | null {
    const step = this.route.steps[this.stepIndex];
    if (!step) return null;

    const distanceToManeuverM = Math.max(0, step.endAlongM - this.progressM);
    const next = this.route.steps[this.stepIndex + 1] ?? null;

    // Mapbox banners are ordered by descending `distanceAlongGeometry`; the one
    // to show is the last whose trigger distance we are already inside.
    let banner = step.banners[0] ?? null;
    for (const candidate of step.banners) {
      if (distanceToManeuverM <= candidate.distanceAlongGeometry) banner = candidate;
    }

    return {
      step,
      distanceToManeuverM,
      primaryText: banner?.primary.text ?? step.instruction,
      secondaryText: banner?.secondary?.text ?? step.destinations ?? null,
      next,
      // Lane guidance is only meaningful close to the turn.
      lanes: distanceToManeuverM < 600 ? step.lanes : null,
    };
  }

  private fireVoice(maneuver: ManeuverView): void {
    if (!this.events.onVoice) return;
    for (const instruction of maneuver.step.voice) {
      if (maneuver.distanceToManeuverM > instruction.distanceAlongGeometry) continue;
      const key = `${maneuver.step.index}:${instruction.distanceAlongGeometry}`;
      if (this.spokenVoice.has(key)) continue;
      this.spokenVoice.add(key);
      this.events.onVoice(instruction.announcement, maneuver.step);
    }
  }

  private distanceToLegEnd(): number {
    const step = this.route.steps[this.stepIndex];
    const leg = this.route.legs[step?.legIndex ?? 0];
    if (!leg) return Math.max(0, this.line.totalLengthM - this.progressM);
    return Math.max(0, leg.endAlongM - this.progressM);
  }

  private checkLegArrival(): void {
    // Every leg but the last ends at an intermediate waypoint — a fuel or
    // charging stop the driver chose mid-trip.
    for (let i = 0; i < this.route.legs.length - 1; i++) {
      const leg = this.route.legs[i]!;
      if (this.reachedLegs.has(i)) continue;
      if (this.progressM >= leg.endAlongM - this.options.arrivalRadiusM) {
        this.reachedLegs.add(i);
        this.events.onWaypointReached?.(i);
      }
    }
  }

  private checkArrival(fix: GpsFix, remainingDistanceM: number): boolean {
    if (this.arrived) return true;
    const destination = this.line.coordinates[this.line.coordinates.length - 1];
    const straightLineM = destination ? distanceM(fix.position, destination) : Infinity;
    if (
      remainingDistanceM <= this.options.arrivalRadiusM ||
      straightLineM <= this.options.arrivalRadiusM
    ) {
      this.arrived = true;
      this.events.onArrived?.();
      return true;
    }
    return false;
  }

  /**
   * Remaining time from the route's own step durations, corrected by how the
   * driver's actual speed compares with the planned speed for the road so far.
   */
  private estimateRemainingDuration(remainingDistanceM: number): number {
    const steps = this.route.steps;
    let planned = 0;
    for (let i = this.stepIndex; i < steps.length; i++) {
      const step = steps[i]!;
      if (i === this.stepIndex && step.distanceM > 0) {
        const fractionLeft = Math.max(
          0,
          Math.min(1, (step.endAlongM - this.progressM) / step.distanceM),
        );
        planned += step.durationS * fractionLeft;
      } else {
        planned += step.durationS;
      }
    }
    if (planned <= 0) return 0;

    const plannedSpeed = remainingDistanceM / planned;
    if (this.smoothedSpeedMps < 2 || plannedSpeed <= 0) return planned;

    // Blend planned and observed speed: the observed value reflects current
    // conditions, the planned one knows the road ahead changes character.
    const blended = plannedSpeed * 0.65 + this.smoothedSpeedMps * 0.35;
    return remainingDistanceM / Math.max(2, blended);
  }
}
