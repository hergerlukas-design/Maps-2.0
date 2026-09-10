import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StopKind } from '@shared/types';
import type { PlaceRef, StopWaypoint } from '@/types/domain';
import { vehicleNeedsCharging, vehicleNeedsFuel } from '@/types/domain';
import { hasSupabase } from '@/config/env';
import { useAppStore, useActiveVehicle } from '@/state/useAppStore';
import { getSession, onAuthChange } from '@/services/supabase/auth';
import { describeLocation } from '@/services/mapbox/geocoding';
import { finishTrip, startTrip } from '@/services/supabase/repository';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useVoice } from '@/hooks/useVoice';
import { useNavigationSession } from '@/hooks/useNavigationSession';
import { MapView, type CameraMode } from '@/components/map/MapView';
import { ManeuverBanner } from '@/components/nav/ManeuverBanner';
import { NavBottomBar } from '@/components/nav/NavBottomBar';
import { StopSheet } from '@/components/nav/StopSheet';
import { TopUpDialog } from '@/components/nav/TopUpDialog';
import { RoutePlanner } from '@/components/planner/RoutePlanner';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { AccountPanel } from '@/components/auth/AccountPanel';

export default function App() {
  const settings = useAppStore((state) => state.settings);
  const settingsSyncing = useAppStore((state) => state.settingsSyncing);
  const settingsError = useAppStore((state) => state.settingsError);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const resetSettings = useAppStore((state) => state.resetSettings);
  const user = useAppStore((state) => state.user);
  const setUser = useAppStore((state) => state.setUser);
  const setAuthReady = useAppStore((state) => state.setAuthReady);
  const accountsAvailable = useAppStore((state) => state.accountsAvailable);
  const hydrateFromAccount = useAppStore((state) => state.hydrateFromAccount);
  const vehicles = useAppStore((state) => state.vehicles);
  const setActiveVehicle = useAppStore((state) => state.setActiveVehicle);
  const updateGuestVehicle = useAppStore((state) => state.updateGuestVehicle);
  const plan = useAppStore((state) => state.plan);
  const setPlan = useAppStore((state) => state.setPlan);
  const swapPlanEnds = useAppStore((state) => state.swapPlanEnds);
  const vehicle = useActiveVehicle();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const [plannerCollapsed, setPlannerCollapsed] = useState(false);
  const [highlightedStopId, setHighlightedStopId] = useState<string | null>(null);
  const [reachedStop, setReachedStop] = useState<StopWaypoint | null>(null);
  const tripIdRef = useRef<string | null>(null);

  const geo = useGeolocation();
  const voice = useVoice(settings.voiceGuidance);

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!hasSupabase) return;
    void getSession().then((session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
      if (session?.user) void hydrateFromAccount(session.user.id);
    });
    return onAuthChange((nextUser) => {
      setUser(nextUser);
      if (nextUser) void hydrateFromAccount(nextUser.id);
    });
  }, [setUser, setAuthReady, hydrateFromAccount]);

  /* ---------------------------------------------------------------- *
   * Session
   * ---------------------------------------------------------------- */

  const session = useNavigationSession({
    settings,
    vehicle,
    startRangeKm: plan.remainingRangeKm,
    subscribeToFixes: geo.subscribe,
    onVoice: (text) => voice.speak(text, { interrupt: true }),
    onArrived: () => {
      voice.speak('Sie haben Ihr Ziel erreicht.', { interrupt: true });
      geo.stop();
    },
  });

  // Only hold the wake lock while actually driving.
  useWakeLock(settings.keepScreenAwake && session.phase === 'navigating');

  /**
   * Asks for a fresh range figure once a fuel/charging stop is reached. Without
   * it the monitor keeps counting down from the pre-stop number and would ask
   * again a few kilometres later.
   */
  const previousWaypointsRef = useRef<StopWaypoint[]>([]);
  useEffect(() => {
    const previous = previousWaypointsRef.current;
    previousWaypointsRef.current = session.waypoints;
    const justReached = session.waypoints.find(
      (waypoint) =>
        waypoint.reachedAt != null &&
        (waypoint.kind === 'fuel' || waypoint.kind === 'charging') &&
        !previous.some((old) => old.id === waypoint.id && old.reachedAt != null),
    );
    if (justReached) setReachedStop(justReached);
  }, [session.waypoints]);

  /* ---------------------------------------------------------------- *
   * Notification actions ("Ja, Stopp suchen" from a system notification)
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; action?: string } | undefined;
      if (data?.type !== 'NOTIFICATION_ACTION') return;
      if (data.action === 'refuel' && session.phase === 'navigating') {
        session.quickSearch(vehicle.kind === 'electric' ? 'charging' : 'fuel');
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [session, vehicle.kind]);

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  const useCurrentLocation = useCallback(async (): Promise<PlaceRef | null> => {
    const fix = await geo.getCurrent();
    if (!fix) return null;
    const location = { lng: fix.position[0], lat: fix.position[1] };
    const address = await describeLocation(location);
    return {
      id: 'current-location',
      name: 'Mein Standort',
      ...(address ? { address } : {}),
      location,
    };
  }, [geo]);

  const calculate = useCallback(() => {
    if (!plan.origin || !plan.destination) return;
    void session
      .planRoute(
        plan.origin.location,
        plan.destination.location,
        plan.origin.name,
        plan.destination.name,
      )
      // Nach dem Berechnen einklappen: Die berechnete Route will man sehen,
      // nicht das Formular, das sie erzeugt hat.
      .then((planned) => {
        if (planned) setPlannerCollapsed(true);
      });
  }, [plan.origin, plan.destination, session]);

  const startNavigation = useCallback(() => {
    geo.start();
    setCameraMode('follow');
    session.start();

    if (user && session.route && plan.origin && plan.destination) {
      void startTrip(user.id, {
        vehicleId: vehicle.userId ? vehicle.id : null,
        originName: plan.origin.name,
        originLocation: plan.origin.location,
        destinationName: plan.destination.name,
        destinationLocation: plan.destination.location,
        distanceM: session.route.distanceM,
        durationS: session.route.durationS,
        startRangeKm: plan.remainingRangeKm,
      }).then((id) => {
        tripIdRef.current = id;
      });
    }
  }, [geo, session, user, plan, vehicle]);

  const endNavigation = useCallback(() => {
    geo.stop();
    voice.cancel();
    session.stop();
    setReachedStop(null);
    const tripId = tripIdRef.current;
    if (tripId) {
      void finishTrip(
        tripId,
        session.waypoints
          .filter((w) => w.kind === 'fuel' || w.kind === 'charging')
          .map((w) => ({ id: w.id, kind: w.kind as StopKind, name: w.name })),
      );
      tripIdRef.current = null;
    }
  }, [geo, voice, session]);

  const proximity = useMemo(
    () => (geo.fix ? { lng: geo.fix.position[0], lat: geo.fix.position[1] } : null),
    [geo.fix],
  );

  const navigating = session.phase === 'navigating' || session.phase === 'arrived';

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-950">
      <MapView
        line={session.route?.line ?? null}
        nav={session.nav}
        waypoints={session.waypoints}
        candidates={session.picker.open ? session.picker.results : []}
        highlightedStopId={highlightedStopId}
        cameraMode={cameraMode}
        onCameraModeChange={setCameraMode}
        onStopClick={(stop) => setHighlightedStopId(stop.id)}
      />

      {navigating ? (
        <NavigatingLayer
          session={session}
          cameraMode={cameraMode}
          onCameraModeChange={setCameraMode}
          geoStatus={geo.status}
          geoError={geo.error}
          geoStaleForS={geo.staleForS}
          onEnd={endNavigation}
          onOpenSettings={() => setSettingsOpen(true)}
          onHighlight={setHighlightedStopId}
          showFuel={vehicleNeedsFuel(vehicle.kind)}
          showCharging={vehicleNeedsCharging(vehicle.kind)}
          fuel={vehicle.fuel ?? 'e10'}
          reAskIntervalKm={settings.reAskIntervalKm}
          thresholdKm={settings.rangeThresholdKm}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col">
          <div className="pointer-events-none flex-1" />
          <div
            className={`pointer-events-auto overflow-hidden rounded-t-[var(--radius-sheet)] bg-ink-950/95 backdrop-blur-xl transition-[max-height] duration-300 ${
              plannerCollapsed ? 'max-h-40' : 'max-h-[85%]'
            }`}
          >
            <RoutePlanner
              origin={plan.origin}
              destination={plan.destination}
              remainingRangeKm={plan.remainingRangeKm}
              vehicle={vehicle}
              vehicles={vehicles}
              route={session.route}
              routing={session.phase === 'routing'}
              routeError={session.routeError}
              proximity={proximity}
              onOriginChange={(origin) => setPlan({ origin })}
              onDestinationChange={(destination) => setPlan({ destination })}
              onSwap={swapPlanEnds}
              onRangeChange={(remainingRangeKm) => setPlan({ remainingRangeKm })}
              onVehicleChange={setActiveVehicle}
              onVehiclePatch={updateGuestVehicle}
              onUseCurrentLocation={useCurrentLocation}
              onCalculate={calculate}
              onStart={startNavigation}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenAccount={() => setAccountOpen(true)}
              collapsed={plannerCollapsed}
              onToggleCollapsed={() => setPlannerCollapsed((value) => !value)}
            />
          </div>
        </div>
      )}

      <TopUpDialog
        stop={reachedStop}
        suggestedRangeKm={vehicle.typicalRangeKm ?? plan.remainingRangeKm}
        onConfirm={(rangeKm) => {
          session.recordTopUp(rangeKm);
          setReachedStop(null);
        }}
        onSkip={() => setReachedStop(null)}
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        syncing={settingsSyncing}
        syncError={settingsError}
        signedIn={user !== null}
        onChange={updateSettings}
        onReset={resetSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <AccountPanel
        open={accountOpen}
        user={user}
        accountsAvailable={accountsAvailable}
        onClose={() => setAccountOpen(false)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The overlay shown while driving
 * ------------------------------------------------------------------ */

interface NavigatingLayerProps {
  session: ReturnType<typeof useNavigationSession>;
  cameraMode: CameraMode;
  onCameraModeChange: (mode: CameraMode) => void;
  geoStatus: ReturnType<typeof useGeolocation>['status'];
  geoError: string | null;
  geoStaleForS: number;
  onEnd: () => void;
  onOpenSettings: () => void;
  onHighlight: (id: string | null) => void;
  showFuel: boolean;
  showCharging: boolean;
  fuel: 'e5' | 'e10' | 'diesel';
  reAskIntervalKm: number;
  thresholdKm: number;
}

function NavigatingLayer({
  session,
  cameraMode,
  onCameraModeChange,
  geoStatus,
  geoError,
  geoStaleForS,
  onEnd,
  onOpenSettings,
  onHighlight,
  showFuel,
  showCharging,
  fuel,
  reAskIntervalKm,
  thresholdKm,
}: NavigatingLayerProps) {
  const waitingForGps = session.nav === null;

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">
      <div
        className="pointer-events-auto px-3"
        style={{ paddingTop: 'calc(0.5rem + var(--safe-top))' }}
      >
        <ManeuverBanner
          maneuver={session.nav?.maneuver ?? null}
          isOffRoute={session.nav?.isOffRoute ?? false}
          rerouting={session.rerouting}
        />

        {(geoError ?? geoStaleForS > 12) && (
          <p className="panel mt-2 rounded-2xl px-3 py-2 text-xs text-warn-500">
            {geoError ?? `Kein GPS-Signal seit ${geoStaleForS} s — Position kann veraltet sein.`}
          </p>
        )}

        {session.notice && (
          <div className="panel mt-2 flex items-start gap-2 rounded-2xl px-3 py-2">
            <p className="flex-1 text-xs text-warn-500">{session.notice}</p>
            <button
              type="button"
              onClick={session.dismissNotice}
              aria-label="Hinweis schließen"
              className="shrink-0 text-ink-400"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/*
        Kamera-Schaltflächen am rechten Rand.

        Der Container muss `pointer-events-none` bleiben: Er füllt über
        `flex-1` den gesamten Bereich zwischen Banner und Leiste, und mit
        `pointer-events-auto` fängt dieses unsichtbare Feld jede Berührung ab,
        die eigentlich der Karte gilt — Verschieben, Zoomen und Drehen wären
        auf dem größten Teil des Bildschirms tot. Nur die Schaltfläche selbst
        nimmt Eingaben an.
      */}
      <div className="pointer-events-none flex flex-1 flex-col items-end justify-center gap-2 px-3">
        {/*
          Nach einer eigenen Geste steht die Kamera auf `free`. Dann ist die
          wichtigste Handlung, wieder zum Fahrzeug zurückzufinden — deshalb
          wechselt die Schaltfläche dort ihre Bedeutung und wird hervorgehoben.
          Ohne sie wäre Zoomen eine Sackgasse.
        */}
        <button
          type="button"
          onClick={() => onCameraModeChange(cameraMode === 'follow' ? 'overview' : 'follow')}
          className={`panel pointer-events-auto touch-target grid place-items-center rounded-2xl px-3 active:text-ink-100 ${
            cameraMode === 'free'
              ? 'border-route-500/70 text-route-500'
              : 'text-ink-200'
          }`}
          aria-label={
            cameraMode === 'free'
              ? 'Zurück zur Fahrzeugposition'
              : cameraMode === 'follow'
                ? 'Gesamtroute anzeigen'
                : 'Ansicht folgt dem Fahrzeug'
          }
        >
          {cameraMode === 'follow' ? (
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.9}>
              <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.9}>
              <path d="M12 3 5 20l7-4 7 4-7-17Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>

      <div className="pointer-events-auto">
        {session.picker.open ? (
          <StopSheet
            picker={session.picker}
            fuel={fuel}
            remainingRangeKm={session.remainingRangeKm}
            reAskIntervalKm={reAskIntervalKm}
            onChoose={(ranked) => void session.chooseStop(ranked)}
            onDecline={session.declineStop}
            onClose={session.closePicker}
            onWiden={session.widenSearch}
            onHighlight={onHighlight}
          />
        ) : session.nav ? (
          <NavBottomBar
            nav={session.nav}
            waypoints={session.waypoints}
            remainingRangeKm={session.remainingRangeKm}
            thresholdKm={thresholdKm}
            kmUntilNextAsk={session.kmUntilNextAsk}
            showFuel={showFuel}
            showCharging={showCharging}
            searchBusy={session.picker.loading}
            onQuickSearch={session.quickSearch}
            onEnd={onEnd}
            onOpenSettings={onOpenSettings}
          />
        ) : (
          <div
            className="panel rounded-t-[var(--radius-sheet)] px-4 pt-4"
            style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}
          >
            <p className="text-sm font-semibold">
              {waitingForGps && geoStatus === 'denied'
                ? 'Standortzugriff nötig'
                : 'Warte auf GPS-Signal …'}
            </p>
            <p className="mt-1 text-xs text-ink-400">
              {geoError ??
                'Die Navigation startet, sobald die erste Position bestimmt ist.'}
            </p>
            <button
              type="button"
              onClick={onEnd}
              className="touch-target mt-3 w-full rounded-2xl bg-ink-800 px-4 text-sm font-semibold text-ink-200 active:bg-ink-700"
            >
              Abbrechen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
