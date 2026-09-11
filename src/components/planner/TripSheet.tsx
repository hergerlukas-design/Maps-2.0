import { useState } from 'react';
import type { ConnectorType, FuelKind, LngLat, VehicleKind } from '@shared/types';
import { CONNECTOR_LABELS, FUEL_KINDS, FUEL_LABELS } from '@shared/types';
import type { PlaceRef, Vehicle } from '@/types/domain';
import { vehicleNeedsCharging, vehicleNeedsFuel } from '@/types/domain';
import { formatDistance, formatDuration } from '@/lib/format';
import { VEHICLE_KIND_LABELS } from '@/state/useAppStore';
import type { NavRoute } from '@/services/mapbox/directions';
import { usePlaceSearch } from '@/hooks/usePlaceSearch';

interface TripSheetProps {
  destination: PlaceRef;
  /** `null` bedeutet: ab dem aktuellen Standort. */
  origin: PlaceRef | null;
  remainingRangeKm: number;
  vehicle: Vehicle;
  vehicles: Vehicle[];
  route: NavRoute | null;
  routing: boolean;
  routeError: string | null;
  proximity: LngLat | null;
  onOriginChange: (place: PlaceRef | null) => void;
  onRangeChange: (km: number) => void;
  onVehicleChange: (id: string) => void;
  onVehiclePatch: (patch: Partial<Vehicle>) => void;
  onCalculate: () => void;
  onStart: () => void;
  onClose: () => void;
}

const CONNECTOR_CHOICES: ConnectorType[] = ['ccs', 'type2', 'chademo', 'tesla_supercharger'];

/**
 * Das untere Sheet, das nach der Zielwahl erscheint.
 *
 * Aufbau wie in gängigen Navigations-Apps: Ziel oben, Aktion unten. Dazwischen
 * liegt das, was diese App ausmacht — die manuell eingegebene Reichweite und das
 * Fahrzeugprofil, aus denen sich ergibt, ob und wann unterwegs nach einem Stopp
 * gefragt wird.
 */
export function TripSheet(props: TripSheetProps) {
  const {
    destination,
    origin,
    remainingRangeKm,
    vehicle,
    vehicles,
    route,
    routing,
    routeError,
    proximity,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [editingOrigin, setEditingOrigin] = useState(false);
  const originSearch = usePlaceSearch(proximity);

  const coverage = route
    ? {
        routeKm: route.distanceM / 1000,
        shortfallKm: Math.max(0, route.distanceM / 1000 - remainingRangeKm),
      }
    : null;

  return (
    <div className="panel flex max-h-[75vh] flex-col rounded-t-[var(--radius-sheet)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Details ausblenden' : 'Details einblenden'}
        className="flex w-full shrink-0 justify-center py-2.5"
      >
        <span className="h-1 w-10 rounded-full bg-ink-500" />
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {/* Ziel ---------------------------------------------------------- */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl leading-tight font-bold">{destination.name}</h2>
            {destination.address && (
              <p className="mt-0.5 truncate text-sm text-ink-400">{destination.address}</p>
            )}
            {route && (
              <p className="tabular mt-1 text-sm text-ink-300">
                {formatDistance(route.distanceM)} · ca. {formatDuration(route.durationS)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Ziel verwerfen"
            className="touch-target -mt-1 -mr-1 grid shrink-0 place-items-center rounded-full text-ink-400 active:text-ink-100"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Startpunkt ---------------------------------------------------- */}
        <div className="mt-3">
          {editingOrigin ? (
            <div className="relative">
              <input
                autoFocus
                type="text"
                placeholder="Startpunkt suchen"
                value={originSearch.query}
                onChange={(event) => originSearch.setQuery(event.target.value)}
                onBlur={() => setTimeout(() => setEditingOrigin(false), 150)}
                className="touch-target w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100"
              />
              {originSearch.results.length > 0 && (
                <ul className="panel absolute inset-x-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-xl py-1">
                  {originSearch.results.map((place) => (
                    <li key={place.id}>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          originSearch.accept(place);
                          props.onOriginChange(place);
                          setEditingOrigin(false);
                        }}
                        className="w-full px-3 py-2 text-left active:bg-ink-800"
                      >
                        <span className="block truncate text-sm text-ink-100">{place.name}</span>
                        {place.address && (
                          <span className="block truncate text-xs text-ink-400">{place.address}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                originSearch.clear();
                setEditingOrigin(true);
              }}
              className="flex w-full items-center gap-2 rounded-xl bg-ink-850/70 px-3 py-2 text-left"
            >
              <span className="size-2 shrink-0 rounded-full bg-go-500" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                {origin?.name ?? 'Mein Standort'}
              </span>
              <span className="shrink-0 text-xs text-ink-500">ändern</span>
            </button>
          )}
          {origin && (
            <button
              type="button"
              onClick={() => props.onOriginChange(null)}
              className="mt-1.5 text-xs text-route-500 underline-offset-2 hover:underline"
            >
              Wieder ab aktuellem Standort
            </button>
          )}
        </div>

        {/* Reichweite ---------------------------------------------------- */}
        <div className="mt-4 rounded-2xl bg-ink-850/70 p-3.5">
          <label
            htmlFor="range-input"
            className="block text-xs font-medium tracking-wide text-ink-300 uppercase"
          >
            Aktuelle Reichweite
          </label>
          <div className="mt-2 flex items-center gap-3">
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
              className="tabular touch-target w-28 rounded-xl border border-ink-700 bg-ink-900 px-3
                         text-lg font-semibold text-ink-100"
            />
            <span className="text-sm text-ink-400">km laut Bordanzeige</span>
          </div>

          {vehicle.typicalRangeKm != null && (
            <button
              type="button"
              onClick={() => props.onRangeChange(vehicle.typicalRangeKm!)}
              className="mt-2 text-xs text-route-500 underline-offset-2 hover:underline"
            >
              Auf volle Reichweite setzen ({vehicle.typicalRangeKm} km)
            </button>
          )}

          {coverage && (
            <p
              className={`mt-2 text-xs leading-snug ${
                coverage.shortfallKm === 0 ? 'text-go-500' : 'text-warn-500'
              }`}
            >
              {coverage.shortfallKm === 0
                ? 'Die Reichweite deckt die gesamte Route ab.'
                : `Es fehlen etwa ${Math.round(coverage.shortfallKm)} km — die App fragt unterwegs nach einem Stopp.`}
            </p>
          )}
        </div>

        {/* Fahrzeug (aufklappbar) ---------------------------------------- */}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 flex w-full items-center justify-between gap-2 py-1 text-left"
        >
          <span className="text-sm text-ink-300">
            {VEHICLE_KIND_LABELS[vehicle.kind]}
            {vehicleNeedsFuel(vehicle.kind) && vehicle.fuel
              ? ` · ${FUEL_LABELS[vehicle.fuel]}`
              : ''}
          </span>
          <span className="flex items-center gap-1 text-xs text-route-500">
            Fahrzeug
            <svg
              viewBox="0 0 24 24"
              className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {expanded && (
          <div className="space-y-3 pb-1">
            {vehicles.length > 1 && (
              <select
                value={vehicle.id}
                onChange={(event) => props.onVehicleChange(event.target.value)}
                aria-label="Fahrzeug wählen"
                className="touch-target w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100"
              >
                {vehicles.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {VEHICLE_KIND_LABELS[entry.kind]}
                  </option>
                ))}
              </select>
            )}

            <div className="grid grid-cols-3 gap-2">
              {(['combustion', 'electric', 'hybrid'] as VehicleKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={vehicle.kind === kind}
                  onClick={() => props.onVehiclePatch({ kind })}
                  className={`touch-target rounded-xl border px-2 text-sm font-medium ${
                    vehicle.kind === kind
                      ? 'border-route-500 bg-route-500/15 text-route-500'
                      : 'border-ink-700 bg-ink-850 text-ink-300'
                  }`}
                >
                  {VEHICLE_KIND_LABELS[kind]}
                </button>
              ))}
            </div>

            {vehicleNeedsFuel(vehicle.kind) && (
              <div className="grid grid-cols-3 gap-2">
                {FUEL_KINDS.map((fuel: FuelKind) => (
                  <button
                    key={fuel}
                    type="button"
                    aria-pressed={vehicle.fuel === fuel}
                    onClick={() => props.onVehiclePatch({ fuel })}
                    className={`touch-target rounded-xl border px-2 text-sm font-medium ${
                      vehicle.fuel === fuel
                        ? 'border-go-500 bg-go-500/15 text-go-500'
                        : 'border-ink-700 bg-ink-850 text-ink-300'
                    }`}
                  >
                    {FUEL_LABELS[fuel]}
                  </button>
                ))}
              </div>
            )}

            {vehicleNeedsCharging(vehicle.kind) && (
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
                      className={`touch-target rounded-xl border px-3 text-sm font-medium ${
                        active
                          ? 'border-charge-500 bg-charge-500/15 text-charge-500'
                          : 'border-ink-700 bg-ink-850 text-ink-300'
                      }`}
                    >
                      {CONNECTOR_LABELS[connector]}
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              <label
                htmlFor="typical-range"
                className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase"
              >
                Volle Reichweite <span className="normal-case">(optional)</span>
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="typical-range"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={2000}
                  step={10}
                  placeholder="—"
                  value={vehicle.typicalRangeKm ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (raw === '') {
                      props.onVehiclePatch({ typicalRangeKm: null });
                      return;
                    }
                    const parsed = Number(raw);
                    props.onVehiclePatch({
                      typicalRangeKm: Number.isFinite(parsed)
                        ? Math.max(0, Math.min(2000, parsed))
                        : null,
                    });
                  }}
                  className="tabular touch-target w-28 rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-ink-100 placeholder:text-ink-500"
                />
                <span className="text-sm text-ink-400">km bei vollem Tank/Akku</span>
              </div>
            </div>
          </div>
        )}

        {routeError && (
          <p className="mt-3 rounded-xl border border-alert-600/50 bg-alert-600/10 px-3 py-2 text-sm text-alert-500">
            {routeError}
          </p>
        )}
      </div>

      {/* Aktion ---------------------------------------------------------- */}
      <div
        className="shrink-0 border-t border-ink-700/70 px-4 pt-3"
        style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
      >
        <button
          type="button"
          onClick={route ? props.onStart : props.onCalculate}
          disabled={routing}
          className="touch-target flex w-full items-center justify-center gap-2 rounded-2xl bg-route-500 px-4
                     text-base font-bold text-ink-950 active:bg-route-600 disabled:bg-ink-700 disabled:text-ink-400"
        >
          {routing ? (
            'Route wird berechnet …'
          ) : route ? (
            <>
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 3 5 20l7-4 7 4-7-17Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Starten
            </>
          ) : (
            'Route berechnen'
          )}
        </button>
      </div>
    </div>
  );
}
