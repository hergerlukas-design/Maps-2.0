import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LngLat, RankedStop, Stop, StopKind } from '@shared/types';
import type { Settings, StopWaypoint, Vehicle } from '@/types/domain';
import { refuelStopKinds } from '@/types/domain';
import { measureLine } from '@/lib/geo';
import {
  fetchRoute,
  DirectionsError,
  MAX_WAYPOINTS,
  type NavRoute,
} from '@/services/mapbox/directions';
import {
  dedupeNearby,
  rankStops,
  searchAmenities,
  searchCharging,
  searchFuel,
  StopSearchError,
} from '@/services/stations/search';
import { NavigationEngine, type GpsFix, type NavState } from '@/navigation/engine';
import {
  RangeMonitor,
  remainingRangeKm,
  type RangeEvent,
  type RangeSnapshot,
} from '@/navigation/rangeMonitor';
import { showLocalNotification } from '@/services/push';

export type SessionPhase = 'idle' | 'routing' | 'ready' | 'navigating' | 'arrived';

/** Why the stop sheet is open. */
export type StopPickerReason =
  | { kind: 'range'; trigger: 'threshold' | 're_ask' | 'critical' }
  | { kind: 'quick'; stopKind: StopKind };

export interface StopPickerState {
  open: boolean;
  reason: StopPickerReason | null;
  loading: boolean;
  error: string | null;
  results: RankedStop[];
  /** Radius actually searched, so the sheet can offer to widen it. */
  radiusKm: number;
}

export interface SessionState {
  phase: SessionPhase;
  route: NavRoute | null;
  nav: NavState | null;
  /** Origin, chosen stops and destination, in driving order. */
  waypoints: StopWaypoint[];
  /** Remaining range in km, derived from the manual entry minus distance driven. */
  remainingRangeKm: number;
  /** Km until the next range prompt, or `null` when none is pending. */
  kmUntilNextAsk: number | null;
  routeError: string | null;
  /** Non-blocking notices: reroute failures, "range won't reach the destination". */
  notice: string | null;
  picker: StopPickerState;
  rerouting: boolean;
}

const EMPTY_PICKER: StopPickerState = {
  open: false,
  reason: null,
  loading: false,
  error: null,
  results: [],
  radiusKm: 0,
};

export interface UseNavigationSessionArgs {
  settings: Settings;
  vehicle: Vehicle;
  /** Manually entered starting range in km. */
  startRangeKm: number;
  /** Subscribes to raw GPS fixes; returns an unsubscribe function. */
  subscribeToFixes: (listener: (fix: GpsFix) => void) => () => void;
  onVoice?: (text: string) => void;
  onArrived?: () => void;
}

/**
 * Owns a driving session: the route, the turn-by-turn engine, range monitoring
 * and the stop searches that feed the prompt.
 *
 * The engine and monitor live in refs rather than state. They are updated on
 * every GPS fix (about once a second), and putting them in state would re-render
 * the tree for each one; the derived `NavState` is what React actually needs.
 */
export function useNavigationSession({
  settings,
  vehicle,
  startRangeKm,
  subscribeToFixes,
  onVoice,
  onArrived,
}: UseNavigationSessionArgs) {
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [nav, setNav] = useState<NavState | null>(null);
  const [waypoints, setWaypoints] = useState<StopWaypoint[]>([]);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<StopPickerState>(EMPTY_PICKER);
  const [rerouting, setRerouting] = useState(false);

  const engineRef = useRef<NavigationEngine | null>(null);
  const monitorRef = useRef<RangeMonitor | null>(null);
  const lastFixRef = useRef<GpsFix | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  /** Distance driven when the driver last topped up, for the range maths. */
  const rangeBaselineRef = useRef({ atDistanceM: 0, rangeKm: startRangeKm });
  /** Keeps the latest settings/vehicle/route visible to the GPS callback. */
  const settingsRef = useRef(settings);
  const vehicleRef = useRef(vehicle);
  const routeRef = useRef<NavRoute | null>(null);
  const waypointsRef = useRef<StopWaypoint[]>([]);
  /**
   * Off-route handling reroutes, and rerouting builds an engine that must
   * itself report off-route — a cycle. The indirection through a ref breaks it
   * without making either callback depend on the other's identity.
   */
  const offRouteHandlerRef = useRef<(() => void) | null>(null);

  settingsRef.current = settings;
  vehicleRef.current = vehicle;
  routeRef.current = route;
  waypointsRef.current = waypoints;

  /* ---------------------------------------------------------------- *
   * Range arithmetic
   * ---------------------------------------------------------------- */

  const snapshotFrom = useCallback((state: NavState, current: NavRoute): RangeSnapshot => {
    const baseline = rangeBaselineRef.current;
    const drivenSinceTopUpM = Math.max(0, state.progressM - baseline.atDistanceM);
    return {
      distanceDrivenM: state.progressM,
      remainingRangeKm: remainingRangeKm(baseline.rangeKm, drivenSinceTopUpM),
      // What matters is the distance to the final destination, not to the next
      // intermediate stop, so the monitor sees the whole remaining trip.
      remainingRouteM: Math.max(0, current.line.totalLengthM - state.progressM),
    };
  }, []);

  const currentRangeKm = nav && route
    ? snapshotFrom(nav, route).remainingRangeKm
    : startRangeKm;

  const kmUntilNextAsk =
    nav && route && monitorRef.current
      ? monitorRef.current.kmUntilNextAsk(snapshotFrom(nav, route))
      : null;

  /* ---------------------------------------------------------------- *
   * Stop searches
   * ---------------------------------------------------------------- */

  const runSearch = useCallback(
    async (
      reason: StopPickerReason,
      current: NavRoute,
      progressM: number,
      radiusKm: number,
    ) => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      setPicker({
        open: true,
        reason,
        loading: true,
        error: null,
        results: [],
        radiusKm,
      });

      const currentSettings = settingsRef.current;
      const currentVehicle = vehicleRef.current;

      // How far ahead to look. A range prompt should not offer a station
      // 300 km away, so the window is bounded by what the tank can still reach.
      const rangeWindowM = Math.max(
        20_000,
        Math.min(150_000, currentRangeKm * 1000 * 0.9),
      );
      const window = {
        fromM: progressM,
        toM: Math.min(current.line.totalLengthM, progressM + rangeWindowM),
        radiusKm,
      };

      try {
        const collected: Stop[] = [];
        const warnings: string[] = [];

        if (reason.kind === 'quick' && (reason.stopKind === 'rest_area' || reason.stopKind === 'toilets')) {
          const response = await searchAmenities(current.line, {
            ...window,
            // A toilet stop is a "soon" decision, not a 150 km-ahead one.
            toM: Math.min(current.line.totalLengthM, progressM + 60_000),
            kinds: [reason.stopKind],
            signal: controller.signal,
          });
          collected.push(...response.stops);
          warnings.push(...response.meta.warnings);
        } else {
          const kinds =
            reason.kind === 'quick'
              ? [reason.stopKind as 'fuel' | 'charging']
              : refuelStopKinds(currentVehicle.kind);

          const searches = kinds.map(async (kind) => {
            if (kind === 'fuel') {
              const response = await searchFuel(current.line, {
                ...window,
                fuel: currentVehicle.fuel ?? 'e10',
                signal: controller.signal,
              });
              return response;
            }
            return searchCharging(current.line, {
              ...window,
              connectors: currentVehicle.connectors,
              minPowerKw: currentSettings.minChargingPowerKw,
              signal: controller.signal,
            });
          });

          const responses = await Promise.allSettled(searches);
          for (const [index, result] of responses.entries()) {
            if (result.status === 'fulfilled') {
              collected.push(...result.value.stops);
              warnings.push(...result.value.meta.warnings);
            } else if (result.reason instanceof StopSearchError) {
              // A hybrid searches two sources; one failing must not hide the other.
              warnings.push(`${kinds[index]}: ${result.reason.message}`);
            }
          }
          // Every source failed — that is an error, not a warning.
          if (collected.length === 0 && responses.every((r) => r.status === 'rejected')) {
            const first = responses[0];
            throw first && first.status === 'rejected'
              ? first.reason
              : new Error('Keine Quelle erreichbar.');
          }
        }

        if (controller.signal.aborted) return;

        const ranked = dedupeNearby(
          rankStops(current.line, collected, {
            progressM,
            maxOffsetM: radiusKm * 1000,
            detourPenaltyCtPerKm: currentSettings.detourPenaltyCtPerKm,
            fuel: currentVehicle.fuel ?? 'e10',
            minPowerKw: currentSettings.minChargingPowerKw,
            maxAheadM: window.toM - progressM,
          }),
        ).slice(0, currentSettings.maxSuggestions);

        setPicker({
          open: true,
          reason,
          loading: false,
          error:
            ranked.length === 0
              ? `Im Radius von ${radiusKm} km wurde nichts gefunden.` +
                (warnings.length > 0 ? ` (${warnings[0]})` : '')
              : null,
          results: ranked,
          radiusKm,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPicker({
          open: true,
          reason,
          loading: false,
          error:
            error instanceof StopSearchError
              ? error.message
              : 'Suche fehlgeschlagen. Bitte erneut versuchen.',
          results: [],
          radiusKm,
        });
      }
    },
    [currentRangeKm],
  );

  /* ---------------------------------------------------------------- *
   * Range events → prompt + notification
   * ---------------------------------------------------------------- */

  const handleRangeEvents = useCallback(
    (events: RangeEvent[], current: NavRoute, progressM: number) => {
      for (const event of events) {
        if (event.type === 'cannot_reach_destination') {
          setNotice(
            `Die eingegebene Reichweite deckt die Route nicht ab — es fehlen etwa ` +
              `${Math.round(event.shortfallKm)} km. Ein Stopp wird unterwegs nötig.`,
          );
          continue;
        }

        const isElectric = vehicleRef.current.kind === 'electric';
        const noun = isElectric ? 'laden' : 'tanken';
        const body =
          event.reason === 'critical'
            ? `Nur noch ${Math.round(event.snapshot.remainingRangeKm)} km Reichweite. Jetzt ${noun}?`
            : `${Math.round(event.snapshot.remainingRangeKm)} km Reichweite übrig. Möchtest du zum ${
                isElectric ? 'Laden' : 'Tanken'
              } fahren?`;

        if (settingsRef.current.pushNotifications) {
          void showLocalNotification({
            title: event.reason === 'critical' ? 'Reichweite kritisch' : 'Reichweite niedrig',
            body,
            tag: 'range-prompt',
            url: '/',
            actions: [
              { action: 'refuel', title: 'Ja, Stopp suchen' },
              { action: 'dismiss', title: 'Später' },
            ],
          });
        }

        void runSearch(
          { kind: 'range', trigger: event.reason },
          current,
          progressM,
          settingsRef.current.searchRadiusKm,
        );
      }
    },
    [runSearch],
  );

  /* ---------------------------------------------------------------- *
   * Engine wiring
   * ---------------------------------------------------------------- */

  /**
   * The callbacks every engine instance needs. Both `start` and a reroute build
   * an engine, and they must behave identically — a reroute that quietly lost
   * voice guidance or waypoint detection would be hard to notice and worse than
   * no reroute at all.
   */
  const engineEvents = useCallback(
    () => ({
      onVoice: (announcement: string) => onVoice?.(announcement),
      onArrived: () => {
        setPhase('arrived');
        onArrived?.();
      },
      onWaypointReached: (legIndex: number) => {
        setWaypoints((prev) =>
          prev.map((waypoint, index) =>
            // Leg N ends at waypoint N+1; index 0 is the origin.
            index === legIndex + 1 && waypoint.reachedAt == null
              ? { ...waypoint, reachedAt: Date.now() }
              : waypoint,
          ),
        );
        // A stop was reached: re-arm the monitor so the next threshold crossing
        // asks again once the driver has topped up and moved on.
        monitorRef.current?.resume();
      },
      onOffRoute: () => offRouteHandlerRef.current?.(),
    }),
    [onVoice, onArrived],
  );

  /* ---------------------------------------------------------------- *
   * Route planning
   * ---------------------------------------------------------------- */

  const planRoute = useCallback(
    async (origin: LngLat, destination: LngLat, originName: string, destinationName: string) => {
      setPhase('routing');
      setRouteError(null);
      setNotice(null);
      try {
        const planned = await fetchRoute([origin, destination], {
          avoid: settingsRef.current.avoid,
        });
        setRoute(planned);
        setWaypoints([
          { id: 'origin', kind: 'origin', name: originName, location: origin },
          { id: 'destination', kind: 'destination', name: destinationName, location: destination },
        ]);
        setPhase('ready');
        return planned;
      } catch (error) {
        setRouteError(
          error instanceof DirectionsError
            ? error.message
            : 'Route konnte nicht berechnet werden.',
        );
        setPhase('idle');
        return null;
      }
    },
    [],
  );

  const start = useCallback(() => {
    const current = routeRef.current;
    if (!current) return;
    rangeBaselineRef.current = { atDistanceM: 0, rangeKm: startRangeKm };
    monitorRef.current = new RangeMonitor({
      thresholdKm: settingsRef.current.rangeThresholdKm,
      reAskIntervalKm: settingsRef.current.reAskIntervalKm,
    });
    engineRef.current = new NavigationEngine(current, engineEvents());
    setPhase('navigating');
  }, [startRangeKm, engineEvents]);

  const stop = useCallback(() => {
    engineRef.current = null;
    monitorRef.current = null;
    searchAbortRef.current?.abort();
    setPhase(route ? 'ready' : 'idle');
    setNav(null);
    setPicker(EMPTY_PICKER);
  }, [route]);

  const reset = useCallback(() => {
    engineRef.current = null;
    monitorRef.current = null;
    searchAbortRef.current?.abort();
    setRoute(null);
    setNav(null);
    setWaypoints([]);
    setPicker(EMPTY_PICKER);
    setNotice(null);
    setRouteError(null);
    setPhase('idle');
  }, []);

  /* ---------------------------------------------------------------- *
   * Rerouting: off-route recovery and inserting a chosen stop
   * ---------------------------------------------------------------- */

  /**
   * Recalculates from the driver's current position through the remaining
   * waypoints. Used both when the driver leaves the route and when a stop is
   * inserted, because both cases need the same thing: a fresh route that starts
   * where the car actually is and still ends at the destination.
   */
  const rebuildRoute = useCallback(
    async (remaining: StopWaypoint[], keepProgress: boolean) => {
      const fix = lastFixRef.current;
      if (!fix) return false;

      const from: LngLat = { lng: fix.position[0], lat: fix.position[1] };
      const coordinates = [from, ...remaining.map((w) => w.location)];
      if (coordinates.length > MAX_WAYPOINTS) {
        setNotice(`Zu viele Zwischenstopps (maximal ${MAX_WAYPOINTS - 1}).`);
        return false;
      }

      setRerouting(true);
      try {
        const planned = await fetchRoute(coordinates, {
          avoid: settingsRef.current.avoid,
          originBearing: fix.headingDeg,
        });
        setRoute(planned);
        routeRef.current = planned;
        setWaypoints([
          {
            id: 'origin',
            kind: 'origin',
            name: 'Aktuelle Position',
            location: from,
            reachedAt: Date.now(),
          },
          ...remaining,
        ]);

        // A new route starts at the car, so the range baseline has to move with
        // it — otherwise the distance already driven would be counted twice.
        const drivenBefore = engineRef.current?.progress ?? 0;
        const baseline = rangeBaselineRef.current;
        const usedKm = keepProgress
          ? Math.max(0, drivenBefore - baseline.atDistanceM) / 1000
          : 0;
        rangeBaselineRef.current = {
          atDistanceM: 0,
          rangeKm: Math.max(0, baseline.rangeKm - usedKm),
        };

        // Carry the monitor across so a snooze survives a reroute.
        engineRef.current = new NavigationEngine(planned, engineEvents());
        setRerouting(false);
        return true;
      } catch (error) {
        setRerouting(false);
        setNotice(
          error instanceof DirectionsError
            ? `Neuberechnung fehlgeschlagen: ${error.message}`
            : 'Route konnte nicht neu berechnet werden.',
        );
        return false;
      }
    },
    [engineEvents],
  );

  /** Debounces off-route reroutes so a lane change cannot trigger a storm. */
  const lastRerouteAtRef = useRef(0);
  const handleOffRoute = useCallback(() => {
    if (Date.now() - lastRerouteAtRef.current < 15_000) return;
    lastRerouteAtRef.current = Date.now();
    const remaining = waypointsRef.current.filter((w) => w.reachedAt == null);
    void rebuildRoute(remaining, true);
  }, [rebuildRoute]);

  offRouteHandlerRef.current = handleOffRoute;

  /* ---------------------------------------------------------------- *
   * Picker actions
   * ---------------------------------------------------------------- */

  /** Inserts the chosen stop before the remaining waypoints and reroutes. */
  const chooseStop = useCallback(
    async (ranked: RankedStop) => {
      const remaining = waypointsRef.current.filter((w) => w.reachedAt == null);
      const inserted: StopWaypoint = {
        id: ranked.stop.id,
        kind: ranked.stop.kind,
        name: ranked.stop.name,
        location: ranked.stop.location,
      };
      setPicker(EMPTY_PICKER);
      monitorRef.current?.acceptStop();
      const ok = await rebuildRoute([inserted, ...remaining], true);
      if (!ok) monitorRef.current?.resume();
      return ok;
    },
    [rebuildRoute],
  );

  const declineStop = useCallback(() => {
    const current = routeRef.current;
    const state = nav;
    if (monitorRef.current && current && state) {
      monitorRef.current.decline(snapshotFrom(state, current));
    }
    setPicker(EMPTY_PICKER);
  }, [nav, snapshotFrom]);

  const closePicker = useCallback(() => {
    searchAbortRef.current?.abort();
    setPicker(EMPTY_PICKER);
  }, []);

  /** Re-runs the current search with a wider radius. */
  const widenSearch = useCallback(
    (radiusKm: number) => {
      const current = routeRef.current;
      const reason = picker.reason;
      if (!current || !reason) return;
      void runSearch(reason, current, engineRef.current?.progress ?? 0, radiusKm);
    },
    [picker.reason, runSearch],
  );

  /** The quick buttons: search from here forward, ignoring the range threshold. */
  const quickSearch = useCallback(
    (stopKind: StopKind) => {
      const current = routeRef.current;
      if (!current) return;
      void runSearch(
        { kind: 'quick', stopKind },
        current,
        engineRef.current?.progress ?? 0,
        settingsRef.current.searchRadiusKm,
      );
    },
    [runSearch],
  );

  /** Driver refuelled: record the new range and re-arm the monitor. */
  const recordTopUp = useCallback((newRangeKm: number) => {
    rangeBaselineRef.current = {
      atDistanceM: engineRef.current?.progress ?? 0,
      rangeKm: newRangeKm,
    };
    monitorRef.current?.resume();
    setNotice(null);
  }, []);

  /* ---------------------------------------------------------------- *
   * GPS wiring
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (phase !== 'navigating') return;
    return subscribeToFixes((fix) => {
      lastFixRef.current = fix;
      const engine = engineRef.current;
      const current = routeRef.current;
      if (!engine || !current) return;

      const state = engine.update(fix);
      setNav(state);

      const monitor = monitorRef.current;
      if (!monitor) return;
      const events = monitor.update(snapshotFrom(state, current));
      if (events.length > 0) handleRangeEvents(events, current, state.progressM);
    });
  }, [phase, subscribeToFixes, snapshotFrom, handleRangeEvents]);

  /** Applies changed settings to a running monitor. */
  useEffect(() => {
    monitorRef.current?.reconfigure({
      thresholdKm: settings.rangeThresholdKm,
      reAskIntervalKm: settings.reAskIntervalKm,
    });
  }, [settings.rangeThresholdKm, settings.reAskIntervalKm]);

  /** A fresh manual range entry while planning resets the baseline. */
  useEffect(() => {
    if (phase === 'idle' || phase === 'ready') {
      rangeBaselineRef.current = { atDistanceM: 0, rangeKm: startRangeKm };
    }
  }, [phase, startRangeKm]);

  const state: SessionState = useMemo(
    () => ({
      phase,
      route,
      nav,
      waypoints,
      remainingRangeKm: currentRangeKm,
      kmUntilNextAsk,
      routeError,
      notice,
      picker,
      rerouting,
    }),
    [
      phase,
      route,
      nav,
      waypoints,
      currentRangeKm,
      kmUntilNextAsk,
      routeError,
      notice,
      picker,
      rerouting,
    ],
  );

  return {
    ...state,
    planRoute,
    start,
    stop,
    reset,
    chooseStop,
    declineStop,
    closePicker,
    widenSearch,
    quickSearch,
    recordTopUp,
    dismissNotice: () => setNotice(null),
    /** The engine's measured line, for drawing the driven/remaining split. */
    measuredLine: route ? route.line : measureLine([]),
  };
}
