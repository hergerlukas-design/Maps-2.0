import type { StopKind } from '@shared/types';
import type { StopWaypoint } from '@/types/domain';
import { formatDistance, formatDuration, formatEta } from '@/lib/format';
import type { NavState } from '@/navigation/engine';
import { RangeGauge } from './RangeGauge';
import { QuickButtons } from './QuickButtons';

interface NavBottomBarProps {
  nav: NavState;
  waypoints: StopWaypoint[];
  remainingRangeKm: number;
  thresholdKm: number;
  kmUntilNextAsk: number | null;
  showFuel: boolean;
  showCharging: boolean;
  searchBusy: boolean;
  onQuickSearch: (kind: StopKind) => void;
  onEnd: () => void;
  onOpenSettings: () => void;
}

/**
 * The bottom bar during navigation: arrival, range, quick searches.
 *
 * ETA sits first because it is what a passenger asks about; the range gauge sits
 * next to it because the two together are the whole "will we make it?" question.
 */
export function NavBottomBar({
  nav,
  waypoints,
  remainingRangeKm,
  thresholdKm,
  kmUntilNextAsk,
  showFuel,
  showCharging,
  searchBusy,
  onQuickSearch,
  onEnd,
  onOpenSettings,
}: NavBottomBarProps) {
  const nextStop = waypoints.find(
    (waypoint) => waypoint.reachedAt == null && waypoint.kind !== 'destination',
  );

  return (
    <div
      className="panel rounded-t-[var(--radius-sheet)] px-4 pt-3"
      style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
    >
      {nextStop && (
        <div className="mb-2.5 flex items-center gap-2 rounded-xl bg-ink-800/70 px-3 py-2">
          <span className="size-2 shrink-0 rounded-full bg-route-500" />
          <p className="min-w-0 flex-1 truncate text-xs text-ink-200">
            Zwischenstopp: <span className="font-semibold">{nextStop.name}</span>
          </p>
          <span className="tabular shrink-0 text-xs text-ink-400">
            {formatDistance(nav.distanceToLegEndM)}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-wide text-ink-400 uppercase">Ankunft</p>
          <p className="tabular text-2xl leading-none font-bold text-ink-100">
            {formatEta(nav.remainingDurationS)}
          </p>
          <p className="tabular mt-0.5 text-xs text-ink-400">
            {formatDuration(nav.remainingDurationS)} · {formatDistance(nav.remainingDistanceM)}
          </p>
        </div>

        <RangeGauge
          remainingRangeKm={remainingRangeKm}
          thresholdKm={thresholdKm}
          kmUntilNextAsk={kmUntilNextAsk}
          remainingRouteM={nav.remainingDistanceM}
        />
      </div>

      <div className="mt-3">
        <QuickButtons
          onSelect={onQuickSearch}
          busy={searchBusy}
          showFuel={showFuel}
          showCharging={showCharging}
        />
      </div>

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="touch-target flex-1 rounded-xl bg-ink-800 px-3 text-sm font-medium text-ink-200 active:bg-ink-700"
        >
          Einstellungen
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="touch-target flex-1 rounded-xl bg-alert-600/25 px-3 text-sm font-semibold text-alert-500 active:bg-alert-600/40"
        >
          Navigation beenden
        </button>
      </div>
    </div>
  );
}
