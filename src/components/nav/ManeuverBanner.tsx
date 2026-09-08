import { formatDistance } from '@/lib/format';
import type { ManeuverView } from '@/navigation/engine';
import { describeManeuver, ManeuverIcon } from './ManeuverIcon';

interface ManeuverBannerProps {
  maneuver: ManeuverView | null;
  isOffRoute: boolean;
  rerouting: boolean;
}

const LANE_ARROWS: Record<string, string> = {
  left: '↰',
  'sharp left': '↰',
  'slight left': '↖',
  right: '↱',
  'sharp right': '↱',
  'slight right': '↗',
  straight: '↑',
  uturn: '↩',
  none: '↑',
};

/**
 * The banner at the top of the screen: what to do next, and how far away it is.
 *
 * The distance is the largest element on screen because it is the one number a
 * driver reads at a glance while their attention is on the road.
 */
export function ManeuverBanner({ maneuver, isOffRoute, rerouting }: ManeuverBannerProps) {
  if (rerouting) {
    return (
      <Shell>
        <div className="flex items-center gap-3">
          <span className="size-5 animate-spin rounded-full border-2 border-route-500 border-t-transparent" />
          <p className="text-lg font-semibold">Route wird neu berechnet …</p>
        </div>
      </Shell>
    );
  }

  if (isOffRoute) {
    return (
      <Shell tone="warn">
        <p className="text-lg font-semibold text-warn-500">Nicht auf der Route</p>
        <p className="text-sm text-ink-300">
          Bitte zur Route zurückkehren — sie wird gleich neu berechnet.
        </p>
      </Shell>
    );
  }

  if (!maneuver) {
    return (
      <Shell>
        <p className="text-lg font-semibold">Navigation bereit</p>
      </Shell>
    );
  }

  const { step, distanceToManeuverM, primaryText, secondaryText, next, lanes } = maneuver;
  const activeLanes = lanes?.filter((lane) => lane.valid) ?? [];

  return (
    <Shell>
      <div className="flex items-start gap-4">
        <ManeuverIcon
          type={step.maneuver.type}
          modifier={step.maneuver.modifier}
          className="mt-0.5 size-11 shrink-0 text-route-500"
        />
        <div className="min-w-0 flex-1">
          <p className="tabular text-3xl leading-none font-bold">
            {formatDistance(distanceToManeuverM)}
          </p>
          <p className="mt-1 truncate text-lg leading-snug font-semibold text-ink-100">
            {primaryText}
          </p>
          {secondaryText && (
            <p className="truncate text-sm text-ink-300">{secondaryText}</p>
          )}
        </div>
      </div>

      {activeLanes.length > 0 && (
        <div
          className="mt-3 flex items-center justify-center gap-1 border-t border-ink-700/70 pt-2"
          aria-label="Spurempfehlung"
        >
          {activeLanes.map((lane, index) => (
            <span
              key={index}
              className={
                lane.active
                  ? 'text-2xl leading-none text-route-500'
                  : 'text-2xl leading-none text-ink-600'
              }
            >
              {LANE_ARROWS[lane.indications[0] ?? 'none'] ?? '↑'}
            </span>
          ))}
        </div>
      )}

      {next && (
        <div className="mt-2 flex items-center gap-2 border-t border-ink-700/70 pt-2 text-sm text-ink-300">
          <span className="text-ink-400">danach</span>
          <ManeuverIcon
            type={next.maneuver.type}
            modifier={next.maneuver.modifier}
            className="size-5 shrink-0 text-ink-300"
          />
          <span className="truncate">
            {next.banners[0]?.primary.text ??
              describeManeuver(next.maneuver.type, next.maneuver.modifier)}
          </span>
        </div>
      )}
    </Shell>
  );
}

function Shell({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'warn';
}) {
  return (
    <div
      className={`panel rounded-3xl px-4 py-3 ${
        tone === 'warn' ? 'border-warn-600/60' : ''
      }`}
      style={{ boxShadow: 'var(--shadow-banner)' }}
      aria-live="polite"
    >
      {children}
    </div>
  );
}
