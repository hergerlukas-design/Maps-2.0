import type { FuelKind, RankedStop } from '@shared/types';
import { CONNECTOR_LABELS, FUEL_LABELS } from '@shared/types';
import { formatDistance, formatPower, formatPrice } from '@/lib/format';
import { isReachable } from '@/navigation/rangeMonitor';

interface StopCardProps {
  ranked: RankedStop;
  /** Preferred grade, so the right price is the prominent one. */
  fuel: FuelKind;
  /** Range left, to mark stops the tank can no longer reach. */
  remainingRangeKm: number;
  /** True for the top-ranked entry. */
  isBest: boolean;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}

/**
 * One suggestion in the picker.
 *
 * The layout puts the deciding number — price per litre, or charging power —
 * in the same place for every kind of stop, so the list can be scanned in one
 * downward glance rather than read entry by entry.
 */
export function StopCard({
  ranked,
  fuel,
  remainingRangeKm,
  isBest,
  selected,
  onSelect,
  onHover,
}: StopCardProps) {
  const { stop, relation, scoreNote } = ranked;
  const reachable = isReachable(remainingRangeKm, relation.distanceAheadM + relation.detourM);

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onHover}
      onFocus={onHover}
      aria-current={selected}
      className={`w-full rounded-2xl border px-3.5 py-3 text-left transition-colors ${
        selected
          ? 'border-route-500 bg-ink-800'
          : 'border-ink-700/70 bg-ink-850/80 active:bg-ink-800'
      } ${reachable ? '' : 'opacity-60'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold text-ink-100">{stop.name}</p>
            {isBest && (
              <span className="shrink-0 rounded-full bg-go-600/25 px-2 py-0.5 text-[0.65rem] font-semibold text-go-500">
                Beste Wahl
              </span>
            )}
          </div>

          <p className="mt-0.5 truncate text-xs text-ink-400">
            {[stop.brand, stop.address?.city].filter(Boolean).join(' · ') || 'Adresse unbekannt'}
          </p>

          <div className="tabular mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-300">
            <span>{formatDistance(relation.distanceAheadM)} voraus</span>
            <span className="text-ink-500">·</span>
            <span>
              {relation.offsetFromRouteM < 150
                ? 'direkt an der Route'
                : `${formatDistance(relation.detourM)} Umweg`}
            </span>
            {stop.isOpen === false && (
              <>
                <span className="text-ink-500">·</span>
                <span className="text-alert-500">geschlossen</span>
              </>
            )}
          </div>

          {!reachable && (
            <p className="mt-1.5 text-xs text-alert-500">
              Mit der aktuellen Reichweite knapp — inklusive Reserve nicht sicher erreichbar.
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">{renderHeadline(ranked, fuel)}</div>
      </div>

      {stop.kind === 'charging' && stop.connectors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {stop.connectors.slice(0, 4).map((connector, index) => (
            <span
              key={`${connector.type}-${index}`}
              className="tabular rounded-md bg-ink-800 px-1.5 py-0.5 text-[0.65rem] text-ink-300"
            >
              {CONNECTOR_LABELS[connector.type]}
              {connector.powerKw ? ` ${Math.round(connector.powerKw)} kW` : ''}
              {connector.count > 1 ? ` ×${connector.count}` : ''}
            </span>
          ))}
        </div>
      )}

      {stop.kind === 'fuel' && (
        <div className="tabular mt-2 flex gap-3 text-[0.7rem] text-ink-400">
          {(['e5', 'e10', 'diesel'] as FuelKind[])
            .filter((grade) => grade !== fuel && stop.prices[grade] != null)
            .map((grade) => (
              <span key={grade}>
                {FUEL_LABELS[grade]} {formatPrice(stop.prices[grade])}
              </span>
            ))}
        </div>
      )}

      {scoreNote && stop.kind === 'fuel' && (
        <p className="tabular mt-1 text-[0.7rem] text-ink-500">{scoreNote}</p>
      )}
    </button>
  );
}

function renderHeadline(ranked: RankedStop, fuel: FuelKind) {
  const { stop } = ranked;

  if (stop.kind === 'fuel') {
    const price = stop.prices[fuel];
    return (
      <>
        <p className="tabular text-xl leading-none font-bold text-go-500">
          {price != null ? formatPrice(price) : '–'}
        </p>
        <p className="mt-0.5 text-[0.65rem] text-ink-400">{FUEL_LABELS[fuel]} / l</p>
      </>
    );
  }

  if (stop.kind === 'charging') {
    return (
      <>
        <p className="tabular text-xl leading-none font-bold text-charge-500">
          {formatPower(stop.maxPowerKw)}
        </p>
        <p className="mt-0.5 text-[0.65rem] text-ink-400">max. Leistung</p>
      </>
    );
  }

  return (
    <>
      <p className="text-sm leading-none font-semibold text-warn-500">
        {stop.fee === true ? 'gebührenpflichtig' : stop.fee === false ? 'kostenlos' : '—'}
      </p>
      {stop.wheelchair === true && (
        <p className="mt-0.5 text-[0.65rem] text-ink-400">barrierefrei</p>
      )}
    </>
  );
}
