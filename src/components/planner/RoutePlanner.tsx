import { useMemo } from 'react';
import type { ConnectorType, FuelKind, LngLat, VehicleKind } from '@shared/types';
import { CONNECTOR_LABELS, FUEL_KINDS, FUEL_LABELS } from '@shared/types';
import type { PlaceRef, Vehicle } from '@/types/domain';
import { vehicleNeedsCharging, vehicleNeedsFuel } from '@/types/domain';
import { formatDistance, formatDuration } from '@/lib/format';
import { VEHICLE_KIND_LABELS } from '@/state/useAppStore';
import type { NavRoute } from '@/services/mapbox/directions';
import { PlaceInput } from './PlaceInput';

interface RoutePlannerProps {
  origin: PlaceRef | null;
  destination: PlaceRef | null;
  remainingRangeKm: number;
  vehicle: Vehicle;
  vehicles: Vehicle[];
  route: NavRoute | null;
  routing: boolean;
  routeError: string | null;
  proximity: LngLat | null;
  onOriginChange: (place: PlaceRef | null) => void;
  onDestinationChange: (place: PlaceRef | null) => void;
  onSwap: () => void;
  onRangeChange: (km: number) => void;
  onVehicleChange: (id: string) => void;
  onVehiclePatch: (patch: Partial<Vehicle>) => void;
  onUseCurrentLocation: () => Promise<PlaceRef | null>;
  onCalculate: () => void;
  onStart: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
}

const CONNECTOR_CHOICES: ConnectorType[] = [
  'ccs',
  'type2',
  'chademo',
  'tesla_supercharger',
];

/**
 * The pre-drive screen: where to, how much range is left, and what car.
 *
 * Range is a free-text number rather than a slider because the driver is reading
 * it off the dashboard and knows the exact figure — the briefing is explicit that
 * this is entered by hand, not read from the vehicle.
 */
export function RoutePlanner(props: RoutePlannerProps) {
  const {
    origin,
    destination,
    remainingRangeKm,
    vehicle,
    vehicles,
    route,
    routing,
    routeError,
    proximity,
  } = props;

  const canCalculate = origin !== null && destination !== null && !routing;

  const coverage = useMemo(() => {
    if (!route) return null;
    const routeKm = route.distanceM / 1000;
    const shortfallKm = routeKm - remainingRangeKm;
    return {
      routeKm,
      covered: shortfallKm <= 0,
      shortfallKm: Math.max(0, shortfallKm),
      // How many stops the trip needs, assuming each one restores the entered range.
      stops: shortfallKm <= 0 ? 0 : Math.ceil(shortfallKm / Math.max(50, remainingRangeKm)),
    };
  }, [route, remainingRangeKm]);

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex items-center justify-between gap-3 px-4 pb-2"
        style={{ paddingTop: 'calc(0.75rem + var(--safe-top))' }}
      >
        <div>
          <h1 className="text-lg leading-tight font-bold">Reichweite</h1>
          <p className="text-xs text-ink-400">Tank- &amp; Ladestopp-Navigation</p>
        </div>
        <div className="flex gap-2">
          <IconButton label="Konto" onClick={props.onOpenAccount}>
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0" strokeLinecap="round" />
          </IconButton>
          <IconButton label="Einstellungen" onClick={props.onOpenSettings}>
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6h.1A2 2 0 1 1 13 3v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
              strokeLinecap="round"
            />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {/* Route ------------------------------------------------------ */}
        {/*
          `relative z-20` is load-bearing: the panels below create their own
          stacking contexts via `backdrop-filter`, so without it the geocoding
          suggestions for the destination field paint *behind* the range panel
          and cannot be clicked.
        */}
        <section className="panel relative z-20 space-y-3 rounded-2xl p-4">
          <PlaceInput
            label="Start"
            placeholder="Adresse oder Ort"
            value={origin}
            proximity={proximity}
            onChange={props.onOriginChange}
            onUseCurrentLocation={props.onUseCurrentLocation}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={props.onSwap}
              className="touch-target grid place-items-center rounded-xl bg-ink-800 px-3 text-ink-300 active:bg-ink-700"
              aria-label="Start und Ziel tauschen"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <PlaceInput
            label="Ziel"
            placeholder="Adresse oder Ort"
            value={destination}
            proximity={proximity}
            onChange={props.onDestinationChange}
          />
        </section>

        {/* Range ------------------------------------------------------ */}
        <section className="panel space-y-2 rounded-2xl p-4">
          <label
            htmlFor="range-input"
            className="block text-xs font-medium tracking-wide text-ink-300 uppercase"
          >
            Aktuelle Reichweite
          </label>
          <div className="flex items-center gap-3">
            <input
              id="range-input"
              type="number"
              inputMode="numeric"
              min={0}
              max={2000}
              step={5}
              value={remainingRangeKm}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                props.onRangeChange(
                  Number.isFinite(parsed) ? Math.max(0, Math.min(2000, parsed)) : 0,
                );
              }}
              className="tabular touch-target w-28 rounded-xl border border-ink-700 bg-ink-850 px-3
                         text-lg font-semibold text-ink-100"
            />
            <span className="text-sm text-ink-400">km laut Bordanzeige</span>
          </div>
          {vehicle.typicalRangeKm != null && (
            <button
              type="button"
              onClick={() => props.onRangeChange(vehicle.typicalRangeKm!)}
              className="text-xs text-route-500 underline-offset-2 hover:underline"
            >
              Auf volle Reichweite setzen ({vehicle.typicalRangeKm} km)
            </button>
          )}
        </section>

        {/* Vehicle ---------------------------------------------------- */}
        <section className="panel space-y-3 rounded-2xl p-4">
          {vehicles.length > 1 && (
            <div>
              <label
                htmlFor="vehicle-select"
                className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase"
              >
                Fahrzeug
              </label>
              <select
                id="vehicle-select"
                value={vehicle.id}
                onChange={(event) => props.onVehicleChange(event.target.value)}
                className="touch-target w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100"
              >
                {vehicles.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {VEHICLE_KIND_LABELS[entry.kind]}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase">
              Antrieb
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(['combustion', 'electric', 'hybrid'] as VehicleKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={vehicle.kind === kind}
                  onClick={() => props.onVehiclePatch({ kind })}
                  className={`touch-target rounded-xl border px-2 text-sm font-medium transition-colors ${
                    vehicle.kind === kind
                      ? 'border-route-500 bg-route-500/15 text-route-500'
                      : 'border-ink-700 bg-ink-850 text-ink-300 active:bg-ink-800'
                  }`}
                >
                  {VEHICLE_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
          </div>

          {vehicleNeedsFuel(vehicle.kind) && (
            <div>
              <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase">
                Kraftstoff
              </span>
              <div className="grid grid-cols-3 gap-2">
                {FUEL_KINDS.map((fuel: FuelKind) => (
                  <button
                    key={fuel}
                    type="button"
                    aria-pressed={vehicle.fuel === fuel}
                    onClick={() => props.onVehiclePatch({ fuel })}
                    className={`touch-target rounded-xl border px-2 text-sm font-medium transition-colors ${
                      vehicle.fuel === fuel
                        ? 'border-go-500 bg-go-500/15 text-go-500'
                        : 'border-ink-700 bg-ink-850 text-ink-300 active:bg-ink-800'
                    }`}
                  >
                    {FUEL_LABELS[fuel]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {vehicleNeedsCharging(vehicle.kind) && (
            <div>
              <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase">
                Steckertypen
              </span>
              <div className="flex flex-wrap gap-2">
                {CONNECTOR_CHOICES.map((connector) => {
                  const active = vehicle.connectors.includes(connector);
                  return (
                    <button
                      key={connector}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        props.onVehiclePatch({
                          connectors: active
                            ? vehicle.connectors.filter((c) => c !== connector)
                            : [...vehicle.connectors, connector],
                        })
                      }
                      className={`touch-target rounded-xl border px-3 text-sm font-medium transition-colors ${
                        active
                          ? 'border-charge-500 bg-charge-500/15 text-charge-500'
                          : 'border-ink-700 bg-ink-850 text-ink-300 active:bg-ink-800'
                      }`}
                    >
                      {CONNECTOR_LABELS[connector]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-ink-400">
                Ohne Auswahl werden alle Steckertypen angezeigt.
              </p>
            </div>
          )}
        </section>

        {/* Result ----------------------------------------------------- */}
        {routeError && (
          <p className="rounded-2xl border border-alert-600/50 bg-alert-600/10 px-3 py-2.5 text-sm text-alert-500">
            {routeError}
          </p>
        )}

        {route && coverage && (
          <section className="panel space-y-2 rounded-2xl p-4">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-xs tracking-wide text-ink-400 uppercase">Route</p>
                <p className="tabular text-xl font-bold">
                  {formatDistance(route.distanceM)}
                </p>
              </div>
              <p className="tabular text-sm text-ink-300">
                ca. {formatDuration(route.durationS)}
              </p>
            </div>

            <p
              className={`text-sm ${coverage.covered ? 'text-go-500' : 'text-warn-500'}`}
            >
              {coverage.covered
                ? 'Die eingegebene Reichweite deckt die gesamte Route ab.'
                : `Es fehlen etwa ${Math.round(coverage.shortfallKm)} km — ` +
                  `mindestens ${coverage.stops} Stopp${coverage.stops > 1 ? 's' : ''} nötig. ` +
                  'Die App fragt unterwegs automatisch nach.'}
            </p>
          </section>
        )}
      </div>

      <div
        className="border-t border-ink-700/70 px-4 pt-3"
        style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
      >
        {route ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onCalculate}
              disabled={!canCalculate}
              className="touch-target flex-1 rounded-2xl bg-ink-800 px-4 text-sm font-semibold text-ink-200
                         active:bg-ink-700 disabled:opacity-50"
            >
              Neu berechnen
            </button>
            <button
              type="button"
              onClick={props.onStart}
              className="touch-target flex-[1.6] rounded-2xl bg-route-500 px-4 text-base font-bold text-ink-950 active:bg-route-600"
            >
              Navigation starten
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={props.onCalculate}
            disabled={!canCalculate}
            className="touch-target w-full rounded-2xl bg-route-500 px-4 text-base font-bold text-ink-950
                       active:bg-route-600 disabled:bg-ink-700 disabled:text-ink-400"
          >
            {routing ? 'Route wird berechnet …' : 'Route berechnen'}
          </button>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="panel touch-target grid place-items-center rounded-xl text-ink-300 active:text-ink-100"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
        {children}
      </svg>
    </button>
  );
}
