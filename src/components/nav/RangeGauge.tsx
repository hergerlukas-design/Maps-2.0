import { formatKm } from '@/lib/format';

interface RangeGaugeProps {
  remainingRangeKm: number;
  thresholdKm: number;
  /** Km until the next prompt, or `null` when none is pending. */
  kmUntilNextAsk: number | null;
  /** Remaining route distance in metres, to show whether the trip is covered. */
  remainingRouteM: number;
}

/**
 * The range readout.
 *
 * Colour is the fast channel here: green means the trip is covered, amber means
 * a stop is coming, red means the threshold is already crossed. The exact
 * numbers are for when the driver has a moment to look.
 */
export function RangeGauge({
  remainingRangeKm,
  thresholdKm,
  kmUntilNextAsk,
  remainingRouteM,
}: RangeGaugeProps) {
  const remainingRouteKm = remainingRouteM / 1000;
  const coversTrip = remainingRangeKm >= remainingRouteKm;
  const belowThreshold = remainingRangeKm <= thresholdKm;

  const tone = coversTrip
    ? { text: 'text-go-500', ring: 'stroke-go-500', label: 'Ziel in Reichweite' }
    : belowThreshold
      ? { text: 'text-alert-500', ring: 'stroke-alert-500', label: 'Stopp nötig' }
      : { text: 'text-warn-500', ring: 'stroke-warn-500', label: 'Stopp einplanen' };

  // The ring shows range against the threshold, capped at twice it: beyond that
  // the exact ratio stops being interesting.
  const ratio = Math.max(0, Math.min(1, remainingRangeKm / (thresholdKm * 2)));
  const circumference = 2 * Math.PI * 20;

  return (
    <div className="flex items-center gap-3">
      <div className="relative size-14 shrink-0">
        <svg viewBox="0 0 48 48" className="size-full -rotate-90">
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            className="stroke-ink-700"
            strokeWidth="4"
          />
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            className={tone.ring}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <span
          className={`tabular absolute inset-0 flex items-center justify-center text-xs font-bold ${tone.text}`}
        >
          {Math.round(remainingRangeKm)}
        </span>
      </div>

      <div className="min-w-0">
        <p className="text-xs tracking-wide text-ink-400 uppercase">Reichweite</p>
        <p className={`tabular text-lg leading-tight font-semibold ${tone.text}`}>
          {formatKm(remainingRangeKm)}
        </p>
        <p className="truncate text-xs text-ink-400">
          {tone.label}
          {kmUntilNextAsk != null && kmUntilNextAsk > 0 && (
            <span className="tabular"> · nächste Frage in {Math.round(kmUntilNextAsk)} km</span>
          )}
        </p>
      </div>
    </div>
  );
}
